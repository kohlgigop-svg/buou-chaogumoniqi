// test/trading/orders.test.ts —— Task 4：下单域（校验/冻结/幂等/撤单），不含撮合。
// 域测试直接构造 engine_state + seedStocks（不跑引擎 tick，价格保持种子值 → 冻结额可精确断言）；
// engineNow 只读 engine_state.last_tick，UPDATE last_tick 即可精确落到任意相位。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { seedStocks } from '../../src/seed/stocks.js';
import { post, balancesOf, auditUser, auditGlobal } from '../../src/core/ledger.js';
import { engineNow, placeOrder, cancelOrder, releaseOrderRemainder, type OrderRow } from '../../src/trading/orders.js';
import { AppError, buildApp } from '../../src/api/app.js';
import { Engine } from '../../src/engine/engine.js';
import type { PlaceOrderInput } from '@pt/shared';

const G = 1_700_000_000_000;
// L 买 600619 100股@158000分：amount=15_800_000, comm=max(500,3950)=3950, tf=158 → 15_804_108
const FREEZE_L = 15_804_108;
// L 买 601389 100股@520分：amount=52_000, comm=max(500,13)=500, tf=1 → 52_501
const FREEZE_E2E = 52_501;
// M 买 601389 200股（现价 520）：ceil(520×1.02)=531, base=106_200, comm=max(500,27)=500, tf=1 → 106_701
const FREEZE_M = 106_701;

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
/** 模拟 API 层调用方式：engineNow → placeOrder */
function place(db: DB, uid: number, req: PlaceOrderInput): { orderId: number; reused: boolean } {
  const en = engineNow(db);
  return placeOrder(db, DEFAULTS, en.day, en.nextTick, en.phase, uid, req);
}
function errCode(fn: () => unknown): string {
  try { fn(); } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  throw new Error('expected AppError, but call succeeded');
}
const lBuy = (over: Partial<PlaceOrderInput> = {}): PlaceOrderInput =>
  ({ code: '600619', side: 'B', type: 'L', price: 158_000, qty: 100, clientKey: 'k-' + Math.trunc(performance.now() * 1000) + '-' + seq++, ...over }) as PlaceOrderInput;
let seq = 0;

describe('engineNow', () => {
  it('由 last_tick 推 nextTick 及其 day/tickInDay/phase', () => {
    const db = mkDb();
    expect(engineNow(db)).toEqual({ lastTick: -1, nextTick: 0, day: 1, tickInDay: 0, phase: 'auction_open' });
    setTick(db, 58);
    expect(engineNow(db)).toEqual({ lastTick: 58, nextTick: 59, day: 1, tickInDay: 59, phase: 'auction_open' });
    setTick(db, 120);
    expect(engineNow(db)).toEqual({ lastTick: 120, nextTick: 121, day: 1, tickInDay: 121, phase: 'continuous' });
    setTick(db, 1158);
    expect(engineNow(db).phase).toBe('continuous');       // nextTick=1159 连续竞价末 tick
    setTick(db, 1159);
    expect(engineNow(db).phase).toBe('auction_close');    // nextTick=1160
    setTick(db, 1179);
    expect(engineNow(db).phase).toBe('settlement');       // nextTick=1180
    setTick(db, 1185);
    expect(engineNow(db)).toEqual({ lastTick: 1185, nextTick: 1186, day: 1, tickInDay: 1186, phase: 'settlement' });
    setTick(db, 1199);
    expect(engineNow(db)).toEqual({ lastTick: 1199, nextTick: 1200, day: 2, tickInDay: 0, phase: 'auction_open' });
    db.close();
  });
});

describe('placeOrder 相位准入', () => {
  let db: DB; let uid: number;
  beforeEach(() => { db = mkDb(); uid = mkUser(db, 'u1', 100_000_000); });
  afterEach(() => { db.close(); });

  it('settlement 相位 → PHASE_CLOSED（L 与 M 均拒）', () => {
    setTick(db, 1185); // nextTick=1186 → settlement
    expect(errCode(() => place(db, uid, lBuy()))).toBe('PHASE_CLOSED');
    expect(errCode(() => place(db, uid, lBuy({ type: 'M', price: undefined })))).toBe('PHASE_CLOSED');
    expect((db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c).toBe(0);
  });

  it('竞价期 M 单 → MARKET_IN_AUCTION（开盘竞价与收盘竞价）', () => {
    // last_tick=-1 → nextTick=0 auction_open
    expect(errCode(() => place(db, uid, lBuy({ type: 'M', price: undefined })))).toBe('MARKET_IN_AUCTION');
    setTick(db, 1164); // nextTick=1165 → auction_close
    expect(errCode(() => place(db, uid, lBuy({ type: 'M', price: undefined })))).toBe('MARKET_IN_AUCTION');
  });

  it('L 单三个交易相位均可挂；M 单仅连续竞价', () => {
    expect(place(db, uid, lBuy()).reused).toBe(false);          // auction_open
    setTick(db, 120);                                           // nextTick=121 continuous
    expect(place(db, uid, lBuy()).reused).toBe(false);
    expect(place(db, uid, lBuy({ type: 'M', price: undefined })).reused).toBe(false);
    setTick(db, 1164);                                          // auction_close
    expect(place(db, uid, lBuy()).reused).toBe(false);
    expect((db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c).toBe(4);
  });
});

describe('placeOrder 标的校验', () => {
  let db: DB; let uid: number;
  beforeEach(() => { db = mkDb(); uid = mkUser(db, 'u1', 100_000_000); });
  afterEach(() => { db.close(); });

  it('无 stocks 行 → UNKNOWN_STOCK', () => {
    expect(errCode(() => place(db, uid, lBuy({ code: '999999' })))).toBe('UNKNOWN_STOCK');
  });
  it('delisted → STOCK_HALTED', () => {
    db.prepare(`UPDATE stocks SET status='delisted' WHERE code='600619'`).run();
    expect(errCode(() => place(db, uid, lBuy()))).toBe('STOCK_HALTED');
  });
  it('listed_day > day（未上市）→ STOCK_HALTED', () => {
    db.prepare(`UPDATE stocks SET listed_day=5 WHERE code='600619'`).run();
    expect(errCode(() => place(db, uid, lBuy()))).toBe('STOCK_HALTED');
  });
  it('st / delisting 正常可交易', () => {
    db.prepare(`UPDATE stocks SET status='st' WHERE code='600619'`).run();
    expect(place(db, uid, lBuy()).reused).toBe(false);
    db.prepare(`UPDATE stocks SET status='delisting' WHERE code='600619'`).run();
    expect(place(db, uid, lBuy()).reused).toBe(false);
  });
});

describe('placeOrder 数量/价格校验', () => {
  let db: DB; let uid: number;
  beforeEach(() => { db = mkDb(); uid = mkUser(db, 'u1', 100_000_000); });
  afterEach(() => { db.close(); });

  it('qty ≤ 0 → BAD_QTY', () => {
    expect(errCode(() => place(db, uid, lBuy({ qty: 0 })))).toBe('BAD_QTY');
    expect(errCode(() => place(db, uid, lBuy({ qty: -100 })))).toBe('BAD_QTY');
  });
  it('买入非 100 整数倍 → BAD_QTY', () => {
    expect(errCode(() => place(db, uid, lBuy({ qty: 150 })))).toBe('BAD_QTY');
    expect(errCode(() => place(db, uid, lBuy({ qty: 99 })))).toBe('BAD_QTY');
  });
  it('卖出零股允许（qty 任意 ≥1）；超 qty_sellable → INSUFFICIENT_POSITION', () => {
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,50,50,0)')
      .run(uid, '600619');
    expect(errCode(() => place(db, uid, lBuy({ side: 'S', qty: 51 })))).toBe('INSUFFICIENT_POSITION');
    expect(place(db, uid, lBuy({ side: 'S', qty: 50 })).reused).toBe(false); // 零股卖出 OK
  });
  it('无持仓行卖出 → INSUFFICIENT_POSITION', () => {
    expect(errCode(() => place(db, uid, lBuy({ side: 'S', qty: 100 })))).toBe('INSUFFICIENT_POSITION');
  });
  it('L 价越出 [limit_down, limit_up] → BAD_PRICE；边界价可挂', () => {
    // 600619 种子价 158_000，SH ±10% → up=173_800, dn=142_200
    expect(errCode(() => place(db, uid, lBuy({ price: 173_900 })))).toBe('BAD_PRICE');
    expect(errCode(() => place(db, uid, lBuy({ price: 142_100 })))).toBe('BAD_PRICE');
    expect(place(db, uid, lBuy({ price: 173_800 })).reused).toBe(false);
    expect(place(db, uid, lBuy({ price: 142_200 })).reused).toBe(false);
  });
});

describe('placeOrder 冻结（精确金额）', () => {
  let db: DB;
  beforeEach(() => { db = mkDb(); });
  afterEach(() => { db.close(); });

  it('L 买 600619 100股@1580元：freeze=15_804_108，A→F 过账、orders 行完整', () => {
    const uid = mkUser(db, 'u1', 20_000_000);
    const { orderId, reused } = place(db, uid, lBuy({ clientKey: 'ck-L' }));
    expect(reused).toBe(false);
    expect(balancesOf(db, uid)).toEqual({ available: 20_000_000 - FREEZE_L, frozen: FREEZE_L });
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId) as OrderRow;
    expect(o).toMatchObject({ user_id: uid, code: '600619', side: 'B', type: 'L', price: 158_000,
      qty: 100, filled: 0, status: 'open', frozen: FREEZE_L, client_key: 'ck-L', day: 1, created_tick: 0 });
    const legs = db.prepare(`SELECT bucket, amount, day, tick, ref_type, ref_id FROM ledger
      WHERE user_id=? AND kind='ORDER_FREEZE' ORDER BY id`).all(uid) as
      { bucket: string; amount: number; day: number; tick: number; ref_type: string; ref_id: number }[];
    expect(legs).toEqual([
      { bucket: 'A', amount: -FREEZE_L, day: 1, tick: 0, ref_type: 'order', ref_id: orderId },
      { bucket: 'F', amount: FREEZE_L, day: 1, tick: 0, ref_type: 'order', ref_id: orderId },
    ]);
    auditUser(db, uid); auditGlobal(db);
  });

  it('INSUFFICIENT_CASH 边界：差 1 分拒、恰好可挂', () => {
    const poor = mkUser(db, 'poor', FREEZE_L - 1);
    expect(errCode(() => place(db, poor, lBuy()))).toBe('INSUFFICIENT_CASH');
    expect((db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c).toBe(0);
    const exact = mkUser(db, 'exact', FREEZE_L);
    expect(place(db, exact, lBuy()).reused).toBe(false);
    expect(balancesOf(db, exact)).toEqual({ available: 0, frozen: FREEZE_L });
  });

  it('M 买按现价加 2% 缓冲逐股向上取整：601389 200股 freeze=106_701', () => {
    const uid = mkUser(db, 'u1', 20_000_000);
    setTick(db, 120); // nextTick=121 continuous（M 单仅连续竞价）；价格未被引擎演化，仍为种子价 520
    const { orderId } = place(db, uid, lBuy({ code: '601389', type: 'M', price: undefined, qty: 200 }));
    expect(balancesOf(db, uid)).toEqual({ available: 20_000_000 - FREEZE_M, frozen: FREEZE_M });
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId) as OrderRow;
    expect(o).toMatchObject({ type: 'M', price: null, qty: 200, frozen: FREEZE_M, day: 1, created_tick: 121 });
    const legs = db.prepare(`SELECT bucket, amount, tick FROM ledger WHERE user_id=? AND kind='ORDER_FREEZE' ORDER BY id`)
      .all(uid) as { bucket: string; amount: number; tick: number }[];
    expect(legs).toEqual([
      { bucket: 'A', amount: -FREEZE_M, tick: 121 },
      { bucket: 'F', amount: FREEZE_M, tick: 121 },
    ]);
    auditUser(db, uid); auditGlobal(db);
  });

  it('M 买 INSUFFICIENT_CASH 用缓冲后金额判断', () => {
    const uid = mkUser(db, 'u1', FREEZE_M - 1);
    setTick(db, 120);
    expect(errCode(() => place(db, uid, lBuy({ code: '601389', type: 'M', price: undefined, qty: 200 }))))
      .toBe('INSUFFICIENT_CASH');
  });

  it('卖单不冻结现金：frozen=0、无 ledger、qty_sellable 扣减', () => {
    const uid = mkUser(db, 'u1', 0);
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,500,500,0)')
      .run(uid, '600619');
    const { orderId } = place(db, uid, lBuy({ side: 'S', qty: 300 }));
    const o = db.prepare('SELECT frozen, status FROM orders WHERE id=?').get(orderId) as { frozen: number; status: string };
    expect(o).toEqual({ frozen: 0, status: 'open' });
    expect((db.prepare('SELECT COUNT(*) c FROM ledger WHERE user_id=?').get(uid) as { c: number }).c).toBe(0);
    const h = db.prepare('SELECT qty_total qt, qty_sellable qs FROM holdings WHERE user_id=?').get(uid) as
      { qt: number; qs: number };
    expect(h).toEqual({ qt: 500, qs: 200 });
  });
});

describe('幂等（user_id, client_key）', () => {
  let db: DB; let uid: number;
  beforeEach(() => { db = mkDb(); uid = mkUser(db, 'u1', 100_000_000); });
  afterEach(() => { db.close(); });

  it('同 clientKey 二发：同 orderId、reused=true、只有一次冻结', () => {
    const req = lBuy({ clientKey: 'same-key' });
    const first = place(db, uid, req);
    expect(first.reused).toBe(false);
    const balAfter = balancesOf(db, uid);
    const second = place(db, uid, req);
    expect(second).toEqual({ orderId: first.orderId, reused: true });
    expect(balancesOf(db, uid)).toEqual(balAfter); // 不重复冻结
    expect((db.prepare(`SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='ORDER_FREEZE'`).get(uid) as
      { c: number }).c).toBe(2); // 一次过账 = A/F 两腿
    expect((db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c).toBe(1);
  });

  it('重放无视既有单状态（撤单后仍 reused）与当前相位', () => {
    const req = lBuy({ clientKey: 'replay-key' });
    const { orderId } = place(db, uid, req);
    cancelOrder(db, uid, orderId);
    expect(place(db, uid, req)).toEqual({ orderId, reused: true });
    setTick(db, 1185); // settlement：重放仍返回既有单，而非 PHASE_CLOSED
    expect(place(db, uid, req)).toEqual({ orderId, reused: true });
  });

  it('不同用户同 clientKey 互不影响', () => {
    const uid2 = mkUser(db, 'u2', 100_000_000);
    const a = place(db, uid, lBuy({ clientKey: 'shared' }));
    const b = place(db, uid2, lBuy({ clientKey: 'shared' }));
    expect(b.reused).toBe(false);
    expect(b.orderId).not.toBe(a.orderId);
  });
});

describe('cancelOrder / releaseOrderRemainder', () => {
  let db: DB; let uid: number;
  beforeEach(() => { db = mkDb(); uid = mkUser(db, 'u1', 20_000_000); });
  afterEach(() => { db.close(); });

  it('撤买单：全额解冻 F→A，余额精确恢复，status=cancelled', () => {
    const { orderId } = place(db, uid, lBuy());
    cancelOrder(db, uid, orderId);
    expect(balancesOf(db, uid)).toEqual({ available: 20_000_000, frozen: 0 });
    const o = db.prepare('SELECT status, frozen FROM orders WHERE id=?').get(orderId) as
      { status: string; frozen: number };
    expect(o).toEqual({ status: 'cancelled', frozen: 0 });
    const legs = db.prepare(`SELECT bucket, amount FROM ledger WHERE user_id=? AND kind='ORDER_UNFREEZE' ORDER BY id`)
      .all(uid) as { bucket: string; amount: number }[];
    expect(legs).toEqual([
      { bucket: 'F', amount: -FREEZE_L },
      { bucket: 'A', amount: FREEZE_L },
    ]);
    auditUser(db, uid); auditGlobal(db);
  });

  it('撤卖单：qty_sellable 还原未成交部分；frozen=0 不产生 UNFREEZE ledger', () => {
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,500,500,0)')
      .run(uid, '600619');
    const { orderId } = place(db, uid, lBuy({ side: 'S', qty: 300 }));
    expect((db.prepare('SELECT qty_sellable qs FROM holdings WHERE user_id=?').get(uid) as { qs: number }).qs).toBe(200);
    cancelOrder(db, uid, orderId);
    expect((db.prepare('SELECT qty_sellable qs FROM holdings WHERE user_id=?').get(uid) as { qs: number }).qs).toBe(500);
    expect((db.prepare(`SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='ORDER_UNFREEZE'`).get(uid) as
      { c: number }).c).toBe(0);
    expect((db.prepare('SELECT status s FROM orders WHERE id=?').get(orderId) as { s: string }).s).toBe('cancelled');
  });

  it('撤部分成交卖单：只还原 qty − filled', () => {
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,500,500,0)')
      .run(uid, '600619');
    const { orderId } = place(db, uid, lBuy({ side: 'S', qty: 300 }));
    db.prepare('UPDATE orders SET filled=100 WHERE id=?').run(orderId); // 模拟撮合已成交 100
    cancelOrder(db, uid, orderId);
    expect((db.prepare('SELECT qty_sellable qs FROM holdings WHERE user_id=?').get(uid) as { qs: number }).qs).toBe(400);
  });

  it('非本人 → NOT_FOUND；不存在 → NOT_FOUND；非 open → NOT_CANCELLABLE', () => {
    const stranger = mkUser(db, 'u2', 20_000_000);
    const { orderId } = place(db, uid, lBuy());
    expect(errCode(() => cancelOrder(db, stranger, orderId))).toBe('NOT_FOUND');
    expect(errCode(() => cancelOrder(db, uid, 99_999))).toBe('NOT_FOUND');
    cancelOrder(db, uid, orderId);
    expect(errCode(() => cancelOrder(db, uid, orderId))).toBe('NOT_CANCELLABLE');
    db.prepare(`UPDATE orders SET status='done' WHERE id=?`).run(orderId);
    expect(errCode(() => cancelOrder(db, uid, orderId))).toBe('NOT_CANCELLABLE');
  });

  it('releaseOrderRemainder（买）：解冻剩余 frozen、frozen=0、不改 status', () => {
    const { orderId } = place(db, uid, lBuy());
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId) as OrderRow;
    releaseOrderRemainder(db, o, 1, 42);
    expect(balancesOf(db, uid)).toEqual({ available: 20_000_000, frozen: 0 });
    const after = db.prepare('SELECT status, frozen FROM orders WHERE id=?').get(orderId) as
      { status: string; frozen: number };
    expect(after).toEqual({ status: 'open', frozen: 0 }); // status 由调用方负责
    const legs = db.prepare(`SELECT bucket, amount, day, tick FROM ledger WHERE user_id=? AND kind='ORDER_UNFREEZE' ORDER BY id`)
      .all(uid) as { bucket: string; amount: number; day: number; tick: number }[];
    expect(legs).toEqual([
      { bucket: 'F', amount: -FREEZE_L, day: 1, tick: 42 },
      { bucket: 'A', amount: FREEZE_L, day: 1, tick: 42 },
    ]);
    // frozen 已 0：再次调用为 no-op（不再过账）
    const o2 = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId) as OrderRow;
    releaseOrderRemainder(db, o2, 1, 43);
    expect((db.prepare(`SELECT COUNT(*) c FROM ledger WHERE user_id=? AND kind='ORDER_UNFREEZE'`).get(uid) as
      { c: number }).c).toBe(2);
    auditUser(db, uid); auditGlobal(db);
  });

  it('releaseOrderRemainder（卖，含部分成交）：qty_sellable += qty−filled、不改 status', () => {
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,500,500,0)')
      .run(uid, '600619');
    const { orderId } = place(db, uid, lBuy({ side: 'S', qty: 300 }));
    db.prepare('UPDATE orders SET filled=120 WHERE id=?').run(orderId);
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId) as OrderRow;
    releaseOrderRemainder(db, o, 1, 42);
    expect((db.prepare('SELECT qty_sellable qs FROM holdings WHERE user_id=?').get(uid) as { qs: number }).qs).toBe(380);
    expect((db.prepare('SELECT status s FROM orders WHERE id=?').get(orderId) as { s: string }).s).toBe('open');
  });
});

describe('API e2e：POST /api/orders + DELETE /api/orders/:id', () => {
  let db: DB;
  let app: FastifyInstance;
  let sid: string;
  let uid: number;

  beforeEach(async () => {
    db = openDb(':memory:');
    const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 20260828, genesisMs: G }); // genesis: last_tick=-1 → nextTick=0 auction_open
    app = await buildApp({ db, cfg: DEFAULTS, engine, now: () => G });
    const res = await app.inject({ method: 'POST', url: '/api/auth/register',
      payload: { username: 'trader', password: 'p@ssw0rd!9' }, remoteAddress: '1.2.3.4' });
    expect(res.statusCode).toBe(200);
    uid = res.json().user.id as number;
    sid = res.cookies.find(c => c.name === 'sid')!.value;
  });
  afterEach(async () => { await app.close(); db.close(); });

  const orderBody = { code: '601389', side: 'B', type: 'L', price: 520, qty: 100, clientKey: 'e2e-1' };

  it('登录下单→幂等重放→撤单：余额闭环', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/orders', cookies: { sid }, payload: orderBody });
    expect(r1.statusCode).toBe(200);
    const { orderId, reused } = r1.json() as { orderId: number; reused: boolean };
    expect(reused).toBe(false);
    expect(balancesOf(db, uid)).toEqual({ available: 10_000_000 - FREEZE_E2E, frozen: FREEZE_E2E });
    // 幂等重放
    const r2 = await app.inject({ method: 'POST', url: '/api/orders', cookies: { sid }, payload: orderBody });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({ orderId, reused: true });
    expect(balancesOf(db, uid)).toEqual({ available: 10_000_000 - FREEZE_E2E, frozen: FREEZE_E2E });
    // 撤单 204 无 body
    const r3 = await app.inject({ method: 'DELETE', url: `/api/orders/${orderId}`, cookies: { sid } });
    expect(r3.statusCode).toBe(204);
    expect(r3.body).toBe('');
    expect(balancesOf(db, uid)).toEqual({ available: 10_000_000, frozen: 0 });
    // 再撤 → 409 NOT_CANCELLABLE
    const r4 = await app.inject({ method: 'DELETE', url: `/api/orders/${orderId}`, cookies: { sid } });
    expect(r4.statusCode).toBe(409);
    expect(r4.json().code).toBe('NOT_CANCELLABLE');
  });

  it('未登录 → 401；zod 违例（M 单带 price）→ 400 VALIDATION', async () => {
    const noAuth = await app.inject({ method: 'POST', url: '/api/orders', payload: orderBody });
    expect(noAuth.statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/api/orders', cookies: { sid },
      payload: { ...orderBody, type: 'M' } }); // M 单 price 必空 → refine 拒
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('VALIDATION');
    const badDel = await app.inject({ method: 'DELETE', url: '/api/orders/abc', cookies: { sid } });
    expect(badDel.statusCode).toBe(400);
  });

  it('域错误经错误信封映射：INSUFFICIENT_CASH 400 / UNKNOWN_STOCK 404 / PHASE_CLOSED 400', async () => {
    const rich = await app.inject({ method: 'POST', url: '/api/orders', cookies: { sid },
      payload: { code: '600619', side: 'B', type: 'L', price: 158_000, qty: 100, clientKey: 'e2e-cash' } });
    expect(rich.statusCode).toBe(400);          // 初始 10万元 < 冻结 15.8万+费
    expect(rich.json().code).toBe('INSUFFICIENT_CASH');
    const unk = await app.inject({ method: 'POST', url: '/api/orders', cookies: { sid },
      payload: { ...orderBody, code: '999999', clientKey: 'e2e-unk' } });
    expect(unk.statusCode).toBe(404);
    expect(unk.json().code).toBe('UNKNOWN_STOCK');
    db.prepare('UPDATE engine_state SET last_tick=1185 WHERE id=1').run(); // nextTick=1186 settlement
    const closed = await app.inject({ method: 'POST', url: '/api/orders', cookies: { sid },
      payload: { ...orderBody, clientKey: 'e2e-phase' } });
    expect(closed.statusCode).toBe(400);
    expect(closed.json().code).toBe('PHASE_CLOSED');
    // 非本人订单 → 404 NOT_FOUND
    const ghost = await app.inject({ method: 'DELETE', url: '/api/orders/424242', cookies: { sid } });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().code).toBe('NOT_FOUND');
  });
});
