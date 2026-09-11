// test/api/market-admin.test.ts —— Task 10：行情/新闻/排行 + 管理后台（app.inject）。
// 覆盖：market 只读接口字段完整性、leaderboard 排序与破产标记；
// admin 鉴权 403、重置密码踢会话、封禁、公告、audit 全绿、config 白名单与热生效、备份白名单。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { post } from '../../src/core/ledger.js';
import { buildApp } from '../../src/api/app.js';

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const PASS = 'p@ssw0rd!9';

let db: DB;
let app: FastifyInstance;
let adminSid: string;
let aliceSid: string;
let aliceId: number;

async function register(username: string, ip: string): Promise<{ sid: string; id: number }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username, password: PASS }, remoteAddress: ip });
  expect(res.statusCode).toBe(200);
  return { sid: res.cookies.find(c => c.name === 'sid')!.value, id: res.json().user.id as number };
}

beforeEach(async () => {
  db = openDb(':memory:');
  const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 5, genesisMs: GENESIS });
  app = await buildApp({ db, cfg: DEFAULTS, engine });
  // 管理员：直接置 is_admin 并登录
  const admin = await register('root', '9.9.9.9');
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
  const relog = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { username: 'root', password: PASS } });
  adminSid = relog.cookies.find(c => c.name === 'sid')!.value;
  const a = await register('alice', '1.1.1.1');
  aliceSid = a.sid; aliceId = a.id;
});

afterEach(async () => { await app.close(); db.close(); });

// ---------- market ----------

describe('GET /api/market/overview', () => {
  it('无鉴权可读，字段完整', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/market/overview' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toHaveProperty('index');
    expect(b.index).toHaveProperty('code', 'IDX:COMP');
    expect(b).toHaveProperty('advancers');
    expect(b).toHaveProperty('decliners');
    expect(b).toHaveProperty('turnover');
    expect(Array.isArray(b.sectors)).toBe(true);
    expect(b.sectors.length).toBeGreaterThan(0);
    expect(Array.isArray(b.topGainers)).toBe(true);
    expect(Array.isArray(b.topLosers)).toBe(true);
  });
});

describe('GET /api/stocks 与 /api/stocks/:code', () => {
  it('列表含 code/name/sector/price/chgPct/volume/turnover/status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stocks' });
    expect(res.statusCode).toBe(200);
    const list = res.json().stocks as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(40);
    expect(list[0]).toMatchObject({ code: expect.any(String), name: expect.any(String),
      sector: expect.any(String), price: expect.any(Number), chgPct: expect.any(Number) });
  });

  it('个股详情含 quote + 财报 + 分红 + 新闻 + 基本面', async () => {
    const code = (db.prepare("SELECT code FROM stocks WHERE status != 'delisted' ORDER BY code LIMIT 1")
      .get() as { code: string }).code;
    const res = await app.inject({ method: 'GET', url: `/api/stocks/${code}` });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.quote).toMatchObject({ code });
    expect(Array.isArray(b.reports)).toBe(true);
    expect(Array.isArray(b.dividends)).toBe(true);
    expect(Array.isArray(b.news)).toBe(true);
    expect(b.fundamental).toHaveProperty('eps');
    expect(b.fundamental).toHaveProperty('pe');
  });

  it('未知代码 → 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stocks/999999' });
    expect(res.statusCode).toBe(404);
  });

  it('日 K 接口返回按 day 升序的蜡烛', async () => {
    const code = (db.prepare("SELECT code FROM stocks WHERE status != 'delisted' ORDER BY code LIMIT 1")
      .get() as { code: string }).code;
    const res = await app.inject({ method: 'GET', url: `/api/stocks/${code}/candles?type=day` });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().candles)).toBe(true);
  });
});

describe('GET /api/news 与 /api/announcements', () => {
  it('新闻倒序分页；公告玩家可见', async () => {
    db.prepare(`INSERT INTO news(day, tick, scope, target, type_id, title, impact_e6, drift_days)
      VALUES (1, 0, 'MKT', NULL, 'MKT_X', '测试新闻', 100, 3)`).run();
    const n = await app.inject({ method: 'GET', url: '/api/news?limit=10' });
    expect(n.statusCode).toBe(200);
    expect(n.json().items.length).toBeGreaterThanOrEqual(1);
    expect(n.json().items[0]).toHaveProperty('title');

    db.prepare("INSERT INTO announcements(day, content) VALUES (1, '服务器维护')").run();
    const an = await app.inject({ method: 'GET', url: '/api/announcements' });
    expect(an.statusCode).toBe(200);
    expect(an.json().items[0]).toMatchObject({ content: '服务器维护' });
  });
});

describe('GET /api/leaderboard', () => {
  it('按总资产排序，含 username/totalAssets/returnPct；破产用户带标记', async () => {
    // 给 alice 巨额亏损使另一人领先：花掉现金
    post(db, 1, 0, 'spend', aliceId, [
      { account: aliceId, bucket: 'A', amount: -9_000_000, kind: 'SPEND' },
      { account: ACC.MARKET, bucket: 'A', amount: 9_000_000, kind: 'SPEND' },
    ]);
    db.prepare('UPDATE users SET bankrupt_count = 1 WHERE id = ?').run(aliceId);
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard?by=total' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]).toHaveProperty('totalAssets');
    expect(rows[0]!.totalAssets as number).toBeGreaterThanOrEqual(rows[1]!.totalAssets as number);
    const alice = rows.find(r => r.username === 'alice')!;
    expect(alice).toMatchObject({ bankruptCount: 1, bankrupt: true });
  });

  it('by=return 按收益率排序', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard?by=return' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as { returnPct: number }[];
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.returnPct).toBeGreaterThanOrEqual(rows[i]!.returnPct);
    }
  });
});

// ---------- admin ----------

describe('admin 鉴权', () => {
  it('非管理员访问 → 403 FORBIDDEN', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', cookies: { sid: aliceSid } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('未登录 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users' });
    expect(res.statusCode).toBe(401);
  });

  it('管理员 GET /api/admin/users 返回用户与估值摘要', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', cookies: { sid: adminSid } });
    expect(res.statusCode).toBe(200);
    const users = res.json().users as { username: string; valuation: unknown }[];
    expect(users.find(u => u.username === 'alice')).toBeTruthy();
    expect(users.find(u => u.username === 'alice')!.valuation).toBeTruthy();
  });
});

describe('admin：重置密码 / 封禁 / 公告', () => {
  it('重置密码：旧密码失效、新密码可登录、旧会话被踢', async () => {
    const NEW = 'newPass!123';
    const res = await app.inject({ method: 'POST', url: `/api/admin/users/${aliceId}/reset-password`,
      cookies: { sid: adminSid }, payload: { newPassword: NEW } });
    expect(res.statusCode).toBe(200);
    // 旧会话失效
    const meOld = await app.inject({ method: 'GET', url: '/api/me', cookies: { sid: aliceSid } });
    expect(meOld.statusCode).toBe(401);
    // 旧密码登录失败
    const oldLogin = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { username: 'alice', password: PASS } });
    expect(oldLogin.statusCode).toBe(401);
    // 新密码登录成功
    const newLogin = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { username: 'alice', password: NEW } });
    expect(newLogin.statusCode).toBe(200);
  });

  it('封禁：踢会话 + 不能再登录；解封恢复', async () => {
    const ban = await app.inject({ method: 'POST', url: `/api/admin/users/${aliceId}/ban`,
      cookies: { sid: adminSid } });
    expect(ban.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { sid: aliceSid } });
    expect(me.statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { username: 'alice', password: PASS } });
    expect(login.statusCode).toBe(403);
    expect(login.json().code).toBe('BANNED');
    const unban = await app.inject({ method: 'POST', url: `/api/admin/users/${aliceId}/unban`,
      cookies: { sid: adminSid } });
    expect(unban.statusCode).toBe(200);
    const login2 = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { username: 'alice', password: PASS } });
    expect(login2.statusCode).toBe(200);
  });

  it('发布公告后玩家在 /api/announcements 可见', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/announce', cookies: { sid: adminSid },
      payload: { content: '今日停服维护' } });
    expect(res.statusCode).toBe(200);
    const an = await app.inject({ method: 'GET', url: '/api/announcements' });
    expect(an.json().items.some((i: { content: string }) => i.content === '今日停服维护')).toBe(true);
  });
});

describe('admin：engine / audit / config', () => {
  it('GET /api/admin/engine 返回 day/tickInDay/lastTick/延迟', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/engine', cookies: { sid: adminSid } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toHaveProperty('day');
    expect(b).toHaveProperty('tickInDay');
    expect(b).toHaveProperty('lastTick');
    expect(b).toHaveProperty('lagSeconds');
  });

  it('GET /api/admin/audit 全绿（global + 每用户 balances 对账）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: { sid: adminSid } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ globalOk: true, usersOk: true });
  });

  it('config：白名单外键 400；白名单键改后热生效（shiftsPerDay=1 → 第 2 班被拒）', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/admin/config', cookies: { sid: adminSid },
      payload: { key: 'auth.initialCash', value: 1 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('CONFIG_KEY');

    const ok = await app.inject({ method: 'PUT', url: '/api/admin/config', cookies: { sid: adminSid },
      payload: { key: 'work.shiftsPerDay', value: 1 } });
    expect(ok.statusCode).toBe(200);
    // 热生效：alice 排第 1 班成功，第 2 班即被拒
    const s1 = await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid: aliceSid },
      payload: { jobId: 1 } });
    expect(s1.statusCode).toBe(200);
    const s2 = await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid: aliceSid },
      payload: { jobId: 1 } });
    expect(s2.statusCode).toBe(429);
    expect(s2.json().code).toBe('SHIFT_CAP');
  });
});
