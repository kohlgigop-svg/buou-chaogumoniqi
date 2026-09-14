// trading/matcher.ts —— 连续竞价、钉板队列、集合竞价与日终委托清理。
// 在引擎 tick 事务内被调用：只直接执行语句，绝不自开事务（post() 内部事务降级为 savepoint）。
// 撮合独立 RNG 流 fromSeed(masterSeed, day, 'matching')，状态存 config['matcher_rng']；
// 本 tick 净流（买+/卖−，单位股）存 config['matcher_flow']，供下一 tick 定价 netFlow() 读取。
// 仅连续竞价钉板抽签消费 matching 流；竞价统一价清算不消耗 RNG。
import type { DB } from '../db/database.js';
import { ACC } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { OrderMatcher, FlowProvider, TickCtx } from '../engine/types.js';
import { Rng } from '../core/rng.js';
import { commission, stampTax, transferFee, roundHalfUpDiv } from '../core/money.js';
import { post, type Leg } from '../core/ledger.js';
import { releaseOrderRemainder, type OrderRow } from './orders.js';

export interface FillEvent { userId: number; orderId: number; code: string; side: 'B'|'S';
  price: number; qty: number; commission: number; stamp: number; transfer: number;
  day: number; tick: number; orderStatus: 'open'|'done'; }

interface MatcherState { day: number; rng: Rng; flow: Record<string, number> }

export class PlayerMatcher implements OrderMatcher, FlowProvider {
  private readonly db: DB;
  private readonly cfg: Config;
  private readonly masterSeed: number;
  private mem: MatcherState | null = null; // 惰性加载的撮合状态（config 为真源）
  private readonly fillCbs = new Set<(f: FillEvent) => void>();

  constructor(deps: { db: DB; cfg: Config; masterSeed: number }) {
    this.db = deps.db;
    this.cfg = deps.cfg;
    this.masterSeed = deps.masterSeed;
  }

  onContinuousTick(ctx: TickCtx): void {
    // 1. 快速出口：无可撮合 open 单（created_tick ≤ globalTick，未来单跳过 → 补跑安全）
    const has = (this.db.prepare(
      `SELECT EXISTS(SELECT 1 FROM orders WHERE status='open' AND created_tick <= ?) e`,
    ).get(ctx.globalTick) as { e: number }).e === 1;
    if (!has) {
      // 冷启动也可能留有上一 tick 净流；按同样的日切规则恢复并清零，不能跳过。
      if (this.mem === null) {
        const saved = this.db.prepare(`SELECT value FROM config WHERE key='matcher_rng'`).get();
        if (saved === undefined) return; // 从未有撮合状态的空库保持零写入
        this.loadState(ctx.day);
        this.mem!.flow = {};
        this.persist();
        return;
      }
      if (this.mem.day !== ctx.day) {
        this.mem = this.freshState(ctx.day);
        this.persist();
      } else if (Object.keys(this.mem.flow).length > 0) {
        this.mem.flow = {}; // 上一 tick 有成交、本 tick 无单 → 流水衰减为零
        this.upsertConfig('matcher_flow', '{}');
      }
      return;
    }

    // 2. 状态：惰性加载 config['matcher_rng']/['matcher_flow']；日切换重建流
    this.loadState(ctx.day);
    const mem = this.mem!;

    // 3. 可撮合单：code 升序；同 code 市价先（created_tick,id），限价买价高优先/卖价低优先。
    //    钉板侧（p==limitUp 买 / p==limitDown 卖）不逐单成交，改按 (created_tick,id) 成队，
    //    每 tick 仅考虑队首并抽签分批（5b）；反向侧照常。
    const orders = this.db.prepare(
      `SELECT * FROM orders WHERE status='open' AND created_tick <= ?
       ORDER BY code ASC,
         CASE WHEN type='M' THEN 0 ELSE 1 END,
         CASE WHEN type='M' THEN 0 WHEN side='B' THEN -price ELSE price END,
         created_tick ASC, id ASC`,
    ).all(ctx.globalTick) as OrderRow[];
    const byCode = new Map<string, OrderRow[]>();
    for (const o of orders) {
      const arr = byCode.get(o.code);
      if (arr === undefined) byCode.set(o.code, [o]); else arr.push(o);
    }
    const tickFlow: Record<string, number> = {};
    for (const [code, os] of byCode) {
      const q = ctx.quotes.get(code);
      if (q === undefined) continue;
      const p = q.price;
      const buyPinned = p === q.limitUp;
      const sellPinned = p === q.limitDown;
      let headBuy: OrderRow | undefined;
      let headSell: OrderRow | undefined;
      let adv = 1; let advLoaded = false;
      for (const o of os) {
        const cross = this.crosses(o, p);
        if (buyPinned && o.side === 'B' && cross) {
          if (headBuy === undefined || this.earlier(o, headBuy)) headBuy = o;
          continue;
        }
        if (sellPinned && o.side === 'S' && cross) {
          if (headSell === undefined || this.earlier(o, headSell)) headSell = o;
          continue;
        }
        let pExec: number;
        if (o.type === 'M') {
          if (!advLoaded) {
            adv = (this.db.prepare('SELECT adv FROM stock_state WHERE code=?').get(code) as { adv: number }).adv;
            advLoaded = true;
          }
          const slip = this.cfg.trading.slippageK * Math.sqrt(o.qty / Math.max(1, adv));
          pExec = o.side === 'B'
            ? Math.min(Math.round(p * (1 + slip)), q.limitUp)
            : Math.max(Math.round(p * (1 - slip)), q.limitDown);
          pExec = Math.max(1, pExec);
        } else {
          // 限价：买 order.price ≥ p 成交、卖 order.price ≤ p 成交；成交价=现价
          if (!cross) continue;
          pExec = p;
        }
        this.fill(ctx, o, pExec, tickFlow);
      }
      // 钉板队首：每 tick 只考虑队首，抽签恰好一次
      if (headBuy !== undefined) this.boardFill(ctx, headBuy, p, tickFlow);
      if (headSell !== undefined) this.boardFill(ctx, headSell, p, tickFlow);
    }

    // 5. 本 tick 净流入库（无成交则 {} → 下一 tick netFlow 衰减为零）；RNG 状态随同持久化
    mem.flow = tickFlow;
    this.persist();
  }

  /**
   * 引擎先定出开/收盘价，合资格限价委托按时间优先以该统一价清算。
   *
   * 规格 §4.4：「以『模型参考价 + 玩家净需求失衡调整』产生单一成交价」。
   * 引擎给出的 `q.price` 即模型参考价（本 tick 的定价结果）；本函数再叠加
   * **当轮挂单净需求**的调整量。注意与 `priceTick` 里的 `playerImpactLambda` 区分：
   * 那个读的是 `netFlow`（**上一 tick 已成交流水**），竞价当轮挂单在本 tick 尚未成交，
   * 因此必须在这里单独统计。两者互补，不重复计算。
   *
   * 调整量 = clamp(K × 净需求股数/adv, ±cap)，再按参考价换算到分；不消耗 RNG（可重放）。
   */
  onAuctionClear(ctx: TickCtx, _kind: 'open' | 'close'): void {
    this.loadState(ctx.day);
    const tickFlow: Record<string, number> = {};
    const orders = this.db.prepare(
      `SELECT * FROM orders WHERE status='open' AND type='L' AND created_tick <= ?
       ORDER BY code ASC, created_tick ASC, id ASC`,
    ).all(ctx.globalTick) as OrderRow[];

    // 先按 code 汇总当轮净需求（买 +、卖 −，单位股），再定该 code 的统一价。
    const netDemand = new Map<string, number>();
    for (const o of orders) {
      const q = ctx.quotes.get(o.code);
      if (q === undefined || q.status === 'delisted' || !this.crosses(o, q.price)) continue;
      const sign = o.side === 'B' ? 1 : -1;
      netDemand.set(o.code, (netDemand.get(o.code) ?? 0) + sign * (o.qty - o.filled));
    }
    const auctionPrice = new Map<string, number>();
    for (const [code, net] of netDemand) {
      const q = ctx.quotes.get(code)!;
      auctionPrice.set(code, this.auctionClearPrice(ctx, code, q.price, net, q.limitUp, q.limitDown));
    }

    for (const o of orders) {
      const q = ctx.quotes.get(o.code);
      if (q === undefined || q.status === 'delisted' || !this.crosses(o, q.price)) continue;
      // NPC 提供统一价对手方；不加市价滑点、不沿用连续竞价的钉板抽签。
      // fill 复用逐笔费用/剩余冻结封顶和 T+1 清算，不重复冻结已部分成交的单。
      this.fill(ctx, o, auctionPrice.get(o.code) ?? q.price, tickFlow);
    }
    this.mem!.flow = tickFlow;
    this.persist();
  }

  /**
   * 统一价 = 参考价 × exp(clamp(K × 净需求/单tick均量, ±cap))，取整到分并夹在涨跌停内。
   * 净需求为 0 ⇒ 原样返回参考价（保证「无失衡则不动价」这一显式语义）。
   *
   * ⚠️ 分母用 **`adv / 1100`**（单 tick 典型成交量），不是 `adv` 本身。
   * `adv` 是**日**均量（量级 1e8），而集合竞价是一天里的一次性集中撮合；
   * 若直接用 `adv` 作分母，`K × net/adv` 恒在 1e-7 量级，调价四舍五入后**永远是 0**
   * —— 功能表面实现、实际完全无效（这正是第一版的现象）。
   * `adv / 1100` 与 `priceTick` 的 `playerImpactLambda`、单 tick 成交量口径一致
   * （见 `engine/pricing.ts`：`vol = adv/1100 × …`、`rPlayer = λ × netFlow/adv`…
   * 后者分母用 adv 是因为它描述的是**当日累计净流**，而这里是**单轮竞价净需求**）。
   */
  private auctionClearPrice(ctx: TickCtx, code: string, ref: number, net: number,
      limitUp: number, limitDown: number): number {
    if (net === 0) return ref;
    const adv = Math.max(1, (this.db.prepare('SELECT adv FROM stock_state WHERE code=?')
      .get(code) as { adv: number }).adv);
    const perTickVol = Math.max(1, adv / 1100);
    const raw = this.cfg.trading.auctionImpactK * (net / perTickVol);
    const cap = this.cfg.trading.auctionImpactCap;
    const adj = Math.max(-cap, Math.min(cap, raw));
    const p = Math.round(ref * Math.exp(adj));
    return Math.max(1, Math.min(limitUp, Math.max(limitDown, p)));
  }

  /** 结算第一步：先清委托再解锁持仓；资金仍只通过只追加的复式账本变更。 */
  onDayEnd(ctx: TickCtx): void {
    const orders = this.db.prepare(
      `SELECT * FROM orders WHERE status='open' ORDER BY id ASC`,
    ).all() as OrderRow[];
    for (const o of orders) {
      releaseOrderRemainder(this.db, o, ctx.day, ctx.tickInDay);
      this.db.prepare(`UPDATE orders SET status='expired' WHERE id=?`).run(o.id);
    }
    this.db.prepare(`UPDATE holdings SET qty_sellable=qty_total
      WHERE qty_total > 0 AND qty_sellable != qty_total`).run();
    // 收盘成交的瞬时净流不应延续到次日开盘；matching RNG 保留至下一交易日重建。
    this.loadState(ctx.day);
    this.mem!.flow = {};
    this.persist();
  }

  /** 上一 tick 的净成交股数（买−卖）；定价先于撮合，读到的即"上一 tick"存量。 */
  netFlow(code: string): number {
    if (this.mem !== null) return this.mem.flow[code] ?? 0;
    const row = this.db.prepare(`SELECT value FROM config WHERE key='matcher_flow'`)
      .get() as { value: string } | undefined;
    if (row === undefined) return 0;
    return (JSON.parse(row.value) as Record<string, number>)[code] ?? 0;
  }

  onFill(cb: (f: FillEvent) => void): () => void {
    this.fillCbs.add(cb);
    return () => { this.fillCbs.delete(cb); };
  }

  /** 丢弃惰性缓存的 rng/flow 状态，下一次 tick 从 config 重新加载（引擎异常恢复用）。 */
  resetMemory(): void { this.mem = null; }

  // ---------- 内部 ----------

  /** 限价是否可跨现价 p 成交；市价恒可。 */
  private crosses(o: OrderRow, p: number): boolean {
    if (o.type === 'M') return true;
    return o.side === 'B' ? o.price! >= p : o.price! <= p;
  }

  /** 时间优先：(created_tick, id) 升序。 */
  private earlier(a: OrderRow, b: OrderRow): boolean {
    return a.created_tick < b.created_tick || (a.created_tick === b.created_tick && a.id < b.id);
  }

  /** 钉板队首抽签：队首存在即抽一次 u；u<prob 按比例取整分批，否则本 tick 不成交（抽签已消耗）。 */
  private boardFill(ctx: TickCtx, o: OrderRow, p: number, tickFlow: Record<string, number>): void {
    const u = this.mem!.rng.next();
    if (u >= this.cfg.trading.boardFillProb) return;
    const remaining = o.qty - o.filled;
    let fillQty: number;
    if (remaining < 100) {
      fillQty = remaining;
    } else {
      const [r0, r1] = this.cfg.trading.boardFillRatio;
      fillQty = Math.min(remaining, Math.max(100,
        Math.floor(remaining * (r0 + u * (r1 - r0)) / 100) * 100));
    }
    this.fill(ctx, o, p, tickFlow, fillQty);
  }

  /** 4. 单笔成交（maxQty 供钉板分批）：trades 行先插（拿 ref）→ 清算腿 → orders/holdings → 完结释放 → 事件。 */
  private fill(ctx: TickCtx, o: OrderRow, pExec: number, tickFlow: Record<string, number>, maxQty?: number): void {
    let qty = o.qty - o.filled;
    if (maxQty !== undefined) qty = Math.min(qty, maxQty);
    if (o.side === 'B') {
      // 冻结封顶：total 不得超过 orders.frozen（绝不重算冻结），按 100 股递减
      let amount = pExec * qty, comm = commission(amount), tf = transferFee(amount);
      while (qty > 0 && amount + comm + tf > o.frozen) {
        qty -= 100;
        if (qty <= 0) return; // 冻结不足最小手数 → 本 tick 跳过该单
        amount = pExec * qty; comm = commission(amount); tf = transferFee(amount);
      }
      const total = amount + comm + tf;
      const tradeId = this.insertTrade(o, 'B', pExec, qty, comm, 0, tf, ctx);
      const legs: Leg[] = [
        { account: o.user_id, bucket: 'F', amount: -total, kind: 'TRADE_BUY' },
        { account: ACC.MARKET, bucket: 'A', amount, kind: 'TRADE_BUY' },
        { account: ACC.CLEARING, bucket: 'A', amount: comm + tf, kind: 'TRADE_BUY' },
      ];
      post(this.db, ctx.day, ctx.tickInDay, 'trade', tradeId, legs);
      this.db.prepare('UPDATE orders SET frozen = frozen - ?, filled = filled + ? WHERE id = ?')
        .run(total, qty, o.id);
      // T+1：qty_sellable 不增，由日终结算解锁
      this.db.prepare(`INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total)
        VALUES (?,?,?,0,?)
        ON CONFLICT(user_id, code) DO UPDATE SET
          qty_total = qty_total + excluded.qty_total, cost_total = cost_total + excluded.cost_total`)
        .run(o.user_id, o.code, qty, total);
      const done = o.filled + qty === o.qty;
      if (done) {
        this.db.prepare(`UPDATE orders SET status='done' WHERE id = ?`).run(o.id);
        const fresh = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id) as OrderRow;
        releaseOrderRemainder(this.db, fresh, ctx.day, ctx.tickInDay); // 剩余冻结退回、frozen=0
      }
      tickFlow[o.code] = (tickFlow[o.code] ?? 0) + qty;
      this.emit({ userId: o.user_id, orderId: o.id, code: o.code, side: 'B', price: pExec, qty,
        commission: comm, stamp: 0, transfer: tf, day: ctx.day, tick: ctx.tickInDay,
        orderStatus: done ? 'done' : 'open' });
    } else {
      const amount = pExec * qty;
      const comm = commission(amount), tf = transferFee(amount), stamp = stampTax(amount);
      const net = amount - comm - tf - stamp;
      const h = this.db.prepare('SELECT qty_total qt, cost_total ct FROM holdings WHERE user_id = ? AND code = ?')
        .get(o.user_id, o.code) as { qt: number; ct: number } | undefined;
      const qtBefore = h?.qt ?? 0, ctBefore = h?.ct ?? 0;
      const costOut = qtBefore > 0 ? roundHalfUpDiv(ctBefore * qty, qtBefore) : 0;
      const tradeId = this.insertTrade(o, 'S', pExec, qty, comm, stamp, tf, ctx);
      const legs: Leg[] = [
        { account: ACC.MARKET, bucket: 'A', amount: -amount, kind: 'TRADE_SELL' },
        { account: o.user_id, bucket: 'A', amount: net, kind: 'TRADE_SELL' },
        { account: ACC.CLEARING, bucket: 'A', amount: comm + tf, kind: 'TRADE_SELL' },
        { account: ACC.TAX, bucket: 'A', amount: stamp, kind: 'TRADE_SELL' },
      ];
      post(this.db, ctx.day, ctx.tickInDay, 'trade', tradeId, legs);
      if (qtBefore - qty === 0) {
        this.db.prepare('UPDATE holdings SET qty_total = 0, cost_total = 0 WHERE user_id = ? AND code = ?')
          .run(o.user_id, o.code); // 清仓：cost_total 显式清零
      } else {
        this.db.prepare(`UPDATE holdings SET qty_total = qty_total - ?, cost_total = cost_total - ?
          WHERE user_id = ? AND code = ?`).run(qty, costOut, o.user_id, o.code);
      }
      const done = o.filled + qty === o.qty;
      this.db.prepare(`UPDATE orders SET filled = filled + ?, status = ? WHERE id = ?`)
        .run(qty, done ? 'done' : 'open', o.id);
      tickFlow[o.code] = (tickFlow[o.code] ?? 0) - qty;
      this.emit({ userId: o.user_id, orderId: o.id, code: o.code, side: 'S', price: pExec, qty,
        commission: comm, stamp, transfer: tf, day: ctx.day, tick: ctx.tickInDay,
        orderStatus: done ? 'done' : 'open' });
    }
  }

  private insertTrade(o: OrderRow, side: 'B' | 'S', price: number, qty: number,
      comm: number, stamp: number, tf: number, ctx: TickCtx): number {
    const r = this.db.prepare(`INSERT INTO trades(order_id, user_id, code, side, price, qty,
      commission, stamp, transfer, day, tick) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(o.id, o.user_id, o.code, side, price, qty, comm, stamp, tf, ctx.day, ctx.tickInDay);
    return Number(r.lastInsertRowid);
  }

  private loadState(day: number): void {
    if (this.mem !== null) {
      if (this.mem.day !== day) this.mem = this.freshState(day);
      return;
    }
    const row = this.db.prepare(`SELECT value FROM config WHERE key='matcher_rng'`)
      .get() as { value: string } | undefined;
    if (row !== undefined) {
      const s = JSON.parse(row.value) as { day: number; state: string };
      if (s.day === day) {
        const flowRow = this.db.prepare(`SELECT value FROM config WHERE key='matcher_flow'`)
          .get() as { value: string } | undefined;
        this.mem = { day, rng: Rng.restore(s.state),
          flow: flowRow === undefined ? {} : JSON.parse(flowRow.value) as Record<string, number> };
        return;
      }
    }
    this.mem = this.freshState(day); // 无存量或日切换：重建 matching 流、净流清零
  }

  private freshState(day: number): MatcherState {
    return { day, rng: Rng.fromSeed(this.masterSeed, day, 'matching'), flow: {} };
  }

  private persist(): void {
    const mem = this.mem!;
    this.upsertConfig('matcher_rng', JSON.stringify({ day: mem.day, state: mem.rng.serialize() }));
    this.upsertConfig('matcher_flow', JSON.stringify(mem.flow));
  }

  private upsertConfig(key: string, value: string): void {
    this.db.prepare(`INSERT INTO config(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  private emit(f: FillEvent): void {
    for (const cb of this.fillCbs) cb(f);
  }
}
