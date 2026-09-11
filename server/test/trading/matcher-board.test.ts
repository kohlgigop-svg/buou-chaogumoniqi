// test/trading/matcher-board.test.ts —— Task 5b：钉板队列 + 净流冲击 + 补跑一致性 + 引擎异常恢复。
// 单元级（1-3）：手工 TickCtx 钉板后推 tick，验证队列分批/时间优先/跌停对称。
// 引擎级（4-7）：真实 Engine + PlayerMatcher，netFlow 冲击、中断重启补跑、结算及连续撮合异常恢复。
import { describe, it, expect } from 'vitest';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { seedStocks } from '../../src/seed/stocks.js';
import { post, auditUser, auditGlobal } from '../../src/core/ledger.js';
import { engineNow, placeOrder, type OrderRow } from '../../src/trading/orders.js';
import { PlayerMatcher, type FillEvent } from '../../src/trading/matcher.js';
import { Engine } from '../../src/engine/engine.js';
import type { TickCtx, StockQuote } from '../../src/engine/types.js';
import { Rng } from '../../src/core/rng.js';
import { TICKS_PER_DAY, TICK_MS, phaseOfTick } from '../../src/core/clock.js';
import type { PlaceOrderInput } from '@pt/shared';

const G = 1_700_000_000_000;
const SEED = 20260828;

const POISONED_RNG = new Proxy({}, {
  get(): never { throw new Error('ctx.rng is forbidden inside PlayerMatcher'); },
}) as unknown as Rng;

function mkDb(): DB {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO engine_state(id, master_seed, genesis_ms, last_tick, state_json)
    VALUES (1, 1, ?, -1, '{}')`).run(G);
  seedStocks(db, 1);
  return db;
}
function mkUser(db: DB, name: string, cash: number): number {
  const r = db.prepare('INSERT INTO users(username) VALUES (?)').run(name);
  const uid = Number(r.lastInsertRowid);
  if (cash > 0) {
    post(db, 1, 0, 'genesis', uid, [
      { account: uid, bucket: 'A', amount: cash, kind: 'GENESIS' },
      { account: ACC.MARKET, bucket: 'A', amount: -cash, kind: 'GENESIS' },
    ]);
  }
  return uid;
}
function setTick(db: DB, t: number): void {
  db.prepare('UPDATE engine_state SET last_tick = ? WHERE id = 1').run(t);
}
function place(db: DB, uid: number, req: PlaceOrderInput): number {
  const en = engineNow(db);
  return placeOrder(db, DEFAULTS, en.day, en.nextTick, en.phase, uid, req).orderId;
}
/** 手工 TickCtx：quotes 逐行取 stock_state（不经引擎，价格保持种子值） */
function mkCtx(db: DB, globalTick: number): TickCtx {
  const rows = db.prepare(`SELECT s.code, t.price, t.prev_close pc, t.limit_up up, t.limit_down dn,
    t.volume, s.status FROM stocks s JOIN stock_state t ON t.code = s.code ORDER BY s.code`).all() as
    { code: string; price: number; pc: number; up: number; dn: number; volume: number; status: string }[];
  const quotes = new Map<string, StockQuote>();
  for (const r of rows) quotes.set(r.code, { code: r.code, price: r.price, prevClose: r.pc,
    limitUp: r.up, limitDown: r.dn, volume: r.volume, status: r.status });
  const tid = globalTick % TICKS_PER_DAY;
  return { day: Math.floor(globalTick / TICKS_PER_DAY) + 1, tickInDay: tid, globalTick,
    phase: phaseOfTick(tid), db, rng: POISONED_RNG, cfg: DEFAULTS, quotes };
}
function mkMatcher(db: DB): PlayerMatcher {
  return new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
}
function orderRow(db: DB, id: number): OrderRow {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow;
}
function holdings(db: DB, uid: number, code: string): { qt: number; qs: number; ct: number } | undefined {
  return db.prepare('SELECT qty_total qt, qty_sellable qs, cost_total ct FROM holdings WHERE user_id=? AND code=?')
    .get(uid, code) as { qt: number; qs: number; ct: number } | undefined;
}
function configVal(db: DB, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM config WHERE key=?').get(key) as { value: string } | undefined;
  return r?.value;
}
let seq = 0;
const req = (over: Partial<PlaceOrderInput>): PlaceOrderInput =>
  ({ code: '600619', side: 'B', type: 'L', price: 158_000, qty: 100, clientKey: 'mk-' + seq++, ...over }) as PlaceOrderInput;

// 长补跑按“日”分块并让出事件循环（模式取自 engine.test.ts catchUpChunked）。
async function catchUpChunked(eng: Engine, genesisMs: number, days: number): Promise<void> {
  for (let d = 1; d <= days; d++) {
    eng.catchUpTo(genesisMs + d * 3_600_000);
    await new Promise<void>(r => setImmediate(r));
  }
}

describe('PlayerMatcher 钉板队列（单元）', () => {
  it('钉板分批：市价买 5 万股经队列多笔成交，qty 百股取整、价=板价，同 seed 重跑逐字段一致', () => {
    const run = (): { tick: number; price: number; qty: number }[] => {
      const db = mkDb();
      const m = mkMatcher(db);
      const uid = mkUser(db, 'u1', 10_000_000_000);
      db.prepare(`UPDATE stock_state SET limit_up=158000 WHERE code='600619'`).run(); // p==up
      setTick(db, 120);
      const oid = place(db, uid, req({ code: '600619', type: 'M', price: undefined, qty: 50_000 }));
      const fills: FillEvent[] = [];
      m.onFill(f => fills.push(f));
      for (let t = 121; t < 121 + 5000 && orderRow(db, oid).status !== 'done'; t++) {
        m.onContinuousTick(mkCtx(db, t));
      }
      expect(orderRow(db, oid).status).toBe('done');
      auditUser(db, uid); auditGlobal(db);
      db.close();
      return fills.map(f => ({ tick: f.tick, price: f.price, qty: f.qty }));
    };
    const a = run();
    expect(a.length).toBeGreaterThan(1);
    for (const f of a) { expect(f.qty % 100).toBe(0); expect(f.price).toBe(158_000); }
    expect(a.reduce((s, f) => s + f.qty, 0)).toBe(50_000);
    expect(run()).toEqual(a); // 同 seed 新库 → 逐字段一致
  });

  it('队列时间优先：两用户先后挂钉板买单，首笔成交归先挂者', () => {
    const db = mkDb();
    const m = mkMatcher(db);
    const u1 = mkUser(db, 'u1', 10_000_000_000);
    const u2 = mkUser(db, 'u2', 10_000_000_000);
    db.prepare(`UPDATE stock_state SET limit_up=158000 WHERE code='600619'`).run();
    setTick(db, 120);
    const o1 = place(db, u1, req({ code: '600619', type: 'L', price: 158_000, qty: 1000 }));
    const o2 = place(db, u2, req({ code: '600619', type: 'L', price: 158_000, qty: 1000 }));
    for (let t = 121; t < 2000
      && (db.prepare('SELECT COUNT(*) c FROM trades').get() as { c: number }).c === 0; t++) {
      m.onContinuousTick(mkCtx(db, t));
    }
    const first = db.prepare('SELECT * FROM trades ORDER BY id LIMIT 1').get() as { order_id: number; user_id: number };
    expect(first.order_id).toBe(o1);
    expect(first.user_id).toBe(u1);
    auditUser(db, u1); auditUser(db, u2); auditGlobal(db);
    db.close();
  });

  it('跌停对称：pin limit_down 后市价卖分批成交，清仓 cost_total=0', () => {
    const db = mkDb();
    const m = mkMatcher(db);
    const uid = mkUser(db, 'u1', 0);
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,30000,30000,0)')
      .run(uid, '601389');
    db.prepare(`UPDATE stock_state SET limit_down=520 WHERE code='601389'`).run(); // p==down
    setTick(db, 120);
    const oid = place(db, uid, req({ code: '601389', side: 'S', type: 'M', price: undefined, qty: 30_000 }));
    const fills: FillEvent[] = [];
    m.onFill(f => fills.push(f));
    for (let t = 121; t < 121 + 5000 && orderRow(db, oid).status !== 'done'; t++) {
      m.onContinuousTick(mkCtx(db, t));
    }
    expect(orderRow(db, oid).status).toBe('done');
    expect(fills.length).toBeGreaterThan(1);
    for (const f of fills) { expect(f.qty % 100).toBe(0); expect(f.price).toBe(520); }
    expect(fills.reduce((s, f) => s + f.qty, 0)).toBe(30_000);
    expect(holdings(db, uid, '601389')).toEqual({ qt: 0, qs: 0, ct: 0 });
    auditUser(db, uid); auditGlobal(db);
    db.close();
  });
});

describe('PlayerMatcher 净流冲击与补跑一致性（引擎）', () => {
  it('netFlow 冲击：大额市价买成交后，下一 tick 该股价格高于同 seed 无订单孪生', async () => {
    const mk = () => {
      const db = openDb(':memory:');
      const matcher = new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
      const eng = new Engine({ db, cfg: DEFAULTS, masterSeed: SEED, genesisMs: G, matcher, flow: matcher });
      return { db, eng, matcher };
    };
    const A = mk(); const B = mk();
    const uid = mkUser(A.db, 'u1', 50_000_000_000);
    A.eng.catchUpTo(G + 300 * TICK_MS);
    B.eng.catchUpTo(G + 300 * TICK_MS);
    await new Promise<void>(r => setImmediate(r));
    const en = engineNow(A.db);
    placeOrder(A.db, DEFAULTS, en.day, en.nextTick, en.phase, uid,
      { code: '300761', side: 'B', type: 'M', qty: 100_000, clientKey: 'flow-big' } as PlaceOrderInput);
    A.eng.catchUpTo(G + 301 * TICK_MS); // A 成交 tick
    B.eng.catchUpTo(G + 301 * TICK_MS);
    const flowA = JSON.parse(configVal(A.db, 'matcher_flow')!) as Record<string, number>;
    expect(flowA['300761']).toBeGreaterThan(0);
    A.eng.catchUpTo(G + 302 * TICK_MS); // 冲击作用于下一 tick 定价
    B.eng.catchUpTo(G + 302 * TICK_MS);
    const pa = (A.db.prepare(`SELECT price FROM ticks WHERE code='300761' AND day=1 AND tick=302`).get() as { price: number }).price;
    const pb = (B.db.prepare(`SELECT price FROM ticks WHERE code='300761' AND day=1 AND tick=302`).get() as { price: number }).price;
    expect(pa).toBeGreaterThan(pb);
    A.db.close(); B.db.close();
  });

  it('补跑一致性（灵魂）：连续 vs 中断重启，钉板队列 RNG 续流后全库 dump 全等', async () => {
    const build = () => {
      const db = openDb(':memory:');
      const matcher = new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
      const eng = new Engine({ db, cfg: DEFAULTS, masterSeed: SEED, genesisMs: G, matcher, flow: matcher });
      return { db, eng, matcher };
    };
    const placeAll = (db: DB): void => {
      const en = engineNow(db);
      const px = (db.prepare(`SELECT price FROM stock_state WHERE code='600619'`).get() as { price: number }).price;
      db.prepare(`UPDATE stock_state SET limit_up = ?, limit_down = ? WHERE code='600619'`).run(px, px); // 钉死（p==up==dn）
      const st = db.prepare(`SELECT price, limit_up up, limit_down dn FROM stock_state WHERE code='601389'`)
        .get() as { price: number; up: number; dn: number };
      const u1 = (db.prepare(`SELECT id FROM users WHERE username='u1'`).get() as { id: number }).id;
      const u2 = (db.prepare(`SELECT id FROM users WHERE username='u2'`).get() as { id: number }).id;
      placeOrder(db, DEFAULTS, en.day, en.nextTick, en.phase, u1,
        { code: '601389', side: 'B', type: 'L', price: st.up, qty: 100, clientKey: 'r-lb' } as PlaceOrderInput);
      placeOrder(db, DEFAULTS, en.day, en.nextTick, en.phase, u1,
        { code: '601389', side: 'B', type: 'M', qty: 200, clientKey: 'r-mb' } as PlaceOrderInput);
      placeOrder(db, DEFAULTS, en.day, en.nextTick, en.phase, u1,
        { code: '601389', side: 'S', type: 'L', price: st.dn, qty: 300, clientKey: 'r-ls' } as PlaceOrderInput);
      placeOrder(db, DEFAULTS, en.day, en.nextTick, en.phase, u2,
        { code: '600619', side: 'B', type: 'L', price: px, qty: 10_000, clientKey: 'r-pb' } as PlaceOrderInput);
    };
    const seedUsers = (db: DB): void => {
      mkUser(db, 'u1', 10_000_000_000);
      mkUser(db, 'u2', 10_000_000_000);
      db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,2000,2000,0)')
        .run((db.prepare(`SELECT id FROM users WHERE username='u1'`).get() as { id: number }).id, '601389');
    };

    // A：连续补跑到 2 日
    const A = build();
    seedUsers(A.db);
    await catchUpChunked(A.eng, G, 1);
    A.eng.catchUpTo(G + 3_600_000 + 500 * TICK_MS); // day2 tick 500（下单停点）
    placeAll(A.db);
    await catchUpChunked(A.eng, G, 2); // 续至 G+2×3_600_000

    // B：同停点下单 → 至 1.5 日 → 丢弃实例重建 → 续至 A 目标
    const B = build();
    seedUsers(B.db);
    await catchUpChunked(B.eng, G, 1);
    B.eng.catchUpTo(G + 3_600_000 + 500 * TICK_MS);
    placeAll(B.db);
    B.eng.catchUpTo(G + 3_600_000 + 600 * TICK_MS); // 1.5 日（重建点）
    await new Promise<void>(r => setImmediate(r));
    const matcherB2 = new PlayerMatcher({ db: B.db, cfg: DEFAULTS, masterSeed: SEED });
    const engB2 = new Engine({ db: B.db, cfg: DEFAULTS, masterSeed: SEED, genesisMs: G, matcher: matcherB2, flow: matcherB2 });
    engB2.catchUpTo(G + 2 * 3_600_000);

    // 钉板队列确实跨过重建点（否则 RNG 续流未被真实验证）
    const boardTrades = B.db.prepare(`SELECT day, tick FROM trades WHERE code='600619'`).all() as { day: number; tick: number }[];
    expect(boardTrades.some(t => t.day === 2 && t.tick < 600)).toBe(true);
    expect(boardTrades.some(t => t.day === 2 && t.tick >= 600)).toBe(true);

    const dump = (db: DB) => ({
      trades: db.prepare('SELECT * FROM trades ORDER BY id').all(),
      ledger: db.prepare('SELECT user_id, bucket, kind, amount FROM ledger ORDER BY user_id, bucket, kind, amount, id').all(),
      holdings: db.prepare('SELECT user_id, code, qty_total, qty_sellable, cost_total FROM holdings ORDER BY user_id, code').all(),
      orders: db.prepare('SELECT id, user_id, code, side, type, price, qty, status, filled, frozen, day, created_tick FROM orders ORDER BY id').all(),
      stock_state: db.prepare('SELECT code, price FROM stock_state ORDER BY code').all(),
      matcher_rng: db.prepare(`SELECT value FROM config WHERE key='matcher_rng'`).get() as { value: string } | undefined,
      matcher_flow: db.prepare(`SELECT value FROM config WHERE key='matcher_flow'`).get() as { value: string } | undefined,
    });
    expect(dump(B.db)).toEqual(dump(A.db));
    A.db.close(); B.db.close();
  }, 120_000);
});

describe('引擎异常恢复', () => {
  it('连续撮合 persist 后抛错：定价和 matching RNG 均回滚，同实例重试与同 seed 孪生逐字段一致', () => {
    const dump = (db: DB) => ({
      engine_state: db.prepare('SELECT * FROM engine_state WHERE id=1').get() as { last_tick: number; state_json: string },
      trades: db.prepare('SELECT * FROM trades ORDER BY id').all(),
      ledger: db.prepare('SELECT * FROM ledger ORDER BY id').all(),
      holdings: db.prepare('SELECT * FROM holdings ORDER BY user_id, code').all(),
      orders: db.prepare('SELECT * FROM orders ORDER BY id').all(),
      config: db.prepare('SELECT * FROM config ORDER BY key').all(),
      balances: db.prepare('SELECT id, cash_available, cash_frozen FROM users ORDER BY id').all(),
      stock_state: db.prepare('SELECT * FROM stock_state ORDER BY code').all(),
      ticks: db.prepare('SELECT * FROM ticks ORDER BY code, day, tick').all(),
    });
    class ThrowAfterPersistMatcher extends PlayerMatcher {
      armed = false;
      failedTick: { pricingRng: string; matchingRng: string; state: ReturnType<typeof dump> } | undefined;

      override onContinuousTick(ctx: TickCtx): void {
        super.onContinuousTick(ctx);
        if (!this.armed) return;
        this.armed = false;
        // 完整撮合及 persist 已执行，事务尚未提交；不依赖钉板本次抽签能否成交。
        this.failedTick = { pricingRng: ctx.rng.serialize(), matchingRng: configVal(ctx.db, 'matcher_rng')!,
          state: dump(ctx.db) };
        throw new Error('continuous-after-persist');
      }
    }
    const build = () => {
      const db = openDb(':memory:');
      // SQLite 默认时间不受 JS 时钟影响，固定本连接时间以比较 ledger 完整行（含 created_at）。
      db.function('unixepoch', () => G / 1000);
      const matcher = new ThrowAfterPersistMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
      let errors = 0;
      const eng = new Engine({ db, cfg: DEFAULTS, masterSeed: SEED, genesisMs: G, matcher, flow: matcher,
        onTickError: () => { errors++; matcher.resetMemory(); } });
      return { db, matcher, eng, uid: mkUser(db, 'u1', 10_000_000_000), errors: () => errors };
    };
    const A = build(); const B = build();
    try {
      for (const { db, eng, uid } of [A, B]) {
        eng.catchUpTo(G + 300 * TICK_MS);
        db.prepare(`UPDATE stock_state SET limit_up=price, limit_down=price WHERE code='600619'`).run();
        // 第二只股保留宽价格区间，保证普通成交与钉板抽签分别发生。
        db.prepare(`UPDATE stock_state SET limit_up=price*2, limit_down=1 WHERE code='601389'`).run();
        const boardPrice = eng.getQuote('600619')!.price;
        const buyPrice = eng.getQuote('601389')!.limitUp;
        const boardId = place(db, uid, { code: '600619', side: 'B', type: 'L', price: boardPrice,
          qty: 10_000, clientKey: 'rollback-board' });
        const warmupId = place(db, uid, { code: '601389', side: 'B', type: 'L', price: buyPrice,
          qty: 100, clientKey: 'rollback-warmup' });
        eng.catchUpTo(G + 301 * TICK_MS);
        expect(orderRow(db, warmupId).status).toBe('done');
        expect(orderRow(db, boardId).status).toBe('open');
        expect(JSON.parse(configVal(db, 'matcher_flow')!)['601389']).toBe(100);
        place(db, uid, { code: '601389', side: 'B', type: 'L', price: buyPrice,
          qty: 200, clientKey: 'rollback-fill' });
      }
      const before = dump(A.db);
      expect(dump(B.db)).toEqual(before);
      const pricingBefore = (JSON.parse(before.engine_state.state_json) as { rng: string }).rng;
      const matchingBefore = JSON.parse(configVal(A.db, 'matcher_rng')!) as { day: number; state: string };
      const expectedMatching = Rng.restore(matchingBefore.state);
      expectedMatching.next(); // 一个钉板队首必抽一次，是否成交都必须推进。
      A.matcher.armed = true;
      expect(() => A.eng.catchUpTo(G + 302 * TICK_MS)).toThrow('continuous-after-persist');
      expect(A.errors()).toBe(1);
      const failed = A.matcher.failedTick!;
      expect(failed.pricingRng).not.toBe(pricingBefore);
      expect(JSON.parse(failed.matchingRng)).toEqual({ day: matchingBefore.day, state: expectedMatching.serialize() });
      expect(failed.state.trades.length).toBeGreaterThan(before.trades.length);
      expect(failed.state.ledger.length).toBeGreaterThan(before.ledger.length);
      expect(failed.state.holdings).not.toEqual(before.holdings);
      expect(failed.state.orders).not.toEqual(before.orders);
      expect(failed.state.config).not.toEqual(before.config);
      expect(failed.state.stock_state).not.toEqual(before.stock_state);
      // 数据库全量字段回滚，内存净流也恢复至上一个成功 tick，而非失败轮的 200 股。
      expect(dump(A.db)).toEqual(before);
      expect(A.matcher.netFlow('601389')).toBe(100);
      auditUser(A.db, A.uid); auditGlobal(A.db);

      expect(A.eng.catchUpTo(G + 302 * TICK_MS)).toBe(1);
      expect(B.eng.catchUpTo(G + 302 * TICK_MS)).toBe(1);
      expect(dump(A.db)).toEqual(dump(B.db));
      expect(dump(A.db).engine_state.last_tick).toBe(302);
      expect(A.matcher.netFlow('601389')).toBe(200);
      // 再推进一轮，验证恢复后的净流冲击及两条 RNG 流继续与无异常孪生一致。
      A.eng.catchUpTo(G + 303 * TICK_MS);
      B.eng.catchUpTo(G + 303 * TICK_MS);
      expect(dump(A.db)).toEqual(dump(B.db));
      expect(A.errors()).toBe(1);
      expect(B.errors()).toBe(0);
      for (const { db, uid } of [A, B]) { auditUser(db, uid); auditGlobal(db); }
    } finally {
      A.db.close(); B.db.close();
    }
  });

  it('一次性抛错 SettlementHook + onTickError → 重试成功、last_tick 连续、终态与孪生一致', async () => {
    const build = (inject: boolean) => {
      const db = openDb(':memory:');
      const matcher = new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
      let threw = false;
      let errors = 0;
      const eng = new Engine({
        db, cfg: DEFAULTS, masterSeed: SEED, genesisMs: G, matcher, flow: matcher,
        settlementHooks: inject ? [{ onSettlement: () => { if (!threw) { threw = true; throw new Error('boom'); } } }] : [],
        onTickError: inject ? () => { errors++; matcher.resetMemory(); } : undefined,
      });
      return { db, eng, errors: () => errors };
    };
    const A = build(true);
    const B = build(false);
    const seed = (db: DB): void => {
      const uid = mkUser(db, 'u1', 10_000_000_000);
      db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,1000,1000,0)')
        .run(uid, '601389');
    };
    seed(A.db); seed(B.db);
    A.eng.catchUpTo(G + 300 * TICK_MS);
    B.eng.catchUpTo(G + 300 * TICK_MS);
    const placeOne = (db: DB): void => {
      const en = engineNow(db);
      const uid = (db.prepare(`SELECT id FROM users WHERE username='u1'`).get() as { id: number }).id;
      placeOrder(db, DEFAULTS, en.day, en.nextTick, en.phase, uid,
        { code: '601389', side: 'B', type: 'M', qty: 100, clientKey: 'x-mb' } as PlaceOrderInput);
    };
    placeOne(A.db); placeOne(B.db);
    expect(() => A.eng.catchUpTo(G + 3_600_000)).toThrow('boom');
    expect(A.errors()).toBe(1);
    // 同实例重试成功，last_tick 连续到目标
    A.eng.catchUpTo(G + 3_600_000);
    B.eng.catchUpTo(G + 3_600_000);
    const dump = (db: DB) => ({
      last_tick: (db.prepare('SELECT last_tick FROM engine_state WHERE id=1').get() as { last_tick: number }).last_tick,
      stock_state: db.prepare('SELECT code, price FROM stock_state ORDER BY code').all(),
      trades: db.prepare('SELECT * FROM trades ORDER BY id').all(),
      orders: db.prepare('SELECT id, user_id, code, side, type, price, qty, status, filled, frozen FROM orders ORDER BY id').all(),
      ledger: db.prepare('SELECT user_id, bucket, kind, amount FROM ledger ORDER BY user_id, bucket, kind, amount, id').all(),
      matcher_rng: db.prepare(`SELECT value FROM config WHERE key='matcher_rng'`).get() as { value: string } | undefined,
    });
    expect(dump(A.db)).toEqual(dump(B.db));
    expect((dump(A.db).last_tick as number)).toBe(1200);
    A.db.close(); B.db.close();
  }, 60_000);
});
