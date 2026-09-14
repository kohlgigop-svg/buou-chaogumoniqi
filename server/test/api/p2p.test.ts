// test/api/p2p.test.ts —— P2P API 层：找对手方、发起、同意/拒绝、还款、借据列表，
// 以及权限边界（只有双方可见、只有对手方能 accept、只有借款方能 repay）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { buildApp } from '../../src/api/app.js';
import { post } from '../../src/core/ledger.js';

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const PASS = 'p@ssw0rd!9';

let db: DB;
let app: FastifyInstance;
let sidA: string; let idA: number;
let sidB: string; let idB: number;
let sidC: string; let idC: number;

async function register(name: string, ip: string): Promise<{ sid: string; id: number }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username: name, password: PASS }, remoteAddress: ip });
  expect(res.statusCode).toBe(200);
  return { sid: res.cookies.find(c => c.name === 'sid')!.value, id: res.json().user.id as number };
}

beforeEach(async () => {
  db = openDb(':memory:');
  const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 1, genesisMs: GENESIS });
  app = await buildApp({ db, cfg: DEFAULTS, engine, now: () => GENESIS });
  // 不同 IP 避开同 IP 注册名额上限
  ({ sid: sidA, id: idA } = await register('alice', '1.1.1.1'));
  ({ sid: sidB, id: idB } = await register('bob', '2.2.2.2'));
  ({ sid: sidC, id: idC } = await register('carol', '3.3.3.3'));
});

afterEach(async () => { await app.close(); db.close(); });

/** 直接给某用户加钱（走平衡过账），便于测试大额出借。 */
function grant(userId: number, amount: number): void {
  post(db, 1, 0, 'test', userId, [
    { account: ACC.MARKET, bucket: 'A', amount: -amount, kind: 'TEST_GRANT' },
    { account: userId, bucket: 'A', amount, kind: 'TEST_GRANT' },
  ]);
}

describe('GET /api/p2p/players', () => {
  it('未登录 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/p2p/players?q=bob' });
    expect(res.statusCode).toBe(401);
  });

  it('按用户名模糊匹配，排除自己，只回 id/username/credit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/p2p/players?q=bo', cookies: { sid: sidA } });
    expect(res.statusCode).toBe(200);
    const players = res.json().players as { id: number; username: string }[];
    expect(players.map(p => p.username)).toEqual(['bob']);
    expect(players[0]).not.toHaveProperty('cashAvailable');
    expect(players[0]).not.toHaveProperty('pwd_hash');
  });

  it('空查询词 → 400 VALIDATION', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/p2p/players?q=', cookies: { sid: sidA } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION');
  });
});

describe('POST /api/p2p/loans（发起）', () => {
  it('借款方发起 → pending 且双方都看得到；未划款', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidA },
      payload: { role: 'borrow', counterpartyId: idB, principal: 5_000_000,
        repayAmount: 6_000_000, termDays: 30, note: '周转' } });
    expect(res.statusCode).toBe(200);
    const loans = res.json().loans as { status: string; myRole: string }[];
    expect(loans[0]).toMatchObject({ status: 'pending', myRole: 'borrower' });

    const bobView = await app.inject({ method: 'GET', url: '/api/p2p/loans', cookies: { sid: sidB } });
    const bobLoans = bobView.json().loans as { status: string; myRole: string }[];
    expect(bobLoans[0]).toMatchObject({ status: 'pending', myRole: 'lender' });
  });

  it('zod 违例（缺 termDays）→ 400 VALIDATION', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidA },
      payload: { role: 'borrow', counterpartyId: idB, principal: 5_000_000, repayAmount: 5_000_000 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION');
  });

  it('自己借给自己 → 400 P2P_SELF', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidA },
      payload: { role: 'borrow', counterpartyId: idA, principal: 5_000_000,
        repayAmount: 5_000_000, termDays: 30 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('P2P_SELF');
  });

  it('对手方不存在 → 404 P2P_NO_COUNTERPARTY', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidA },
      payload: { role: 'borrow', counterpartyId: 99999, principal: 5_000_000,
        repayAmount: 5_000_000, termDays: 30 } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('P2P_NO_COUNTERPARTY');
  });

  it('⚠️ 同一对玩家重复发起 → 409 P2P_PAIR_BUSY', async () => {
    const body = { role: 'borrow', counterpartyId: idB, principal: 5_000_000,
      repayAmount: 5_000_000, termDays: 30 };
    await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidA }, payload: body });
    const again = await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidA }, payload: body });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('P2P_PAIR_BUSY');
  });
});

describe('POST /api/p2p/loans/:id/accept（生效）', () => {
  async function proposeAB(): Promise<number> {
    grant(idB, 5_000_000);
    const res = await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidB },
      payload: { role: 'lend', counterpartyId: idA, principal: 5_000_000,
        repayAmount: 6_000_000, termDays: 30 } });
    expect(res.statusCode).toBe(200);
    const id = db.prepare('SELECT id FROM p2p_loans ORDER BY id DESC LIMIT 1').get() as { id: number };
    return id.id;
  }

  it('对手方同意 → active，资金划转', async () => {
    const id = await proposeAB();
    const before = (db.prepare('SELECT cash_available a FROM users WHERE id=?').get(idA) as { a: number }).a;
    const res = await app.inject({ method: 'POST', url: `/api/p2p/loans/${id}/accept`, cookies: { sid: sidA } });
    expect(res.statusCode).toBe(200);
    const after = (db.prepare('SELECT cash_available a FROM users WHERE id=?').get(idA) as { a: number }).a;
    expect(after).toBe(before + 5_000_000);
    expect((res.json().loans as { status: string }[])[0]!.status).toBe('active');
  });

  it('⚠️ 第三方 accept → 403 P2P_NOT_COUNTERPARTY', async () => {
    const id = await proposeAB();
    const res = await app.inject({ method: 'POST', url: `/api/p2p/loans/${id}/accept`, cookies: { sid: sidC } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('P2P_NOT_COUNTERPARTY');
  });

  it('重复 accept → 409 P2P_NOT_PENDING', async () => {
    const id = await proposeAB();
    await app.inject({ method: 'POST', url: `/api/p2p/loans/${id}/accept`, cookies: { sid: sidA } });
    const again = await app.inject({ method: 'POST', url: `/api/p2p/loans/${id}/accept`, cookies: { sid: sidA } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('P2P_NOT_PENDING');
  });

  /**
   * ⚠️⚠️ 这条测试是**线上 500 事故**的回归防线，不要删。
   *
   * 背景：`accept` / `reject` 不需要请求体，前端 `api.post(path)` 不传 body。
   * 但 **Chromium 在这条路径上会带 `Content-Type: application/json`**（Node 的
   * fetch 不带），而 Fastify 默认 JSON 解析器在「content-type 是 json 且 body 为空」
   * 时抛 `Body cannot be empty...` → 500 INTERNAL。真实玩家点「同意」必崩。
   *
   * 为什么原有测试抓不到：`app.inject({ url })` **不带 `payload` 时不会设置
   * content-type**，正好绕开了那个分支；前端测试又用 stub，同样绕开。
   * 所以必须显式构造「带 json content-type + 空 body」这一形态。
   */
  it('⚠️ 空 body 但带 content-type: application/json 也必须成功（线上 500 回归）', async () => {
    const id = await proposeAB();
    const res = await app.inject({
      method: 'POST',
      url: `/api/p2p/loans/${id}/accept`,
      cookies: { sid: sidA },
      headers: { 'content-type': 'application/json' },
      payload: '',            // ⚠️ 关键：空 body（浏览器空体 POST 的真实形态）
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().loans[0].status).toBe('active');
  });

  it('⚠️ 不带 content-type 的空体请求同样成功（两种客户端形态都要兼容）', async () => {
    const id = await proposeAB();
    const res = await app.inject({
      method: 'POST', url: `/api/p2p/loans/${id}/accept`, cookies: { sid: sidA },
    });
    expect(res.statusCode).toBe(200);
  });

  it('非法 JSON 仍应 400（新增的解析器不能把错误吞成 200）', async () => {
    const id = await proposeAB();
    const res = await app.inject({
      method: 'POST', url: `/api/p2p/loans/${id}/accept`,
      cookies: { sid: sidA },
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/p2p/loans/:id/reject 与 repay', () => {
  it('对手方拒绝 → rejected，无资金变动', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidA },
      payload: { role: 'borrow', counterpartyId: idB, principal: 5_000_000,
        repayAmount: 6_000_000, termDays: 30 } });
    const loans = res.json().loans as { id: number }[];
    const rej = await app.inject({ method: 'POST', url: `/api/p2p/loans/${loans[0]!.id}/reject`,
      cookies: { sid: sidB } });
    expect(rej.statusCode).toBe(200);
    expect((rej.json().loans as { status: string }[])[0]!.status).toBe('rejected');
  });

  it('⚠️ 非借款方 repay → 403 P2P_NOT_BORROWER', async () => {
    grant(idB, 5_000_000);
    const p = await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidB },
      payload: { role: 'lend', counterpartyId: idA, principal: 5_000_000,
        repayAmount: 6_000_000, termDays: 30 } });
    const id = (p.json().loans as { id: number }[])[0]!.id;
    await app.inject({ method: 'POST', url: `/api/p2p/loans/${id}/accept`, cookies: { sid: sidA } });
    const res = await app.inject({ method: 'POST', url: `/api/p2p/loans/${id}/repay`,
      cookies: { sid: sidB }, payload: { amount: 6_000_000 } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('P2P_NOT_BORROWER');
  });

  it('借款方部分还款 → repaid 累加、status 保持 active', async () => {
    grant(idB, 5_000_000);
    const p = await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidB },
      payload: { role: 'lend', counterpartyId: idA, principal: 5_000_000,
        repayAmount: 6_000_000, termDays: 30 } });
    const id = (p.json().loans as { id: number }[])[0]!.id;
    await app.inject({ method: 'POST', url: `/api/p2p/loans/${id}/accept`, cookies: { sid: sidA } });
    const res = await app.inject({ method: 'POST', url: `/api/p2p/loans/${id}/repay`,
      cookies: { sid: sidA }, payload: { amount: 2_000_000 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().paid).toBe(2_000_000);
    expect(res.json().closed).toBe(false);
    expect((res.json().loans as { status: string }[])[0]!.status).toBe('active');
  });
});

describe('GET /api/p2p/loans 与 limits', () => {
  it('只返回与我相关的借据（第三方看不到）', async () => {
    await app.inject({ method: 'POST', url: '/api/p2p/loans', cookies: { sid: sidA },
      payload: { role: 'borrow', counterpartyId: idB, principal: 5_000_000,
        repayAmount: 6_000_000, termDays: 30 } });
    const carol = await app.inject({ method: 'GET', url: '/api/p2p/loans', cookies: { sid: sidC } });
    expect(carol.json().loans).toEqual([]);
  });

  it('limits 返回配置的条款边界', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/p2p/limits', cookies: { sid: sidA } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      maxPrincipal: DEFAULTS.p2p.maxPrincipal,
      maxTermDays: DEFAULTS.p2p.maxTermDays,
      maxRateMult: DEFAULTS.p2p.maxRateMult,
    });
  });
});
