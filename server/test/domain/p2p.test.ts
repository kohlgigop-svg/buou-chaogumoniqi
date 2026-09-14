// test/domain/p2p.test.ts —— 玩家间借贷（P2P）：协商 → 生效划款 → 到期自动扣款 →
// 逾期扣信誉 → 破产豁免。
//
// 全部由真实 Engine 日推进驱动结算钩子，不使用假时间（与 loans.test.ts 同套路）。
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS, type Config } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { propose, accept, reject, repayP2p, listP2p, p2pDebtOf, p2pCreditOf,
  P2pSettlementHook } from '../../src/domain/p2p.js';
import { auditGlobal, auditUser, post } from '../../src/core/ledger.js';
import { engineDay } from '../../src/core/clock.js';

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const TICKS_PER_DAY = 1200;

let db: DB;
let engine: Engine;
let hook: P2pSettlementHook;
let cfg: Config;
let lender: number;
let borrower: number;

/** 建一个用户（走 ledger GENESIS，保证总账平衡）。 */
function newUser(name: string, cash: number): number {
  const r = db.prepare(`INSERT INTO users(username, pwd_hash, created_day, created_at)
    VALUES (?, 'x', 1, 0)`).run(name);
  const id = Number(r.lastInsertRowid);
  post(db, 1, 0, 'genesis', id, [
    { account: ACC.MARKET, bucket: 'A', amount: -cash, kind: 'GENESIS' },
    { account: id, bucket: 'A', amount: cash, kind: 'GENESIS' },
  ]);
  return id;
}

function advanceDays(n: number): void {
  const e = engine as unknown as { lastTick: number; advanceOne(t: number, s: boolean): void };
  let done = e.lastTick >= TICKS_PER_DAY - 20
    ? Math.floor(e.lastTick / TICKS_PER_DAY) + 1 : 0;
  for (let i = 0; i < n; i++) {
    done += 1;
    const settle = (done - 1) * TICKS_PER_DAY + 1180;
    e.lastTick = settle - 1;
    e.advanceOne(settle, true);
  }
}

function row(id: number): { status: string; repaid: number; repay_amount: number;
  due_day: number | null; start_day: number | null } {
  return db.prepare('SELECT status, repaid, repay_amount, due_day, start_day FROM p2p_loans WHERE id = ?')
    .get(id) as { status: string; repaid: number; repay_amount: number;
      due_day: number | null; start_day: number | null };
}
function cashOf(id: number): number {
  return (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(id) as { a: number }).a;
}
function creditOf(id: number): number {
  return (db.prepare('SELECT credit c FROM users WHERE id = ?').get(id) as { c: number }).c;
}
/** 花掉现金（通过一次平衡的过账，保持总账零和）。 */
function drain(id: number, to: number): void {
  const a = cashOf(id);
  if (a <= 0) return;
  post(db, 1, 0, 'test', id, [
    { account: id, bucket: 'A', amount: -a, kind: 'TEST_DRAIN' },
    { account: to, bucket: 'A', amount: a, kind: 'TEST_DRAIN' },
  ]);
}

beforeEach(() => {
  db = openDb(':memory:');
  cfg = DEFAULTS;
  hook = new P2pSettlementHook({ db, cfg });
  engine = new Engine({ db, cfg, masterSeed: 7, genesisMs: GENESIS,
    settlementHooks: [hook] });
  lender = newUser('lender', 100_000_000);     // ¥1,000,000
  borrower = newUser('borrower', 10_000_000);  // ¥100,000
});

describe('P2P 发起与协商', () => {
  it('借款方发起 → 借据 pending，此时**不划款**（余额不动）', () => {
    const before = cashOf(lender);
    const id = propose(db, cfg, borrower, {
      role: 'borrow', counterpartyId: lender, principal: 5_000_000,
      repayAmount: 6_000_000, termDays: 30,
    });
    expect(row(id).status).toBe('pending');
    expect(cashOf(lender)).toBe(before);  // 关键：未确认前钱不动
    auditGlobal(db); auditUser(db, lender); auditUser(db, borrower);
  });

  it('出借方发起时资金必须先够；不够直接拒（P2P_INSUFFICIENT_CASH）', () => {
    const poor = newUser('poor', 1_000_000);
    expect(() => propose(db, cfg, poor, {
      role: 'lend', counterpartyId: borrower, principal: 5_000_000,
      repayAmount: 5_000_000, termDays: 30,
    })).toThrowError(/not enough available cash/);
  });

  it('不能自己向自己借（P2P_SELF）', () => {
    expect(() => propose(db, cfg, borrower, {
      role: 'borrow', counterpartyId: borrower, principal: 100, repayAmount: 100, termDays: 1,
    })).toThrowError(/cannot borrow from yourself/);
  });

  it('⚠️ 同一对玩家不能同时有多笔未结清借据（P2P_PAIR_BUSY）', () => {
    propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 5_000_000, termDays: 30 });
    expect(() => propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 5_000_000, termDays: 30 }))
      .toThrowError(/an open p2p loan already exists/);
    // 反向也算同一对
    expect(() => propose(db, cfg, lender, { role: 'lend', counterpartyId: borrower,
      principal: 5_000_000, repayAmount: 5_000_000, termDays: 30 }))
      .toThrowError(/an open p2p loan already exists/);
  });

  it('接受后生效：出借方金额真实划转到借款方（P2P_DRAW）', () => {
    const l0 = cashOf(lender), b0 = cashOf(borrower);
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 30 });
    accept(db, cfg, lender, id);
    expect(cashOf(lender)).toBe(l0 - 5_000_000);
    expect(cashOf(borrower)).toBe(b0 + 5_000_000);
    expect(row(id).status).toBe('active');
    expect(row(id).start_day).not.toBeNull();
    expect(row(id).due_day).toBe(row(id).start_day! + 30);
    auditGlobal(db); auditUser(db, lender); auditUser(db, borrower);
  });

  it('只有对手方能接受（P2P_NOT_COUNTERPARTY）；发起人自己 accept 无效', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 5_000_000, termDays: 30 });
    expect(() => accept(db, cfg, borrower, id)).toThrowError(/only the counterparty can accept/);
  });

  it('⚠️ 接受时出借方钱已被花掉 → 拒绝生效（事务内再查一次）', () => {
    const id = propose(db, cfg, lender, { role: 'lend', counterpartyId: borrower,
      principal: 50_000_000, repayAmount: 55_000_000, termDays: 30 });
    drain(lender, borrower);  // 发起后把钱花掉
    expect(() => accept(db, cfg, borrower, id)).toThrowError(/no longer has enough available cash/);
    expect(row(id).status).toBe('pending');  // 未生效
    auditGlobal(db);
  });

  it('拒绝 → rejected，无资金变动；双方都能终结 pending', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 5_000_000, termDays: 30 });
    const l0 = cashOf(lender);
    reject(db, lender, id);
    expect(row(id).status).toBe('rejected');
    expect(cashOf(lender)).toBe(l0);
    // 发起人撤回自己的申请也算终结
    const id2 = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 5_000_000, termDays: 30 });
    reject(db, borrower, id2);
    expect(row(id2).status).toBe('rejected');
    auditGlobal(db);
  });
});

describe('P2P 条款校验', () => {
  it('单笔本金超上限 → P2P_AMOUNT_LIMIT', () => {
    expect(() => propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: cfg.p2p.maxPrincipal + 1, repayAmount: cfg.p2p.maxPrincipal + 1, termDays: 30 }))
      .toThrowError(/principal exceeds/);
  });

  it('利率超上限 → P2P_RATE_LIMIT', () => {
    const p = 1_000_000;
    expect(() => propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: p, repayAmount: Math.floor(p * cfg.p2p.maxRateMult) + 1, termDays: 30 }))
      .toThrowError(/rate exceeds/);
  });

  it('还本金额小于本金 → P2P_BAD_REPAY', () => {
    expect(() => propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 1_000_000, repayAmount: 999_999, termDays: 30 }))
      .toThrowError(/repay amount must be >= principal/);
  });

  it('周期越界 → P2P_BAD_TERM', () => {
    expect(() => propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 1_000_000, repayAmount: 1_000_000, termDays: cfg.p2p.maxTermDays + 1 }))
      .toThrowError(/term must be within/);
    expect(() => propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 1_000_000, repayAmount: 1_000_000, termDays: 0 }))
      .toThrowError(/term must be within/);
  });
});

describe('P2P 到期自动扣款与信誉', () => {
  it('到期余额充足 → 自动全额划扣，status=repaid', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 3 });
    accept(db, cfg, lender, id);
    // start_day=当日(day 1)，due_day = start_day + term = 4 → 推进到第 4 日结算才清算。
    // （day 编号从 1 起，故推进次数 = due_day）
    const due = row(id).due_day!;
    const l0 = cashOf(lender);
    advanceDays(due);
    expect(row(id).status).toBe('repaid');
    expect(cashOf(lender)).toBe(l0 + 6_000_000);
    auditGlobal(db); auditUser(db, lender); auditUser(db, borrower);
  });

  it('⚠️ 到期余额不足 → 能扣多少扣多少，进入 grace 且**不扣信誉**', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 3 });
    accept(db, cfg, lender, id);
    drain(borrower, lender);  // 把钱花光
    const credit0 = creditOf(borrower);
    const due = row(id).due_day!;
    advanceDays(due);
    expect(row(id).status).toBe('grace');
    expect(cashOf(borrower)).toBe(0);
    expect(creditOf(borrower)).toBe(credit0);  // 宽限期内不惩罚
    auditGlobal(db);
  });

  it('⚠️ 超过宽限期 → overdue 并按日扣借款人信誉', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 3 });
    accept(db, cfg, lender, id);
    drain(borrower, lender);
    const credit0 = creditOf(borrower);
    const due = row(id).due_day!;
    // 推进到 due_day + graceDays + 1：先到期、再走完宽限、进入逾期
    advanceDays(due + cfg.p2p.graceDays + 1);
    expect(row(id).status).toBe('overdue');
    // 至少扣了一次（进入 overdue 那天起算）
    expect(creditOf(borrower)).toBeLessThan(credit0);
    expect(credit0 - creditOf(borrower)).toBeGreaterThanOrEqual(
      Math.abs(cfg.p2p.overduePerDay));
    auditGlobal(db);
  });

  it('逾期后补齐资金 → 下一次结算自动扣清，转 repaid', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 3 });
    accept(db, cfg, lender, id);
    drain(borrower, lender);
    const due = row(id).due_day!;
    advanceDays(due + cfg.p2p.graceDays + 2);
    expect(row(id).status).toBe('overdue');
    // 补钱（走平衡过账）
    post(db, 1, 0, 'test', borrower, [
      { account: ACC.MARKET, bucket: 'A', amount: -6_000_000, kind: 'TEST_REFILL' },
      { account: borrower, bucket: 'A', amount: 6_000_000, kind: 'TEST_REFILL' },
    ]);
    advanceDays(1);
    expect(row(id).status).toBe('repaid');
    auditGlobal(db);
  });
});

describe('P2P 主动还款', () => {
  it('借款方提前全额还款 → repaid 且信誉加分（早于 due_day）', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 30 });
    accept(db, cfg, lender, id);
    // 补足资金
    post(db, 1, 0, 'test', borrower, [
      { account: ACC.MARKET, bucket: 'A', amount: -3_000_000, kind: 'TEST_REFILL' },
      { account: borrower, bucket: 'A', amount: 3_000_000, kind: 'TEST_REFILL' },
    ]);
    const credit0 = creditOf(borrower);
    const res = repayP2p(db, cfg, borrower, id, 6_000_000);
    expect(res.closed).toBe(true);
    expect(row(id).status).toBe('repaid');
    expect(creditOf(borrower)).toBe(credit0 + cfg.p2p.repayEarly);
    auditGlobal(db); auditUser(db, lender); auditUser(db, borrower);
  });

  it('部分还款不改变 status，只累加 repaid', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 30 });
    accept(db, cfg, lender, id);
    const res = repayP2p(db, cfg, borrower, id, 2_000_000);
    expect(res.closed).toBe(false);
    expect(row(id).repaid).toBe(2_000_000);
    expect(row(id).status).toBe('active');
    auditGlobal(db);
  });

  it('⚠️ 只有借款方能还款（P2P_NOT_BORROWER）', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 30 });
    accept(db, cfg, lender, id);
    expect(() => repayP2p(db, cfg, lender, id, 6_000_000))
      .toThrowError(/only the borrower repays/);
  });

  it('pending 状态不能还款（P2P_NOT_ACTIVE）', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 30 });
    expect(() => repayP2p(db, cfg, borrower, id, 6_000_000))
      .toThrowError(/has not taken effect/);
  });
});

describe('P2P 视图与债权债务口径', () => {
  it('listP2p 返回双方用户名、我的角色、剩余天数', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 30, note: '周转一下' });
    accept(db, cfg, lender, id);
    const asBorrower = listP2p(db, borrower);
    expect(asBorrower).toHaveLength(1);
    expect(asBorrower[0]!).toMatchObject({ id, myRole: 'borrower', borrowerName: 'borrower',
      lenderName: 'lender', owedTotal: 6_000_000, note: '周转一下' });
    expect(asBorrower[0]!.daysLeft).toBe(30);
    const asLender = listP2p(db, lender);
    expect(asLender).toHaveLength(1);
    expect(asLender[0]!.myRole).toBe('lender');
  });

  it('p2pDebtOf / p2pCreditOf 只计未结清且口径对称', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 30 });
    accept(db, cfg, lender, id);
    expect(p2pDebtOf(db, borrower)).toBe(6_000_000);
    expect(p2pCreditOf(db, lender)).toBe(6_000_000);
    // 未生效（pending）不算负债
    const other = newUser('other', 50_000_000);
    const id2 = propose(db, cfg, other, { role: 'borrow', counterpartyId: lender,
      principal: 1_000_000, repayAmount: 1_000_000, termDays: 30 });
    expect(p2pDebtOf(db, other)).toBe(0);
    accept(db, cfg, lender, id2);
    expect(p2pDebtOf(db, other)).toBe(1_000_000);
    expect(p2pCreditOf(db, lender)).toBe(7_000_000);
  });
});

describe('P2P 破产豁免', () => {
  it('⚠️ 借款人破产 → 未结清 P2P 债务豁免（forgiven），出借方承担损失', () => {
    const id = propose(db, cfg, borrower, { role: 'borrow', counterpartyId: lender,
      principal: 5_000_000, repayAmount: 6_000_000, termDays: 30 });
    accept(db, cfg, lender, id);
    // 模拟借款人破产结算后的状态（NPC loans 破产钩子会置 bankrupt_count 与 credit=basis）
    db.prepare('UPDATE users SET bankrupt_count = 1, credit = ? WHERE id = ?')
      .run(cfg.credit.bankruptcyScore, borrower);
    advanceDays(1);
    expect(row(id).status).toBe('forgiven');
    expect(p2pDebtOf(db, borrower)).toBe(0);
    expect(p2pCreditOf(db, lender)).toBe(0);
    auditGlobal(db);
  });
});
