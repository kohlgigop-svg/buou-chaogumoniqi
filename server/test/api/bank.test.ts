// test/api/bank.test.ts —— Task 8 API 层：/api/bank/products、/loans（借/还/列）、/api/credit。
// 覆盖鉴权、zod 校验、门槛错误信封、happy path 与信誉流水分页。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { LoanSettlementHook } from '../../src/domain/loans.js';
import { post } from '../../src/core/ledger.js';
import { buildApp } from '../../src/api/app.js';

const PASS = 'p@ssw0rd!9';

let db: DB;
let app: FastifyInstance;
let sid: string;
let uid: number;

beforeEach(async () => {
  db = openDb(':memory:');
  const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 1, genesisMs: Date.UTC(2026, 0, 15, 0, 0, 0),
    settlementHooks: [new LoanSettlementHook({ db, cfg: DEFAULTS })] });
  app = await buildApp({ db, cfg: DEFAULTS, engine });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username: 'banker', password: PASS }, remoteAddress: '1.1.1.1' });
  expect(reg.statusCode).toBe(200);
  const body = reg.json();
  uid = body.user.id as number;
  sid = reg.cookies.find(c => c.name === 'sid')!.value;
});

afterEach(async () => { await app.close(); db.close(); });

describe('/api/bank/products', () => {
  it('未登录 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bank/products' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('初始 600 分：无 creditLow 且返回 20/60/120 三档、日息万 5', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bank/products', cookies: { sid } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.credit).toBe(600);
    expect(body.creditLow).toBe(false);
    // 额度 = 信誉分 × capPerCreditPoint = 600 × 500_000 = 300_000_000 分 = ¥3,000,000
    expect(body.products).toEqual([
      { termDays: 20, rateE6: 500, capCents: 300_000_000 },
      { termDays: 60, rateE6: 500, capCents: 300_000_000 },
      { termDays: 120, rateE6: 500, capCents: 300_000_000 },
    ]);
  });

  it('信誉 <500：creditLow=true 且 products 为空', async () => {
    db.prepare('UPDATE users SET credit = 450 WHERE id = ?').run(uid);
    const res = await app.inject({ method: 'GET', url: '/api/bank/products', cookies: { sid } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ credit: 450, creditLow: true, products: [] });
  });
});

describe('POST /api/bank/loans', () => {
  it('happy path：放款后现金增加、返回 loanId 与贷款列表', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/bank/loans', cookies: { sid },
      payload: { amount: 1_000_000, termDays: 60 } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.loanId).toBeGreaterThan(0);
    expect(body.loans).toHaveLength(1);
    expect(body.loans[0]).toMatchObject({ principal: 1_000_000, outstanding: 1_000_000,
      accruedInterest: 0, owedTotal: 1_000_000, status: 'active', termDays: 60, dueDay: 61 });
    // 现金 = 初始 100,000 + 借款 10,000（分）
    const cash = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as { a: number }).a;
    expect(cash).toBe(DEFAULTS.auth.initialCash + 1_000_000);
  });

  it('金额非正整数 → 400 VALIDATION（zod 信封）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/bank/loans', cookies: { sid },
      payload: { amount: -5, termDays: 60 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION');
  });

  it('超授信额度 → 403 LOAN_LIMIT（额度 = 信誉分 × ¥5,000）', async () => {
    // ⚠️ 额度与杠杆上限都正比于信誉分，取严时谁生效只取决于净资产：
    //    额度 < 杠杆 ⟺ 净资产 > 500_000 × 300 = 150_000_000 分。
    //    默认初始资金 100_000_000 分时杠杆先触发，故先补足净资产 ——
    //    否则这条测到的是 LEVERAGE 而不是 LOAN_LIMIT。
    const topUp = 100_000_000;
    post(db, 1, 0, 'topup', uid, [
      { account: ACC.MARKET, bucket: 'A', amount: -topUp, kind: 'TEST_TOPUP' },
      { account: uid, bucket: 'A', amount: topUp, kind: 'TEST_TOPUP' },
    ]);
    // 600 分 → 额度 300_000_000 分；杠杆上限 = 200_000_000 × 600/300 = 400_000_000 分
    const res = await app.inject({ method: 'POST', url: '/api/bank/loans', cookies: { sid },
      payload: { amount: 300_000_001, termDays: 60 } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('LOAN_LIMIT');
  });

  it('非法期限 → 400 BAD_TERM', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/bank/loans', cookies: { sid },
      payload: { amount: 100_000, termDays: 30 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_TERM');
  });
});

describe('POST /api/bank/loans/:id/repay', () => {
  it('部分还款先冲利息；返回剩余贷款列表', async () => {
    const borrowRes = await app.inject({ method: 'POST', url: '/api/bank/loans', cookies: { sid },
      payload: { amount: 1_000_000, termDays: 120 } });
    const loanId = borrowRes.json().loanId as number;
    // 手工计提 800 分利息，模拟已过 2 日
    db.prepare('UPDATE loans SET accrued_interest = 800 WHERE id = ?').run(loanId);
    const res = await app.inject({ method: 'POST', url: `/api/bank/loans/${loanId}/repay`, cookies: { sid },
      payload: { amount: 500 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ interestPaid: 500, principalPaid: 0, closed: false });
    const l = db.prepare('SELECT accrued_interest a, outstanding o FROM loans WHERE id = ?').get(loanId) as
      { a: number; o: number };
    expect(l).toMatchObject({ a: 300, o: 1_000_000 });
  });

  it('全额还清 → closed=true、status=repaid、信誉 +20（提前）', async () => {
    const borrowRes = await app.inject({ method: 'POST', url: '/api/bank/loans', cookies: { sid },
      payload: { amount: 1_000_000, termDays: 120 } });
    const loanId = borrowRes.json().loanId as number;
    const res = await app.inject({ method: 'POST', url: `/api/bank/loans/${loanId}/repay`, cookies: { sid },
      payload: { amount: 1_000_000 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().closed).toBe(true);
    const l = db.prepare('SELECT status FROM loans WHERE id = ?').get(loanId) as { status: string };
    expect(l.status).toBe('repaid');
    const credit = (db.prepare('SELECT credit c FROM users WHERE id = ?').get(uid) as { c: number }).c;
    expect(credit).toBe(600 + DEFAULTS.credit.repayEarly);
  });

  it('还别人的贷款 → 404 LOAN_NOT_FOUND', async () => {
    const borrowRes = await app.inject({ method: 'POST', url: '/api/bank/loans', cookies: { sid },
      payload: { amount: 1_000_000, termDays: 60 } });
    const loanId = borrowRes.json().loanId as number;
    const other = await app.inject({ method: 'POST', url: '/api/auth/register',
      payload: { username: 'other', password: PASS }, remoteAddress: '2.2.2.2' });
    const otherSid = other.cookies.find(c => c.name === 'sid')!.value;
    const res = await app.inject({ method: 'POST', url: `/api/bank/loans/${loanId}/repay`,
      cookies: { sid: otherSid }, payload: { amount: 100 } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('LOAN_NOT_FOUND');
  });
});

describe('GET /api/credit', () => {
  it('返回当前分与事件流水（含 scoreAfter）', async () => {
    const borrowRes = await app.inject({ method: 'POST', url: '/api/bank/loans', cookies: { sid },
      payload: { amount: 1_000_000, termDays: 120 } });
    const loanId = borrowRes.json().loanId as number;
    await app.inject({ method: 'POST', url: `/api/bank/loans/${loanId}/repay`, cookies: { sid },
      payload: { amount: 1_000_000 } });
    const res = await app.inject({ method: 'GET', url: '/api/credit', cookies: { sid } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.credit).toBe(600 + DEFAULTS.credit.repayEarly);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    expect(body.events[0]).toMatchObject({ delta: DEFAULTS.credit.repayEarly,
      reason: 'REPAY_EARLY', scoreAfter: 600 + DEFAULTS.credit.repayEarly });
  });
});
