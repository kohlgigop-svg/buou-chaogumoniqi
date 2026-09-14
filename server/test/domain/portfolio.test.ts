// test/domain/portfolio.test.ts —— Task 3：估值口径（valuation/positions）+ /api/me + orders/trades/ledger 倒序分页
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Response as LightMyRequestResponse } from 'light-my-request';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { buildApp } from '../../src/api/app.js';
import { post } from '../../src/core/ledger.js';
import { valuation, positions, todayPnl } from '../../src/domain/portfolio.js';

const DAY_MS = 86_400_000;

let db: DB;
let app: FastifyInstance;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.UTC(2026, 0, 15, 12, 0, 0);
  db = openDb(':memory:');
  const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 1, genesisMs: Date.UTC(2026, 0, 15, 0, 0, 0) });
  app = await buildApp({ db, cfg: DEFAULTS, engine, now: () => nowMs });
});

afterEach(async () => {
  await app.close();
  db.close();
});

// ---------- 直插 SQL 造数工具 ----------

function mkUser(name: string): { id: number; sid: string } {
  const r = db.prepare('INSERT INTO users(username, created_day, created_at) VALUES (?, 1, ?)')
    .run(name, Math.floor(nowMs / 1000));
  const id = Number(r.lastInsertRowid);
  const sid = id.toString(16).padStart(64, '0');
  db.prepare('INSERT INTO sessions(id, user_id, expires_at) VALUES (?,?,?)').run(sid, id, nowMs + 30 * DAY_MS);
  return { id, sid };
}

function mkStock(code: string, name: string, price: number, status = 'normal'): void {
  db.prepare(`INSERT INTO stocks(code, name, board, sector, shares_total, vol_tier, beta, payout_tier, status)
    VALUES (?, ?, 'SH', 'TECH', 1000000, 'M', 1.0, 'M', ?)`).run(code, name, status);
  db.prepare(`INSERT INTO stock_state(code, price, prev_close, limit_up, limit_down, eps_e6, pe, equity_e6, adv)
    VALUES (?, ?, ?, ?, ?, 100, 10.0, 1000000, 10000)`)
    .run(code, price, price, Math.round(price * 1.1), Math.round(price * 0.9));
}

function hold(userId: number, code: string, qtyTotal: number, qtySellable: number, costTotal: number): void {
  db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,?,?,?)')
    .run(userId, code, qtyTotal, qtySellable, costTotal);
}

function mkLoan(userId: number, outstanding: number, accrued: number, status: string): void {
  db.prepare(`INSERT INTO loans(user_id, principal, outstanding, rate_e6, term_days, start_day, due_day, accrued_interest, status)
    VALUES (?, ?, ?, 50000, 30, 1, 31, ?, ?)`).run(userId, outstanding, outstanding, accrued, status);
}

/**
 * 直插一条 P2P 借据。`pair_lo/pair_hi` 是规范化的一对玩家 id —— 唯一索引要用，
 * 直插时也不能漏（否则第二次插同一对不会撞索引，测试就跑偏了）。
 */
function mkP2p(borrowerId: number, lenderId: number, principal: number, repay: number,
    repaid: number, status: string): void {
  const lo = Math.min(borrowerId, lenderId);
  const hi = Math.max(borrowerId, lenderId);
  db.prepare(`INSERT INTO p2p_loans(borrower_id, lender_id, pair_lo, pair_hi, principal,
      repay_amount, term_days, proposed_by, awaiting_id, day_created, start_day, due_day, repaid, status)
    VALUES (?,?,?,?,?,?,30,'borrow',NULL,1,1,31,?,?)`)
    .run(borrowerId, lenderId, lo, hi, principal, repay, repaid, status);
}

function rawLedger(userId: number, bucket: string, kind: string, amount: number): number {
  const r = db.prepare(`INSERT INTO ledger(user_id, bucket, day, tick, kind, amount, balance_after, ref_type, ref_id)
    VALUES (?, ?, 1, 0, ?, ?, 0, 'test', 0)`).run(userId, bucket, kind, amount);
  return Number(r.lastInsertRowid);
}

function mkOrder(userId: number, key: string, status = 'open'): number {
  const r = db.prepare(`INSERT INTO orders(user_id, code, side, type, price, qty, filled, status, frozen, client_key, day, created_tick)
    VALUES (?, 'AAA', 'B', 'L', 1000, 100, 0, ?, 0, ?, 1, 0)`).run(userId, status, key);
  return Number(r.lastInsertRowid);
}

function mkTrade(userId: number, orderId: number): number {
  const r = db.prepare(`INSERT INTO trades(order_id, user_id, code, side, price, qty, commission, stamp, transfer, day, tick)
    VALUES (?, ?, 'AAA', 'B', 1000, 100, 500, 0, 10, 1, 0)`).run(orderId, userId);
  return Number(r.lastInsertRowid);
}

async function get(url: string, sid?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, ...(sid !== undefined ? { cookies: { sid } } : {}) });
}

// ---------- 主场景：现金 8 万可用/2 千冻结、两只持仓一只摘牌、active 贷款 5 万+120 利息、GENESIS 10 万 + RELIEF 2 万 ----------

const EXPECTED_VALUATION = {
  cashAvailable: 8_000_000,
  cashFrozen: 200_000,
  positionsValue: 370_200,          // 300×1234 + 摘牌 0
  loansOutstanding: 5_012_000,      // 5_000_000 + 12_000
  // 本场景没有 P2P 借据，故债权/债务均为 0 —— 但字段必须存在：
  // 净资产口径已经把 P2P 并进来（借出是资产、借入是负债），漏掉会让「有钱借出去」的人净资产凭空少一块。
  p2pDebt: 0,
  p2pCredit: 0,
  totalAssets: 3_558_200,           // 8_000_000+200_000+370_200−5_012_000
  totalInflow: 12_000_000,          // GENESIS 10_000_000 + RELIEF 2_000_000（仅 A 桶正腿）
  returnPct: (3_558_200 - 12_000_000) / 12_000_000,
};

const EXPECTED_POSITIONS = [
  { code: 'AAA', name: 'Alpha Tech', qtyTotal: 300, qtySellable: 200, costTotal: 370_050,
    avgCost: 1234 /* 1233.5 半进 */, price: 1234, pnl: 150, pnlPct: 150 / 370_050 },
  { code: 'DDD', name: 'Dead Co', qtyTotal: 100, qtySellable: 100, costTotal: 80_000,
    avgCost: 800, price: 0 /* 摘牌 0 价 */, pnl: -80_000, pnlPct: -1 },
  { code: 'ZZZ', name: 'Zero Co', qtyTotal: 0, qtySellable: 50, costTotal: 0,
    avgCost: 0 /* 0 股为 0 */, price: 700, pnl: 0, pnlPct: 0 },
];

function buildAlice(): { id: number; sid: string } {
  const alice = mkUser('alice');
  post(db, 1, 0, 'genesis', alice.id, [
    { account: ACC.MARKET, bucket: 'A', amount: -10_000_000, kind: 'GENESIS' },
    { account: alice.id, bucket: 'A', amount: 10_000_000, kind: 'GENESIS' },
  ]);
  post(db, 1, 0, 'relief', alice.id, [
    { account: ACC.BANK, bucket: 'A', amount: -2_000_000, kind: 'RELIEF' },
    { account: alice.id, bucket: 'A', amount: 2_000_000, kind: 'RELIEF' },
  ]);
  rawLedger(alice.id, 'F', 'RELIEF', 5_000);   // F 桶：不计入 totalInflow
  rawLedger(alice.id, 'A', 'RELIEF', -3_000);  // 负腿：不计入
  rawLedger(alice.id, 'A', 'SALARY', 7_000);   // 其他 kind：不计入
  db.prepare('UPDATE users SET cash_available = 8000000, cash_frozen = 200000 WHERE id = ?').run(alice.id);
  mkStock('AAA', 'Alpha Tech', 1234);
  mkStock('DDD', 'Dead Co', 500, 'delisted');
  mkStock('EEE', 'Empty Co', 900);
  mkStock('ZZZ', 'Zero Co', 700);
  hold(alice.id, 'AAA', 300, 200, 370_050);
  hold(alice.id, 'DDD', 100, 100, 80_000);
  hold(alice.id, 'EEE', 0, 0, 0);              // 全 0 行：positions 应排除
  hold(alice.id, 'ZZZ', 0, 50, 0);
  mkLoan(alice.id, 5_000_000, 12_000, 'active');
  mkLoan(alice.id, 777_777, 999, 'repaid');    // 已还清：不计入
  return alice;
}

describe('valuation', () => {
  it('主场景：每个字段精确断言（摘牌 0 价、贷款含利息、totalInflow 仅 A 桶正腿、returnPct 手算）', () => {
    const alice = buildAlice();
    expect(valuation(db, alice.id)).toEqual(EXPECTED_VALUATION);
  });

  it('贷款状态口径：active/grace/overdue 计入，repaid/liquidated/forgiven 不计；totalInflow=0 时 returnPct=0', () => {
    const u = mkUser('loaner');
    mkLoan(u.id, 1_000, 10, 'active');
    mkLoan(u.id, 2_000, 20, 'grace');
    mkLoan(u.id, 3_000, 30, 'overdue');
    mkLoan(u.id, 4_000, 40, 'repaid');
    mkLoan(u.id, 5_000, 50, 'liquidated');
    mkLoan(u.id, 6_000, 60, 'forgiven');
    expect(valuation(db, u.id)).toEqual({
      cashAvailable: 0, cashFrozen: 0, positionsValue: 0,
      loansOutstanding: 6_060, p2pDebt: 0, p2pCredit: 0,
      totalAssets: -6_060, totalInflow: 0, returnPct: 0,
    });
    expect(positions(db, u.id)).toEqual([]);
  });

  it('⚠️ P2P 债权计入资产、债务计入负债（借出的钱不能凭空从净资产里消失）', () => {
    const a = mkUser('p2p-borrower');
    const b = mkUser('p2p-lender');
    // a 向 b 借 10,000 元，谈定还 11,000 元，已还 1,000 元 → a 欠 10,000 元
    mkP2p(a.id, b.id, 1_000_000, 1_100_000, 100_000, 'active');
    // 让两人的现金各自体现「钱已经划过去了」：a 拿到 10,000，b 少掉 10,000
    db.prepare('UPDATE users SET cash_available = 1000000 WHERE id = ?').run(a.id);
    db.prepare('UPDATE users SET cash_available = 0 WHERE id = ?').run(b.id);

    const va = valuation(db, a.id);
    expect(va.p2pDebt).toBe(1_000_000);      // repay_amount − repaid
    expect(va.p2pCredit).toBe(0);
    // 借款人：现金 10,000 − 债 10,000 = 0
    expect(va.totalAssets).toBe(1_000_000 - 1_000_000);

    const vb = valuation(db, b.id);
    expect(vb.p2pCredit).toBe(1_000_000);
    expect(vb.p2pDebt).toBe(0);
    // 出借人：现金 0 + 债权 10,000 = 10,000（净资产守恒：一方负债等于另一方资产）
    expect(vb.totalAssets).toBe(1_000_000);
    expect(va.totalAssets + vb.totalAssets).toBe(1_000_000);
  });

  it('⚠️ 只有已生效的 P2P 计入估值：pending 未划款、终止态已了结', () => {
    const a = mkUser('p2p-status');
    const b = mkUser('p2p-counter');
    mkP2p(a.id, b.id, 1_000_000, 1_100_000, 0, 'active');
    const v = valuation(db, a.id);
    expect(v.p2pDebt).toBe(1_100_000);

    // 换一对玩家再插各种状态：只有 active/grace/overdue 计入。
    const c = mkUser('p2p-c');
    mkP2p(c.id, a.id, 500_000, 500_000, 0, 'grace');
    mkP2p(c.id, b.id, 700_000, 700_000, 0, 'overdue');
    const vc = valuation(db, c.id);
    expect(vc.p2pDebt).toBe(1_200_000);        // 500_000 + 700_000

    const d = mkUser('p2p-d');
    mkP2p(d.id, a.id, 900_000, 900_000, 0, 'pending');   // 还没划款 → 不算
    expect(valuation(db, d.id).p2pDebt).toBe(0);
    expect(valuation(db, d.id).p2pCredit).toBe(0);
  });

  it('P2P 与银行贷款同时存在时两者分别扣减，互不干扰', () => {
    const a = mkUser('mixed');
    const b = mkUser('mixed-counter');
    mkLoan(a.id, 1_000_000, 0, 'active');               // 银行欠 10,000
    mkP2p(a.id, b.id, 2_000_000, 2_000_000, 0, 'active'); // P2P 欠 20,000
    const v = valuation(db, a.id);
    expect(v.loansOutstanding).toBe(1_000_000);
    expect(v.p2pDebt).toBe(2_000_000);
    expect(v.totalAssets).toBe(-3_000_000);
  });
});

describe('positions', () => {
  it('全字段断言：avgCost 半进、摘牌 0 价、pnl/pnlPct、排除 qty_total=0 且 qty_sellable=0 行', () => {
    const alice = buildAlice();
    expect(positions(db, alice.id)).toEqual(EXPECTED_POSITIONS);
  });
});

describe('todayPnl', () => {
  // 当日盈亏 = 持仓当日浮盈（用 prev_close 作日初基准）+ 当日 bucket='A' 现金净流。
  // 这是首页「今日盈亏」的唯一数据源，算错会直接误导用户，故逐条锁死。

  function mkUserOnly(name: string): number {
    const r = db.prepare('INSERT INTO users(username, created_day, created_at) VALUES (?, 1, ?)')
      .run(name, Math.floor(nowMs / 1000));
    return Number(r.lastInsertRowid);
  }

  it('无持仓无流水 → 全 0', () => {
    const uid = mkUserOnly('nobody');
    expect(todayPnl(db, uid, 1)).toEqual({ positionPnl: 0, cashFlow: 0, total: 0 });
  });

  it('⚠️ 持仓浮盈用 (price − prev_close) 而不是成本价', () => {
    const uid = mkUserOnly('holder');
    db.prepare(`INSERT INTO stocks(code, name, board, sector, shares_total, vol_tier, beta, payout_tier, status)
      VALUES ('XX', 'X', 'SH', 'TECH', 1000000, 'M', 1.0, 'M', 'normal')`).run();
    // 昨收 1000，现价 1100 → 每股浮盈 +100
    db.prepare(`INSERT INTO stock_state(code, price, prev_close, limit_up, limit_down, eps_e6, pe, equity_e6, adv)
      VALUES ('XX', 1100, 1000, 1100, 900, 100, 10.0, 1000000, 10000)`).run();
    hold(uid, 'XX', 300, 300, 999_999); // cost_total 故意设成干扰值
    const r = todayPnl(db, uid, 1);
    expect(r.positionPnl).toBe(300 * (1100 - 1000)); // = 30_000，与 cost_total 无关
    expect(r.cashFlow).toBe(0);
    expect(r.total).toBe(30_000);
  });

  it('⚠️ 跌的持仓是负浮盈', () => {
    const uid = mkUserOnly('loser');
    db.prepare(`INSERT INTO stocks(code, name, board, sector, shares_total, vol_tier, beta, payout_tier, status)
      VALUES ('YY', 'Y', 'SH', 'TECH', 1000000, 'M', 1.0, 'M', 'normal')`).run();
    db.prepare(`INSERT INTO stock_state(code, price, prev_close, limit_up, limit_down, eps_e6, pe, equity_e6, adv)
      VALUES ('YY', 900, 1000, 1100, 900, 100, 10.0, 1000000, 10000)`).run();
    hold(uid, 'YY', 100, 100, 100_000);
    expect(todayPnl(db, uid, 1).positionPnl).toBe(-10_000);
  });

  it('⚠️ 退市股按 0 计（与 valuation 口径一致，否则会凭空多出浮盈）', () => {
    const uid = mkUserOnly('delisted');
    db.prepare(`INSERT INTO stocks(code, name, board, sector, shares_total, vol_tier, beta, payout_tier, status)
      VALUES ('DD', 'D', 'SH', 'TECH', 1000000, 'M', 1.0, 'M', 'delisted')`).run();
    db.prepare(`INSERT INTO stock_state(code, price, prev_close, limit_up, limit_down, eps_e6, pe, equity_e6, adv)
      VALUES ('DD', 500, 400, 550, 450, 100, 10.0, 1000000, 10000)`).run();
    hold(uid, 'DD', 100, 100, 40_000);
    expect(todayPnl(db, uid, 1).positionPnl).toBe(0);
  });

  it('⚠️ 只统计「当日」的流水，往日流水不计入', () => {
    const uid = mkUserOnly('timely');
    rawLedgerOnDay(uid, 'A', 'WAGE', 50_000, 1);   // 第 1 日
    rawLedgerOnDay(uid, 'A', 'WAGE', 70_000, 2);   // 第 2 日
    expect(todayPnl(db, uid, 1).cashFlow).toBe(50_000);
    expect(todayPnl(db, uid, 2).cashFlow).toBe(70_000);
  });

  it('⚠️ 只统计 A 桶；F 桶（冻结）不算现金净流', () => {
    const uid = mkUserOnly('buckets');
    rawLedgerOnDay(uid, 'A', 'ORDER_FREEZE', -100_000, 1);
    rawLedgerOnDay(uid, 'F', 'ORDER_FREEZE', 100_000, 1);
    // 冻结是 A→F 的内部搬家，不是当日亏损
    expect(todayPnl(db, uid, 1).cashFlow).toBe(-100_000);
  });

  it('⚠️ 卖出成交的现金腿是正的（含扣费后的净额）', () => {
    const uid = mkUserOnly('seller');
    rawLedgerOnDay(uid, 'A', 'TRADE_SELL', 881_000 - 500 - 440 - 8, 1); // 成交额 − 佣金 − 印花税 − 过户费
    expect(todayPnl(db, uid, 1).cashFlow).toBe(880_052);
  });

  it('持仓与现金合起来 = total', () => {
    const uid = mkUserOnly('both');
    db.prepare(`INSERT INTO stocks(code, name, board, sector, shares_total, vol_tier, beta, payout_tier, status)
      VALUES ('ZZ', 'Z', 'SH', 'TECH', 1000000, 'M', 1.0, 'M', 'normal')`).run();
    db.prepare(`INSERT INTO stock_state(code, price, prev_close, limit_up, limit_down, eps_e6, pe, equity_e6, adv)
      VALUES ('ZZ', 1100, 1000, 1100, 900, 100, 10.0, 1000000, 10000)`).run();
    hold(uid, 'ZZ', 200, 200, 200_000);
    rawLedgerOnDay(uid, 'A', 'TRADE_BUY', -220_000, 1);
    const r = todayPnl(db, uid, 1);
    expect(r.positionPnl).toBe(20_000);
    expect(r.cashFlow).toBe(-220_000);
    expect(r.total).toBe(r.positionPnl + r.cashFlow);
  });
});

/** 在指定 game day 直插一条 ledger（绕过 post()，便于精确控制 day）。
 *  注：既有的 `rawLedger` 固定写 day=1，本组用例要区分「当日 / 往日」，故单独一个。 */
function rawLedgerOnDay(userId: number, bucket: 'A' | 'F', kind: string, amount: number, day: number): void {
  db.prepare(`INSERT INTO ledger(user_id, bucket, day, tick, kind, amount, balance_after, ref_type, ref_id)
    VALUES (?, ?, ?, 0, ?, ?, 0, 'test', 0)`).run(userId, bucket, day, kind, amount);
}

describe('GET /api/me', () => {
  it('返回 { user, valuation, positions, work, todayPnl }', async () => {
    const alice = buildAlice();
    const res = await get('/api/me', alice.sid);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: { id: alice.id, username: 'alice', credit: 600, isAdmin: false, bankruptCount: 0 },
      valuation: EXPECTED_VALUATION,
      positions: EXPECTED_POSITIONS,
      // T9 接通：无排班/课程时为 { busyUntil: 0, shift: null, course: null }
      work: { busyUntil: 0, shift: null, course: null },
      // todayPnl（Task 7 追加）：
      //   cashFlow = 当日 bucket='A' 全部流水合计
      //            = 10,000,000(GENESIS) + 2,000,000(RELIEF) − 3,000(负腿) + 7,000(SALARY)
      //            = 12,004,000
      //   positionPnl = 0：mkStock 把 prev_close 设成等于 price，故当日浮盈为 0
      todayPnl: { positionPnl: 0, cashFlow: 12_004_000, total: 12_004_000 },
    });
  });
});

describe('GET /api/orders 分页', () => {
  function buildOrders(): { pager: { id: number; sid: string }; other: { id: number; sid: string };
      pagerIds: number[]; doneIds: number[]; otherIds: number[] } {
    const pager = mkUser('pager');
    const other = mkUser('other');
    mkStock('AAA', 'Alpha Tech', 1000);
    const pagerIds: number[] = [];
    const doneIds: number[] = [];
    const otherIds: number[] = [];
    const add = (i: number): void => {
      const status = i % 4 === 0 ? 'done' : 'open';
      const id = mkOrder(pager.id, `k${i}`, status);
      pagerIds.push(id);
      if (status === 'done') doneIds.push(id);
    };
    for (let i = 1; i <= 30; i++) add(i);
    for (let i = 1; i <= 5; i++) otherIds.push(mkOrder(other.id, `k${i}`)); // 穿插别人的单
    for (let i = 31; i <= 60; i++) add(i);
    return { pager, other, pagerIds, doneIds, otherIds };
  }

  it('默认 limit 50、id 倒序、before 游标翻页到空', async () => {
    const { pager, pagerIds } = buildOrders();
    const desc = [...pagerIds].reverse();

    const p1 = await get('/api/orders', pager.sid);
    expect(p1.statusCode).toBe(200);
    const b1 = p1.json() as { items: { id: number }[]; nextBefore: number | null };
    expect(b1.items.map(o => o.id)).toEqual(desc.slice(0, 50));
    expect(b1.nextBefore).toBe(desc[49]);

    const p2 = await get(`/api/orders?before=${b1.nextBefore}`, pager.sid);
    const b2 = p2.json() as { items: { id: number }[]; nextBefore: number | null };
    expect(b2.items.map(o => o.id)).toEqual(desc.slice(50)); // 第二页 10 条
    expect(b2.items).toHaveLength(10);
    expect(b2.nextBefore).toBe(desc[59]);

    const p3 = await get(`/api/orders?before=${b2.nextBefore}`, pager.sid);
    expect(p3.json()).toEqual({ items: [], nextBefore: null });
  });

  it('limit 参数生效', async () => {
    const { pager, pagerIds } = buildOrders();
    const desc = [...pagerIds].reverse();
    const res = await get('/api/orders?limit=10', pager.sid);
    const body = res.json() as { items: { id: number }[]; nextBefore: number | null };
    expect(body.items.map(o => o.id)).toEqual(desc.slice(0, 10));
    expect(body.nextBefore).toBe(desc[9]);
  });

  it('status 过滤：只回 done 单', async () => {
    const { pager, doneIds } = buildOrders();
    const res = await get('/api/orders?status=done', pager.sid);
    const body = res.json() as { items: { id: number; status: string }[]; nextBefore: number | null };
    expect(body.items.map(o => o.id)).toEqual([...doneIds].reverse());
    expect(body.items).toHaveLength(15);
    expect(body.items.every(o => o.status === 'done')).toBe(true);
  });

  it('归属强校验：只能看到自己的单；未登录 401', async () => {
    const { other, otherIds } = buildOrders();
    const res = await get('/api/orders', other.sid);
    const body = res.json() as { items: { id: number; user_id: number }[]; nextBefore: number | null };
    expect(body.items.map(o => o.id)).toEqual([...otherIds].reverse());
    expect(body.items.every(o => o.user_id === other.id)).toBe(true);

    const anon = await get('/api/orders');
    expect(anon.statusCode).toBe(401);
    expect(anon.json().code).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/trades 分页', () => {
  it('倒序 + 游标 + 归属', async () => {
    const pager = mkUser('pager');
    const other = mkUser('other');
    mkStock('AAA', 'Alpha Tech', 1000);
    const po = mkOrder(pager.id, 'k1');
    const oo = mkOrder(other.id, 'k1');
    const pagerTrades = [mkTrade(pager.id, po), mkTrade(pager.id, po), mkTrade(pager.id, po)];
    const otherTrades = [mkTrade(other.id, oo), mkTrade(other.id, oo)];
    const desc = [...pagerTrades].reverse();

    const p1 = await get('/api/trades?limit=2', pager.sid);
    const b1 = p1.json() as { items: { id: number }[]; nextBefore: number | null };
    expect(b1.items.map(t => t.id)).toEqual(desc.slice(0, 2));
    expect(b1.nextBefore).toBe(desc[1]);

    const p2 = await get(`/api/trades?limit=2&before=${b1.nextBefore}`, pager.sid);
    const b2 = p2.json() as { items: { id: number }[]; nextBefore: number | null };
    expect(b2.items.map(t => t.id)).toEqual(desc.slice(2));

    const ores = await get('/api/trades', other.sid);
    const ob = ores.json() as { items: { id: number }[]; nextBefore: number | null };
    expect(ob.items.map(t => t.id)).toEqual([...otherTrades].reverse());
  });
});

describe('GET /api/ledger 分页', () => {
  it('limit 上限 200（传 500 只回 200），倒序游标续页 + 归属', async () => {
    const ledgy = mkUser('ledgy');
    const nosy = mkUser('nosy');
    const ids: number[] = [];
    for (let i = 0; i < 250; i++) ids.push(rawLedger(ledgy.id, 'A', 'SALARY', 100 + i));
    const desc = [...ids].reverse();

    const p1 = await get('/api/ledger?limit=500', ledgy.sid);
    expect(p1.statusCode).toBe(200);
    const b1 = p1.json() as { items: { id: number }[]; nextBefore: number | null };
    expect(b1.items).toHaveLength(200);
    expect(b1.items.map(l => l.id)).toEqual(desc.slice(0, 200));
    expect(b1.nextBefore).toBe(desc[199]);

    const p2 = await get(`/api/ledger?limit=500&before=${b1.nextBefore}`, ledgy.sid);
    const b2 = p2.json() as { items: { id: number }[]; nextBefore: number | null };
    expect(b2.items.map(l => l.id)).toEqual(desc.slice(200)); // 剩 50 条
    expect(b2.items).toHaveLength(50);

    const nres = await get('/api/ledger', nosy.sid);
    expect(nres.json()).toEqual({ items: [], nextBefore: null });
  });
});
