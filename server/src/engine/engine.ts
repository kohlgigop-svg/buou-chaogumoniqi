// engine/engine.ts —— 引擎心脏：tick 主循环、相位分发、快照持久化、确定性补跑。
// 每个 advanceOne 的全部写库（含 engine_state 更新）在同一个事务内（内层事务降级为 savepoint）。
// 快照 state_json = { regime, rng: pricing 流活状态, drift }；重启后从行内种子/genesis + state_json 恢复。
import type Database from 'better-sqlite3';
import type { DB } from '../db/database.js';
import { Rng } from '../core/rng.js';
import type { Config } from '../config/defaults.js';
import { GameClock, TICKS_PER_DAY, phaseOfTick, type Phase } from '../core/clock.js';
import { NoopMatcher, NOOP_FLOW, type EngineDeps, type OrderMatcher, type SettlementHook,
  type FlowProvider, type StockQuote, type TickCtx } from './types.js';
import type { RegimeState } from './regime.js';
import { priceTick } from './pricing.js';
import { openDay } from './candles.js';
import { generateDayEvents, serializeDrift, restoreDrift, type DriftItem } from './events.js';
import { seedStocks } from '../seed/stocks.js';
import { runSettlement } from './settlement.js';
import { backupDaily } from './backup.js';

type Stmt = Database.Statement;
interface StateJson { regime: RegimeState; rng: string; drift: string }
interface QuoteRow { code: string; price: number; pc: number; up: number; dn: number; volume: number; status: string }

export class Engine {
  private readonly db: DB;
  private readonly cfg: Config;
  private readonly matcher: OrderMatcher;
  private readonly hooks: SettlementHook[];
  private readonly flow: FlowProvider;
  private readonly dataDir: string | undefined;
  private readonly onTickError: (() => void) | undefined;
  private readonly masterSeed: number;
  /**
   * 创世毫秒（恢复时以 `engine_state.genesis_ms` 为准，构造参数仅用于首次创世）。
   *
   * **公开只读是有意的**：WS 层要把它盖进 `tick` 帧，客户端才能用**与服务端同一个口径**
   * 算「行情延迟」（`(now − genesis − 已完成tick数 × 3000) / 1000`）。
   * 客户端拿不到 genesis 时只能退回一个默认值，算出来的是 Unix 时间戳而非延迟
   * —— 线上曾因此把角标恒亮成「延迟 1789362002s」（详见 web/src/lib/useLag.ts 注释）。
   * 从 Engine 取而不是让 WS 自己查表，是为了让「genesis 存在哪」只有一处知识。
   */
  readonly genesisMs: number;
  /** 实时循环周期：生产 1000ms 足够（tick 本身 3s）；测试注入小值以便快速推进。 */
  private readonly tickMs: number;
  private readonly clock: GameClock;
  private lastTick!: number;
  private regime!: RegimeState;
  private rngPricing!: Rng;
  private drift!: Map<string, DriftItem[]>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private advanceTx: ((t: number, suppress: boolean) => void) | null = null;
  private pendingBackupDay: number | null = null; // 事务内只记录，提交后再 VACUUM
  private readonly tickCbs = new Set<(ctx: TickCtx) => void>();
  private lastCtx: TickCtx | null = null; // 本 tick 的惰性 ctx，供 live 模式 onTick 回调

  constructor(deps: EngineDeps) {
    this.db = deps.db;
    this.cfg = deps.cfg;
    // 预编译语句按 SQL 记忆化（惰性，性能关键：priceTick 等热路径每 tick 反复 prepare）。
    // 只包装本 db 连接的 prepare；语句复用对 run/get/all 幂等安全。
    if (!(this.db as { __stmtCache?: boolean }).__stmtCache) {
      const raw = this.db.prepare.bind(this.db);
      const cache = new Map<string, Stmt>();
      this.db.prepare = ((sql: string): Stmt => {
        let s = cache.get(sql);
        if (s === undefined) { s = raw(sql); cache.set(sql, s); }
        return s;
      }) as DB['prepare'];
      (this.db as { __stmtCache?: boolean }).__stmtCache = true;
    }
    this.matcher = deps.matcher ?? new NoopMatcher();
    this.hooks = deps.settlementHooks ?? [];
    this.flow = deps.flow ?? NOOP_FLOW;
    this.dataDir = deps.dataDir;
    this.onTickError = deps.onTickError;
    this.tickMs = deps.tickMs ?? 1000;
    const row = this.db.prepare(
      'SELECT master_seed ms, genesis_ms gm, last_tick lt, state_json sj FROM engine_state WHERE id = 1',
    ).get() as { ms: number; gm: number; lt: number; sj: string } | undefined;
    if (row === undefined) {
      // 创世：写 engine_state + 种子股票 + 首日事件（第 1 日 pricing 流即刻创建）
      this.masterSeed = deps.masterSeed;
      this.genesisMs = deps.genesisMs;
      this.lastTick = -1;
      this.regime = { regime: 1, sectorS: {} };
      this.rngPricing = Rng.fromSeed(this.masterSeed, 1, 'pricing');
      this.drift = new Map();
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO engine_state(id, master_seed, genesis_ms, last_tick, state_json) VALUES (1,?,?,?,?)')
          .run(this.masterSeed, this.genesisMs, -1, this.serializeState());
        seedStocks(this.db, 1);
        generateDayEvents(this.db, 1, Rng.fromSeed(this.masterSeed, 1, 'events'), this.cfg);
      })();
    } else {
      // 恢复：行内 seed/genesis 优先于构造参数；活状态一律取自 state_json（绝不重新 fromSeed）
      this.masterSeed = row.ms;
      this.genesisMs = row.gm;
      this.restoreFromRow();
    }
    this.clock = new GameClock(this.genesisMs);
  }

  /** 补跑到 nowMs 对应的全局 tick；补跑期间除最后一日内的结算外抑制备份。返回推进 tick 数。 */
  catchUpTo(nowMs: number): number {
    return this.advanceTo(this.clock.globalTick(nowMs), false);
  }

  /** 实时模式：按 tickMs 周期补跑到当前时刻，并对启动后推进的 tick 触发 onTick 回调。
   *  @param now 取当前墙钟毫秒；测试可注入假时钟 + 小周期，实现确定性推进。 */
  start(now: () => number = Date.now): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => { this.advanceTo(this.clock.globalTick(now()), true); }, this.tickMs);
  }

  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  onTick(cb: (ctx: TickCtx) => void): () => void {
    this.tickCbs.add(cb);
    return () => { this.tickCbs.delete(cb); };
  }

  getQuote(code: string): StockQuote | undefined {
    const r = this.stmt(`SELECT s.code, t.price, t.prev_close pc, t.limit_up up, t.limit_down dn,
      t.volume, s.status FROM stocks s JOIN stock_state t ON t.code = s.code WHERE s.code = ?`)
      .get(code) as QuoteRow | undefined;
    return r === undefined ? undefined : toQuote(r);
  }

  // ---------- 内部 ----------

  private advanceTo(target: number, live: boolean): number {
    let n = 0;
    while (this.lastTick < target) {
      const t = this.lastTick + 1;
      const suppressBackup = t <= target - TICKS_PER_DAY; // 仅最后一日内的结算做备份
      this.advanceOne(t, suppressBackup);
      n++;
      if (live && this.lastCtx !== null) for (const cb of this.tickCbs) cb(this.lastCtx);
    }
    return n;
  }

  /** 推进一个全局 tick：相位分发 + engine_state 快照，全部在同一事务（缓存的事务包装）。 */
  private advanceOne(t: number, suppressBackup: boolean): void {
    if (this.advanceTx === null) {
      this.advanceTx = this.db.transaction((tick: number, suppress: boolean) => this.tickBody(tick, suppress));
    }
    try {
      this.advanceTx(t, suppressBackup);
    } catch (e) {
      // 事务已回滚：内存态（regime/rngPricing/drift/lastTick）可能被本轮写脏，从行内快照重建。
      this.restoreFromRow();
      this.onTickError?.();
      throw e;
    }
    this.lastTick = t;
    // 备份必须在事务提交之后执行：VACUUM INTO 不能在事务内运行（会抛
    // "cannot VACUUM from within a transaction"）。结算路径（tickBody 内）只通过
    // this.backup(day) 记录 pendingBackupDay，这里在提交后统一落盘。
    if (this.pendingBackupDay !== null) {
      const day = this.pendingBackupDay;
      this.pendingBackupDay = null;
      try {
        backupDaily(this.db, this.dataDir!, day, this.cfg.backupKeep);
      } catch (e) {
        // 备份是尽力而为：失败绝不能影响已提交的结算，只记录错误继续。
        console.error('[backup]', e);
      }
    }
  }

  private tickBody(t: number, suppressBackup: boolean): void {
    const day = this.clock.dayOfTick(t);
    const tid = this.clock.tickInDay(t);
    const phase = phaseOfTick(tid);
    if (tid === 0) {
      openDay(this.db, day, this.cfg);
      this.lastCtx = this.buildCtx(day, tid, t, phase, true);
    } else if (tid === 59 || (tid >= 60 && tid < 1160) || tid === 1179) {
      // 集合竞价末 tick（开盘价=本 tick 模型价）与连续竞价：都走 priceTick
      priceTick(this.db, { day, tickInDay: tid, regime: this.regime, rng: this.rngPricing,
        drift: this.drift, flow: this.flow, cfg: this.cfg });
      const ctx = this.buildCtx(day, tid, t, phase, true);
      if (tid === 59) this.matcher.onAuctionClear(ctx, 'open');
      else if (tid === 1179) this.matcher.onAuctionClear(ctx, 'close');
      else this.matcher.onContinuousTick(ctx);
      this.lastCtx = ctx;
    } else if (tid === 1180) {
      const ctx = this.buildCtx(day, tid, t, phase, false);
      const res = runSettlement(this.db, ctx, this.hooks, this.drift, {
        masterSeed: this.masterSeed,
        matcher: this.matcher,
        regime: this.regime,
        backup: (d: number): void => {
          if (this.dataDir !== undefined && !suppressBackup) this.backup(d);
        },
      });
      this.regime = res.regime;
      this.rngPricing = res.rngPricing;
      this.lastCtx = ctx;
    } else {
      // 其余 tick（1..58、1160..1178、1181..1199）no-op：仍构造同款惰性 ctx 供 onTick
      this.lastCtx = this.buildCtx(day, tid, t, phase, true);
    }
    this.stmt('UPDATE engine_state SET last_tick = ?, state_json = ? WHERE id = 1')
      .run(t, this.serializeState());
  }

  // quotes 惰性构建：NoopMatcher 不读取行情，热路径上省掉每 tick 的全市场行映射；
  // 首次访问时按「定价后状态」SELECT，语义仍是"pricing 之后的全量行情快照"。
  private buildCtx(day: number, tickInDay: number, globalTick: number, phase: Phase, listedOnly: boolean): TickCtx {
    const ctx = { day, tickInDay, globalTick, phase, db: this.db, rng: this.rngPricing,
      cfg: this.cfg } as TickCtx;
    let quotes: Map<string, StockQuote> | undefined;
    Object.defineProperty(ctx, 'quotes', {
      enumerable: true,
      get: (): Map<string, StockQuote> => {
        if (quotes === undefined) quotes = this.loadQuotes(day, listedOnly);
        return quotes;
      },
    });
    return ctx;
  }

  private loadQuotes(day: number, listedOnly: boolean): Map<string, StockQuote> {
    const rows = (listedOnly
      ? this.stmt(`SELECT s.code, t.price, t.prev_close pc, t.limit_up up, t.limit_down dn, t.volume, s.status
          FROM stocks s JOIN stock_state t ON t.code = s.code
          WHERE s.status != 'delisted' AND s.listed_day <= ? ORDER BY s.code`).all(day)
      : this.stmt(`SELECT s.code, t.price, t.prev_close pc, t.limit_up up, t.limit_down dn, t.volume, s.status
          FROM stocks s JOIN stock_state t ON t.code = s.code
          WHERE s.status != 'delisted' ORDER BY s.code`).all()) as QuoteRow[];
    const quotes = new Map<string, StockQuote>();
    for (const r of rows) quotes.set(r.code, toQuote(r));
    return quotes;
  }

  /** 从 engine_state 行恢复内存态（构造复用 + 事务异常回滚后重建；seed/genesis 不变）。 */
  private restoreFromRow(): void {
    const row = this.db.prepare(
      'SELECT last_tick lt, state_json sj FROM engine_state WHERE id = 1',
    ).get() as { lt: number; sj: string } | undefined;
    if (row === undefined) throw new Error('engine_state missing on restore');
    this.lastTick = row.lt;
    const s = JSON.parse(row.sj) as StateJson;
    this.regime = s.regime;
    this.rngPricing = Rng.restore(s.rng);
    this.drift = restoreDrift(s.drift);
  }

  private serializeState(): string {
    return JSON.stringify({ regime: this.regime, rng: this.rngPricing.serialize(),
      drift: serializeDrift(this.drift) });
  }

  private stmt(sql: string): Stmt {
    return this.db.prepare(sql); // 构造时已包装为记忆化 prepare
  }

  /** 每日备份（结算路径调用，此时仍在 advanceOne 的事务内）。
   *  VACUUM INTO 不能在事务内执行，故这里只登记待备份日；
   *  真正的 backupDaily 由 advanceOne 在事务提交后执行。 */
  private backup(day: number): void { this.pendingBackupDay = day; }
}

function toQuote(r: QuoteRow): StockQuote {
  return { code: r.code, price: r.price, prevClose: r.pc, limitUp: r.up, limitDown: r.dn,
    volume: r.volume, status: r.status };
}
