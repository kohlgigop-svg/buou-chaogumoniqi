// test/trading/matcher.test.ts —— Task 5a：PlayerMatcher 连续竞价撮合核心。
// 单元级：直接构造 TickCtx（quotes 读 stock_state，价格保持种子值 → 金额可手算）；
// ctx.rng 传毒化 Proxy（任何访问即抛）断言撮合绝不消耗 ctx.rng。
// 集成级：真实 Engine + PlayerMatcher，小步 catchUpTo 驱动 + ledger 全套审计。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { seedStocks } from '../../src/seed/stocks.js';
import { post, balancesOf, auditUser, auditGlobal } from '../../src/core/ledger.js';
import { engineNow, placeOrder, cancelOrder, type OrderRow } from '../../src/trading/orders.js';
import { PlayerMatcher, type FillEvent } from '../../src/trading/matcher.js';
import { Engine } from '../../src/engine/engine.js';
import type { TickCtx, StockQuote } from '../../src/engine/types.js';
import type { Rng } from '../../src/core/rng.js';
import { TICKS_PER_DAY, TICK_MS, phaseOfTick } from '../../src/core/clock.js';
import type { PlaceOrderInput } from '@pt/shared';

const G = 1_700_000_000_000;
const SEED = 20260828;

// 任何属性访问即抛：撮合路径禁用 ctx.rng（独立 matching 流由 matcher 自管）
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

describe('PlayerMatcher 限价撮合', () => {
  let db: DB; let m: PlayerMatcher;
  beforeEach(() => { db = mkDb(); m = mkMatcher(db); });
  afterEach(() => { db.close(); });

  it('限价买（委托价>现价）当 tick 以现价成交：trades/三腿/done/剩余冻结退回/T+1', () => {
    const uid = mkUser(db, 'u1', 100_000_000);
    setTick(db, 120); // nextTick=121 continuous
    // 买 600619 100股@1600元（现价 1580 元）：freeze=16_000_000+4000+160=16_004_160
    const oid = place(db, uid, req({ price: 160_000 }));
    expect(orderRow(db, oid).frozen).toBe(16_004_160);
    const fills: FillEvent[] = [];
    m.onFill(f => fills.push(f));
    m.onContinuousTick(mkCtx(db, 121));
    // 成交价=现价 158_000：amount=15_800_000, comm=3950, tf=158, total=15_804_108
    const t = db.prepare('SELECT * FROM trades WHERE order_id=?').all(oid);
    expect(t).toEqual([expect.objectContaining({ order_id: oid, user_id: uid, code: '600619', side: 'B',
      price: 158_000, qty: 100, commission: 3950, stamp: 0, transfer: 158, day: 1, tick: 121 })]);
    const tradeId = (t[0] as { id: number }).id;
    const legs = db.prepare(`SELECT user_id, bucket, amount, ref_type, ref_id FROM ledger
      WHERE kind='TRADE_BUY' ORDER BY id`).all();
    expect(legs).toEqual([
      { user_id: uid, bucket: 'F', amount: -15_804_108, ref_type: 'trade', ref_id: tradeId },
      { user_id: ACC.MARKET, bucket: 'A', amount: 15_800_000, ref_type: 'trade', ref_id: tradeId },
      { user_id: ACC.CLEARING, bucket: 'A', amount: 4_108, ref_type: 'trade', ref_id: tradeId },
    ]);
    // 完结：status=done、filled=100、剩余冻结 16_004_160−15_804_108=200_052 全退（UNFREEZE）
    expect(orderRow(db, oid)).toMatchObject({ status: 'done', filled: 100, frozen: 0 });
    const unfreeze = db.prepare(`SELECT bucket, amount FROM ledger WHERE kind='ORDER_UNFREEZE' ORDER BY id`).all();
    expect(unfreeze).toEqual([
      { bucket: 'F', amount: -200_052 },
      { bucket: 'A', amount: 200_052 },
    ]);
    expect(balancesOf(db, uid)).toEqual({ available: 100_000_000 - 15_804_108, frozen: 0 });
    // T+1：qty_total 增、sellable 不增、cost_total=总成本
    expect(holdings(db, uid, '600619')).toEqual({ qt: 100, qs: 0, ct: 15_804_108 });
    expect(fills).toEqual([{ userId: uid, orderId: oid, code: '600619', side: 'B', price: 158_000,
      qty: 100, commission: 3950, stamp: 0, transfer: 158, day: 1, tick: 121, orderStatus: 'done' }]);
    auditUser(db, uid); auditGlobal(db);
  });

  it('限价卖对称：四腿含印花税、costOut 按比例、清仓 cost_total=0', () => {
    const uid = mkUser(db, 'u1', 0);
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,300,300,30000000)')
      .run(uid, '600619');
    setTick(db, 120);
    const oid = place(db, uid, req({ side: 'S', price: 150_000, qty: 100 })); // 150_000 ≤ 现价 158_000 → 成交@158_000
    m.onContinuousTick(mkCtx(db, 121));
    // amount=15_800_000, comm=3950, tf=158, stamp=7900, net=15_787_992
    const t = db.prepare('SELECT * FROM trades WHERE order_id=?').all(oid);
    expect(t).toEqual([expect.objectContaining({ side: 'S', price: 158_000, qty: 100,
      commission: 3950, stamp: 7900, transfer: 158, day: 1, tick: 121 })]);
    const tradeId = (t[0] as { id: number }).id;
    const legs = db.prepare(`SELECT user_id, bucket, amount, ref_id FROM ledger WHERE kind='TRADE_SELL' ORDER BY id`).all();
    expect(legs).toEqual([
      { user_id: ACC.MARKET, bucket: 'A', amount: -15_800_000, ref_id: tradeId },
      { user_id: uid, bucket: 'A', amount: 15_787_992, ref_id: tradeId },
      { user_id: ACC.CLEARING, bucket: 'A', amount: 4_108, ref_id: tradeId },
      { user_id: ACC.TAX, bucket: 'A', amount: 7_900, ref_id: tradeId },
    ]);
    expect(orderRow(db, oid)).toMatchObject({ status: 'done', filled: 100 });
    // costOut = roundHalfUpDiv(30_000_000×100, 300) = 10_000_000
    expect(holdings(db, uid, '600619')).toEqual({ qt: 200, qs: 200, ct: 20_000_000 });
    expect(balancesOf(db, uid)).toEqual({ available: 15_787_992, frozen: 0 });
    // 清仓：卖出剩余 200 股 → qty_total=0 且 cost_total 显式清零
    setTick(db, 122);
    place(db, uid, req({ side: 'S', price: 150_000, qty: 200 }));
    m.onContinuousTick(mkCtx(db, 123));
    // amount=31_600_000, comm=7900, tf=316, stamp=15_800, net=31_575_984
    expect(holdings(db, uid, '600619')).toEqual({ qt: 0, qs: 0, ct: 0 });
    expect(balancesOf(db, uid)).toEqual({ available: 15_787_992 + 31_575_984, frozen: 0 });
    auditUser(db, uid); auditGlobal(db);
  });
});

describe('PlayerMatcher 市价单滑点', () => {
  let db: DB; let m: PlayerMatcher;
  beforeEach(() => { db = mkDb(); m = mkMatcher(db); });
  afterEach(() => { db.close(); });

  it('市价买 pExec=round(p×(1+slip))、冻结按 orders.frozen 释放无负数', () => {
    const uid = mkUser(db, 'u1', 1_000_000);
    // 601389 现价 520；adv 设 40_000 → slip = 0.06×√(400/40000) = 0.006 → pExec=round(523.12)=523
    db.prepare(`UPDATE stock_state SET adv=40000 WHERE code='601389'`).run();
    setTick(db, 120);
    const oid = place(db, uid, req({ code: '601389', type: 'M', price: undefined, qty: 400 }));
    // 冻结：ceil(520×1.02)=531 → base=212_400, comm=500, tf=2 → 212_902
    expect(orderRow(db, oid).frozen).toBe(212_902);
    m.onContinuousTick(mkCtx(db, 121));
    // amount=523×400=209_200, comm=max(500,52)=500, tf=2, total=209_702 ≤ frozen
    const t = db.prepare('SELECT * FROM trades WHERE order_id=?').all(oid);
    expect(t).toEqual([expect.objectContaining({ side: 'B', price: 523, qty: 400,
      commission: 500, stamp: 0, transfer: 2 })]);
    expect(orderRow(db, oid)).toMatchObject({ status: 'done', filled: 400, frozen: 0 });
    // 剩余冻结 212_902−209_702=3_200 退回，余额无负数
    const unfreeze = db.prepare(`SELECT bucket, amount FROM ledger WHERE kind='ORDER_UNFREEZE' ORDER BY id`).all();
    expect(unfreeze).toEqual([
      { bucket: 'F', amount: -3_200 },
      { bucket: 'A', amount: 3_200 },
    ]);
    expect(balancesOf(db, uid)).toEqual({ available: 1_000_000 - 209_702, frozen: 0 });
    expect(holdings(db, uid, '601389')).toEqual({ qt: 400, qs: 0, ct: 209_702 });
    auditUser(db, uid); auditGlobal(db);
  });
});

describe('PlayerMatcher 不成交路径', () => {
  let db: DB; let m: PlayerMatcher;
  beforeEach(() => { db = mkDb(); m = mkMatcher(db); });
  afterEach(() => { db.close(); });

  it('限价不跨价 → 不成交仍 open（买价<现价 / 卖价>现价）', () => {
    const uid = mkUser(db, 'u1', 100_000_000);
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,100,100,0)')
      .run(uid, '600619');
    setTick(db, 120);
    const buy = place(db, uid, req({ price: 150_000 }));            // 150_000 < 158_000
    const sell = place(db, uid, req({ side: 'S', price: 160_000, qty: 100 })); // 160_000 > 158_000
    m.onContinuousTick(mkCtx(db, 121));
    expect((db.prepare('SELECT COUNT(*) c FROM trades').get() as { c: number }).c).toBe(0);
    expect(orderRow(db, buy)).toMatchObject({ status: 'open', filled: 0, frozen: 15_003_900 });
    expect(orderRow(db, sell)).toMatchObject({ status: 'open', filled: 0 });
    // 有单无成交 → matcher_flow 写空对象（流水衰减为零）
    expect(JSON.parse(configVal(db, 'matcher_flow')!)).toEqual({});
    auditUser(db, uid); auditGlobal(db);
  });

  it('钉板队列：p==limit_up 买单经队列分批成交（不再整 tick 跳过）', () => {
    const uid = mkUser(db, 'u1', 10_000_000_000);
    db.prepare(`UPDATE stock_state SET limit_up=158000 WHERE code='600619'`).run(); // p==up
    setTick(db, 120);
    const mktPinned = place(db, uid, req({ code: '600619', type: 'M', price: undefined, qty: 1000 }));
    for (let t = 121; t < 121 + 2000 && orderRow(db, mktPinned).status !== 'done'; t++) {
      m.onContinuousTick(mkCtx(db, t));
    }
    expect(orderRow(db, mktPinned).status).toBe('done');
    const fills = db.prepare('SELECT * FROM trades WHERE order_id=? ORDER BY id').all(mktPinned) as
      { qty: number; price: number }[];
    expect(fills.length).toBeGreaterThan(1);
    for (const f of fills) { expect(f.qty % 100).toBe(0); expect(f.price).toBe(158_000); }
    auditUser(db, uid); auditGlobal(db);
  });

  it('未成交单撤单：releaseOrderRemainder 全额退回冻结', () => {
    const uid = mkUser(db, 'u1', 100_000_000);
    setTick(db, 120);
    // 买 100股@1500元：base=15_000_000, comm=3750, tf=150 → freeze=15_003_900
    const oid = place(db, uid, req({ price: 150_000 }));
    m.onContinuousTick(mkCtx(db, 121)); // 不跨价，不成交
    expect(orderRow(db, oid).status).toBe('open');
    cancelOrder(db, uid, oid);
    expect(balancesOf(db, uid)).toEqual({ available: 100_000_000, frozen: 0 });
    expect(orderRow(db, oid)).toMatchObject({ status: 'cancelled', frozen: 0 });
    const unfreeze = db.prepare(`SELECT bucket, amount FROM ledger WHERE kind='ORDER_UNFREEZE' ORDER BY id`).all();
    expect(unfreeze).toEqual([
      { bucket: 'F', amount: -15_003_900 },
      { bucket: 'A', amount: 15_003_900 },
    ]);
    auditUser(db, uid); auditGlobal(db);
  });
});

describe('PlayerMatcher 流水持久化与 netFlow', () => {
  let db: DB; let m: PlayerMatcher;
  beforeEach(() => { db = mkDb(); m = mkMatcher(db); });
  afterEach(() => { db.close(); });

  it('成交 tick 写 matcher_flow；下一 tick 无成交归 {}；netFlow 读上一 tick 值', () => {
    const uid = mkUser(db, 'u1', 100_000_000);
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,200,200,10000)')
      .run(uid, '601389');
    setTick(db, 120);
    place(db, uid, req({ price: 160_000 }));                                    // 买 600619 100 → +100
    place(db, uid, req({ code: '601389', side: 'S', price: 470, qty: 100 }));   // 卖 601389 100 → −100
    expect(m.netFlow('600619')).toBe(0); // 撮合前无存量
    m.onContinuousTick(mkCtx(db, 121));
    // 本 tick 净流已入库，下一 tick 的定价（netFlow）读到它
    expect(JSON.parse(configVal(db, 'matcher_flow')!)).toEqual({ '600619': 100, '601389': -100 });
    const rng = JSON.parse(configVal(db, 'matcher_rng')!) as { day: number; state: string };
    expect(rng.day).toBe(1);
    expect(typeof rng.state).toBe('string');
    expect(m.netFlow('600619')).toBe(100);
    expect(m.netFlow('601389')).toBe(-100);
    expect(m.netFlow('000003')).toBe(0);
    // 下一 tick 无 open 单 → 流水衰减为 {}
    m.onContinuousTick(mkCtx(db, 122));
    expect(configVal(db, 'matcher_flow')).toBe('{}');
    expect(m.netFlow('600619')).toBe(0);
    // 新实例（冷启动）从 config 读存量
    expect(mkMatcher(db).netFlow('600619')).toBe(0);
  });
});

describe('PlayerMatcher 冷启动净流回归', () => {
  it('全部成交后重建 matcher，无挂单的下一 tick 清空存量净流且保留 RNG', () => {
    const db = mkDb();
    try {
      const m = mkMatcher(db);
      const uid = mkUser(db, 'restart', 100_000_000);
      setTick(db, 120);
      const oid = place(db, uid, req({ price: 160_000 }));
      m.onContinuousTick(mkCtx(db, 121));
      expect(orderRow(db, oid).status).toBe('done');
      const beforeRng = configVal(db, 'matcher_rng');
      const restarted = mkMatcher(db);
      expect(restarted.netFlow('600619')).toBe(100);
      restarted.onContinuousTick(mkCtx(db, 122));
      expect(restarted.netFlow('600619')).toBe(0);
      expect(configVal(db, 'matcher_flow')).toBe('{}');
      expect(configVal(db, 'matcher_rng')).toBe(beforeRng);
      expect(mkMatcher(db).netFlow('600619')).toBe(0);
      auditUser(db, uid); auditGlobal(db);
    } finally { db.close(); }
  });
});

describe('PlayerMatcher 引擎集成审计', () => {
  it('两小段日内推进 + 下单撮合：auditGlobal=0、auditUser 全绿、T+1 保持', async () => {
    const db = openDb(':memory:');
    const matcher = new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
    const eng = new Engine({ db, cfg: DEFAULTS, masterSeed: SEED, genesisMs: G, matcher, flow: matcher });
    const uid = mkUser(db, 'trader', 100_000_000);
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,1000,1000,520000)')
      .run(uid, '601389');
    // 第一段：推进到日内连续竞价（tick 300）
    eng.catchUpTo(G + 300 * TICK_MS);
    await new Promise<void>(r => setImmediate(r)); // yield（模式取自 engine.test.ts catchUpChunked）
    const en = engineNow(db);
    expect(en.phase).toBe('continuous');
    const st = db.prepare(`SELECT price, limit_up up, limit_down dn FROM stock_state WHERE code='601389'`)
      .get() as { price: number; up: number; dn: number };
    // 限价买@limit_up（必≥现价）、市价买、限价卖@limit_down（必≤现价）
    placeOrder(db, DEFAULTS, en.day, en.nextTick, en.phase, uid,
      { code: '601389', side: 'B', type: 'L', price: st.up, qty: 100, clientKey: 'e-b1' } as PlaceOrderInput);
    placeOrder(db, DEFAULTS, en.day, en.nextTick, en.phase, uid,
      { code: '601389', side: 'B', type: 'M', qty: 200, clientKey: 'e-b2' } as PlaceOrderInput);
    placeOrder(db, DEFAULTS, en.day, en.nextTick, en.phase, uid,
      { code: '601389', side: 'S', type: 'L', price: st.dn, qty: 300, clientKey: 'e-s1' } as PlaceOrderInput);
    // 第二段：再推进 100 tick，订单在途撮合
    eng.catchUpTo(G + 400 * TICK_MS);
    await new Promise<void>(r => setImmediate(r));
    const trades = db.prepare('SELECT * FROM trades').all() as { side: string; qty: number }[];
    expect(trades.length).toBe(3);
    expect((db.prepare(`SELECT COUNT(*) c FROM orders WHERE status='done'`).get() as { c: number }).c).toBe(3);
    // T+1：买入 300 股不增可卖；卖出 300 股已从可卖扣除
    const h = holdings(db, uid, '601389');
    expect(h).toMatchObject({ qt: 1000, qs: 700 });
    // 全套审计
    auditGlobal(db);
    for (const id of [uid, ACC.MARKET, ACC.CLEARING, ACC.TAX, ACC.BANK, ACC.EMPLOYER]) auditUser(db, id);
    // matcher 状态已持久化
    expect(configVal(db, 'matcher_rng')).toBeDefined();
    db.close();
  }, 60_000);
});
