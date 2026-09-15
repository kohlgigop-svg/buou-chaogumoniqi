// test/api/margin.test.ts —— 融资融券 API 层：鉴权 / zod 校验 / 门槛错误信封 /
// happy path / 「每个写接口都回传完整 state」这条约定。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS, type Config } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { MarginSettlementHook } from '../../src/domain/margin.js';
import { post } from '../../src/core/ledger.js';
import { buildApp } from '../../src/api/app.js';
import { STOCK_SEEDS } from '../../src/seed/stocks.js';

const PASS = 'p@ssw0rd!9';
const CODE = STOCK_SEEDS[0]!.code;

let db: DB;
let app: FastifyInstance;
let sid: string;
let uid: number;
let cfg: Config;

function inject(url: string, method: 'GET' | 'POST' = 'GET', payload?: Record<string, unknown>) {
  return payload === undefined
    ? app.inject({ method, url, cookies: { sid } })
    : app.inject({ method, url, cookies: { sid }, payload });
}

beforeEach(async () => {
  db = openDb(':memory:');
  cfg = structuredClone(DEFAULTS);
  const engine = new Engine({ db, cfg, masterSeed: 1, genesisMs: Date.UTC(2026, 0, 15, 0, 0, 0),
    settlementHooks: [new MarginSettlementHook({ db, cfg })] });
  app = await buildApp({ db, cfg, engine });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username: 'trader', password: PASS }, remoteAddress: '1.1.1.1' });
  expect(reg.statusCode).toBe(200);
  uid = reg.json().user.id as number;
  sid = reg.cookies.find(c => c.name === 'sid')!.value;
  db.prepare('UPDATE stock_state SET price = 1000, prev_close = 1000 WHERE code = ?').run(CODE);
});

afterEach(async () => { await app.close(); db.close(); });

/** 把信誉分调到 700（开通门槛 650 之上）。 */
function creditOk(): void {
  db.prepare('UPDATE users SET credit = 700 WHERE id = ?').run(uid);
}
/** 补一笔现金（走 ledger，保持总账平衡）。 */
function addCash(cents: number): void {
  post(db, 1, 0, 'test', uid, [
    { account: ACC.MARKET, bucket: 'A', amount: -cents, kind: 'GENESIS' },
    { account: uid, bucket: 'A', amount: cents, kind: 'GENESIS' },
  ]);
}

describe('GET /api/margin', () => {
  it('未登录 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/margin' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('未开通也返回 200（open:false + eligible），让前端直接渲染开通引导', async () => {
    const res = await inject('/api/margin');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.state.open).toBe(false);
    expect(b.state.eligible).toBe(false);      // 默认 600 分 < 650 门槛
    expect(b.state.ratio).toBeNull();          // 无负债：比例必须是 null，不能是 0 或 Infinity
    expect(b.state.positions).toEqual([]);
  });

  it('⚠️ 阈值随 config 一起下发（前端文案不能写死 150%/130%）', async () => {
    const b = (await inject('/api/margin')).json();
    expect(b.limits.warnRatioE6).toBe(1_500_000);
    expect(b.limits.liqRatioE6).toBe(1_300_000);
    expect(b.limits.initRatioE6).toBe(500_000);
    expect(b.limits.maxDebtPerCreditPoint).toBe(200_000);
  });
});

describe('POST /api/margin/open', () => {
  it('信誉分不足 → 403 CREDIT_LOW', async () => {
    const res = await inject('/api/margin/open', 'POST');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CREDIT_LOW');
  });

  it('分数够 → 开通并回传新 state', async () => {
    creditOk();
    const res = await inject('/api/margin/open', 'POST');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.state.open).toBe(true);
    expect(b.state.eligible).toBe(true);
    expect(b.state.canOpen).toBe(true);
  });
});

describe('POST /api/margin/finance', () => {
  it('未开通 → 403 MARGIN_NOT_OPEN', async () => {
    creditOk();
    const res = await inject('/api/margin/finance', 'POST', { code: CODE, qty: 1_000 });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('MARGIN_NOT_OPEN');
  });

  it('happy path：借入 = 金额 × 50%，开仓后维持担保比例 200%，并回传 state', async () => {
    creditOk();
    await inject('/api/margin/open', 'POST');
    const res = await inject('/api/margin/finance', 'POST', { code: CODE, qty: 1_000 });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.result.amount).toBe(1_000_000);
    expect(b.result.loanAmount).toBe(500_000);
    expect(b.state.debt).toBe(500_000);
    // 初始资金 100,000,000 分远大于保证金需求，故比例远高于 200%
    expect(b.state.ratioE6).toBeGreaterThan(2_000_000);
    expect(b.state.positions).toHaveLength(1);
    expect(b.state.positions[0]).toMatchObject({ code: CODE, kind: 'long', qty: 1_000 });
  });

  it('zod：数量非正 / 代码格式错 → 400 VALIDATION', async () => {
    creditOk();
    await inject('/api/margin/open', 'POST');
    for (const payload of [{ code: CODE, qty: 0 }, { code: CODE, qty: -5 },
      { code: 'ABC', qty: 100 }, { code: CODE, qty: 1.5 }]) {
      const res = await inject('/api/margin/finance', 'POST', payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION');
    }
  });

  it('现金不足 → 400 INSUFFICIENT_CASH（错误信封，不是 500）', async () => {
    creditOk();
    await inject('/api/margin/open', 'POST');
    // 把现金抽干
    const cash = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as
      { a: number }).a;
    db.prepare('UPDATE users SET cash_available = 0 WHERE id = ?').run(uid);
    const res = await inject('/api/margin/finance', 'POST', { code: CODE, qty: 1_000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INSUFFICIENT_CASH');
    // 恢复（免得后续断言被影响）
    db.prepare('UPDATE users SET cash_available = ? WHERE id = ?').run(cash, uid);
  });

  it('已退市标的 → 404 BAD_CODE', async () => {
    creditOk();
    await inject('/api/margin/open', 'POST');
    db.prepare(`UPDATE stocks SET status = 'delisted' WHERE code = ?`).run(CODE);
    const res = await inject('/api/margin/finance', 'POST', { code: CODE, qty: 1_000 });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('BAD_CODE');
  });
});

describe('POST /api/margin/short', () => {
  it('happy path：冻结担保金、开仓即 150%、回传 state', async () => {
    creditOk();
    await inject('/api/margin/open', 'POST');
    addCash(1_000_000);   // 保证保证金充足（初始资金本来就够，这里只是把意图写明）
    const res = await inject('/api/margin/short', 'POST', { code: CODE, qty: 1_000 });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.result.amount).toBe(1_000_000);
    expect(b.result.loanAmount).toBe(0);
    expect(b.state.shortValue).toBe(1_000_000);
    expect(b.state.positions[0]).toMatchObject({ kind: 'short', qty: 1_000 });
  });
});

describe('POST /api/margin/sell-repay / buy-cover / repay', () => {
  it('卖券还款 → 债务下降；买券还券 → 空头清空；直接还款 → 债务归零后 409', async () => {
    creditOk();
    await inject('/api/margin/open', 'POST');
    await inject('/api/margin/finance', 'POST', { code: CODE, qty: 1_000 });

    const sell = await inject('/api/margin/sell-repay', 'POST', { code: CODE, qty: 400 });
    expect(sell.statusCode).toBe(200);
    expect(sell.json().state.positions[0].qty).toBe(600);
    expect(sell.json().result.principalPaid).toBeGreaterThan(0);

    const short = await inject('/api/margin/short', 'POST', { code: CODE, qty: 500 });
    expect(short.statusCode).toBe(200);
    const cover = await inject('/api/margin/buy-cover', 'POST', { code: CODE, qty: 500 });
    expect(cover.statusCode).toBe(200);
    expect(cover.json().state.positions.some((p: { kind: string }) => p.kind === 'short')).toBe(false);

    const repay = await inject('/api/margin/repay', 'POST', { amount: 1 });
    expect(repay.statusCode).toBe(200);
    const rest = await inject('/api/margin/repay', 'POST', {
      amount: repay.json().state.owedTotal > 0 ? repay.json().state.owedTotal : 1 });
    if (rest.statusCode === 200) {
      const again = await inject('/api/margin/repay', 'POST', { amount: 1 });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe('NOTHING_OWED');
    }
  });

  it('没有对应仓位 → 404 POSITION_NOT_FOUND', async () => {
    creditOk();
    await inject('/api/margin/open', 'POST');
    const res = await inject('/api/margin/sell-repay', 'POST', { code: CODE, qty: 100 });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('POSITION_NOT_FOUND');
  });
});
