// test/api/auth.test.ts —— Task 2：Fastify 骨架 + 注册/登录/会话（app.inject，注入 now() 控时间）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Response as LightMyRequestResponse } from 'light-my-request';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { buildApp } from '../../src/api/app.js';

const DAY_MS = 86_400_000;
const PASS = 'p@ssw0rd!9';

let db: DB;
let app: FastifyInstance;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.UTC(2026, 0, 15, 12, 0, 0); // UTC 日中间，便于同日计数断言
  db = openDb(':memory:');
  const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 1, genesisMs: Date.UTC(2026, 0, 15, 0, 0, 0) });
  app = await buildApp({ db, cfg: DEFAULTS, engine, now: () => nowMs });
});

afterEach(async () => {
  await app.close();
  db.close();
});

function sidOf(res: LightMyRequestResponse): string {
  const c = res.cookies.find(c => c.name === 'sid');
  expect(c, 'expected sid Set-Cookie').toBeTruthy();
  return c!.value;
}

async function register(username: string, ip: string, password = PASS): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username, password }, remoteAddress: ip });
}
async function login(username: string, password: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}
async function me(sid: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: '/api/me', cookies: { sid } });
}

describe('healthz', () => {
  it('无鉴权返回 ok/day/lastTick', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, day: 1, lastTick: -1 });
  });
});

describe('register', () => {
  it('happy path：200 + 自动登录 cookie + me 200 + GENESIS ledger + 6 abilities', async () => {
    const res = await register('alice', '1.1.1.1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({ username: 'alice', credit: 600, isAdmin: false, bankruptCount: 0 });
    const uid = body.user.id as number;
    // cookie 属性
    const cookie = res.cookies.find(c => c.name === 'sid')!;
    expect(cookie).toBeTruthy();
    expect(cookie.httpOnly).toBe(true);
    expect((cookie.sameSite ?? '').toLowerCase()).toBe('lax');
    expect(cookie.path).toBe('/');
    expect(cookie.value).toMatch(/^[0-9a-f]{64}$/);
    // 自动登录
    const m = await me(cookie.value);
    expect(m.statusCode).toBe(200);
    expect(m.json().user).toMatchObject({ id: uid, username: 'alice', credit: 600, isAdmin: false, bankruptCount: 0 });
    // GENESIS ledger：用户一条 +initialCash，MARKET 对应 -initialCash
    const CASH = DEFAULTS.auth.initialCash;
    const rows = db.prepare(`SELECT amount, bucket, day FROM ledger WHERE user_id=? AND kind='GENESIS'`).all(uid) as
      { amount: number; bucket: string; day: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: CASH, bucket: 'A', day: 1 });
    const mkt = db.prepare(`SELECT amount FROM ledger WHERE user_id=? AND kind='GENESIS'`).all(ACC.MARKET) as { amount: number }[];
    expect(mkt).toHaveLength(1);
    expect(mkt[0]!.amount).toBe(-CASH);
    // 现金余额与用户行
    const u = db.prepare('SELECT cash_available a, cash_frozen f, created_day cd, reg_ip FROM users WHERE id=?').get(uid) as
      { a: number; f: number; cd: number; reg_ip: string };
    expect(u.a).toBe(CASH);
    expect(u.f).toBe(0);
    expect(u.cd).toBe(1);
    expect(u.reg_ip).toBe('1.1.1.1');
    // abilities 6 行 level 0
    const ab = db.prepare('SELECT kind, level FROM abilities WHERE user_id=? ORDER BY kind').all(uid) as
      { kind: string; level: number }[];
    expect(ab).toHaveLength(6);
    expect(ab.map(a => a.kind).sort()).toEqual(['CODE', 'COMM', 'DESIGN', 'EDU', 'FIN', 'FIT']);
    expect(ab.every(a => a.level === 0)).toBe(true);
  });

  it('重名 → 409 USERNAME_TAKEN，且不留下半截数据', async () => {
    expect((await register('bob', '1.1.1.2')).statusCode).toBe(200);
    const res = await register('bob', '1.1.1.3');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('USERNAME_TAKEN');
    const n = (db.prepare(`SELECT COUNT(*) c FROM users WHERE username='bob'`).get() as { c: number }).c;
    expect(n).toBe(1);
    // 事务回滚：第二次注册不产生新的 GENESIS
    const g = (db.prepare(`SELECT COUNT(*) c FROM ledger WHERE kind='GENESIS'`).get() as { c: number }).c;
    expect(g).toBe(2); // 仅 bob 的一对
  });

  it('弱密码 → 400 VALIDATION', async () => {
    const res = await register('weakpw', '1.1.1.4', 'short');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION');
  });

  it('⚠️ 路由兜底带必须高于业务上限，否则用户看不到 REG_LIMIT', async () => {
    // 兜底带（@fastify/rate-limit，按 IP 每小时的硬上限）若 ≤ ipRegPerDay，
    // 会在业务检查之前先抛 429 RATE_LIMIT：文案错（"请求过于频繁"而非"名额已用完"），
    // 且把 ipRegPerDay 调高也不生效。这条断言把两者的顺序关系钉死。
    const cap = DEFAULTS.auth.ipRegPerDay;
    for (let i = 1; i <= cap; i++) {
      expect((await register(`band${i}`, '7.7.7.7')).statusCode).toBe(200);
    }
    const over = await register(`band${cap + 1}`, '7.7.7.7');
    expect(over.statusCode).toBe(429);
    // 必须是业务码，不是限流码 —— 顺序错误时这里会拿到 RATE_LIMIT
    expect(over.json().code).toBe('REG_LIMIT');
  });

  it('同 IP 同 UTC 日第 21 个 → 429 REG_LIMIT；次日恢复', async () => {
    const cap = DEFAULTS.auth.ipRegPerDay;
    expect(cap).toBe(20);
    for (let i = 1; i <= cap; i++) {
      const r = await register(`ipuser${i}`, '9.9.9.9');
      expect(r.statusCode).toBe(200);
    }
    const over = await register(`ipuser${cap + 1}`, '9.9.9.9');
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe('REG_LIMIT');
    // 其他 IP 不受影响
    expect((await register('otherip', '9.9.9.8')).statusCode).toBe(200);
    // 跨过 UTC 日界后同 IP 恢复
    nowMs += DAY_MS;
    expect((await register(`ipuser${cap + 1}`, '9.9.9.9')).statusCode).toBe(200);
  });
});

describe('login + lockout', () => {
  it('正确密码登录 → 200 + 新会话 cookie', async () => {
    await register('carol', '2.2.2.1');
    const res = await login('carol', PASS);
    expect(res.statusCode).toBe(200);
    const m = await me(sidOf(res));
    expect(m.statusCode).toBe(200);
    expect(m.json().user.username).toBe('carol');
  });

  it('错密码 → 401 BAD_CREDENTIALS；不存在的用户同样 401', async () => {
    await register('dave', '2.2.2.2');
    const bad = await login('dave', 'wrongpass9');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('BAD_CREDENTIALS');
    const ghost = await login('nobody99', PASS);
    expect(ghost.statusCode).toBe(401);
    expect(ghost.json().code).toBe('BAD_CREDENTIALS');
  });

  it('错 5 次锁定：第 6 次即使密码正确 → 423 LOCKED；到期解锁', async () => {
    await register('erin', '2.2.2.3');
    for (let i = 1; i <= 5; i++) {
      const r = await login('erin', 'wrongpass9');
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toBe('BAD_CREDENTIALS');
    }
    const locked = await login('erin', PASS); // 正确密码也 423
    expect(locked.statusCode).toBe(423);
    expect(locked.json().code).toBe('LOCKED');
    // 锁未到期：仍 423
    nowMs += DEFAULTS.auth.loginLockMin * 60_000 - 1;
    expect((await login('erin', PASS)).statusCode).toBe(423);
    // 到期后成功，并清除 login_attempts 行
    nowMs += 2;
    const ok = await login('erin', PASS);
    expect(ok.statusCode).toBe(200);
    const row = db.prepare('SELECT * FROM login_attempts WHERE username=?').get('erin');
    expect(row).toBeUndefined();
  });
});

describe('sessions', () => {
  it('无 cookie / 伪造 sid → 401 UNAUTHORIZED', async () => {
    const noCookie = await app.inject({ method: 'GET', url: '/api/me' });
    expect(noCookie.statusCode).toBe(401);
    expect(noCookie.json().code).toBe('UNAUTHORIZED');
    const fake = await me('f'.repeat(64));
    expect(fake.statusCode).toBe(401);
  });

  it('logout → 会话行删除，me 401', async () => {
    const sid = sidOf(await register('frank', '3.3.3.1'));
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { sid } });
    expect(out.statusCode).toBe(200);
    const gone = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
    expect(gone).toBeUndefined();
    expect((await me(sid)).statusCode).toBe(401);
  });

  it('滑动续期：剩余 <15 天访问会重置为 30 天；过期 → 401', async () => {
    const sid = sidOf(await register('gina', '3.3.3.2'));
    nowMs += 20 * DAY_MS; // 剩 10 天 < 15 天
    expect((await me(sid)).statusCode).toBe(200);
    const exp = (db.prepare('SELECT expires_at e FROM sessions WHERE id=?').get(sid) as { e: number }).e;
    expect(exp).toBe(nowMs + DEFAULTS.auth.sessionDays * DAY_MS);
    nowMs += 30 * DAY_MS + 1; // 超过新过期时刻
    expect((await me(sid)).statusCode).toBe(401);
  });

  it('banned 用户 → me 403 BANNED', async () => {
    const sid = sidOf(await register('hank', '3.3.3.3'));
    db.prepare(`UPDATE users SET status='banned' WHERE username='hank'`).run();
    const res = await me(sid);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('BANNED');
  });
});

describe('change password', () => {
  it('验旧改新：踢掉其他会话、保留当前；旧密码失效', async () => {
    const sidA = sidOf(await register('iris', '4.4.4.1'));
    const sidB = sidOf(await login('iris', PASS));
    expect(sidA).not.toBe(sidB);
    const res = await app.inject({ method: 'POST', url: '/api/auth/password', cookies: { sid: sidB },
      payload: { oldPassword: PASS, newPassword: 'n3wp@ss!99' } });
    expect(res.statusCode).toBe(200);
    expect((await me(sidA)).statusCode).toBe(401);  // 其他会话被踢
    expect((await me(sidB)).statusCode).toBe(200);  // 当前会话保留
    expect((await login('iris', PASS)).statusCode).toBe(401);       // 旧密码失效
    expect((await login('iris', 'n3wp@ss!99')).statusCode).toBe(200); // 新密码可登录
  });

  it('旧密码错误 → 401，会话不受影响', async () => {
    const sid = sidOf(await register('judy', '4.4.4.2'));
    const res = await app.inject({ method: 'POST', url: '/api/auth/password', cookies: { sid },
      payload: { oldPassword: 'wrongold99', newPassword: 'n3wp@ss!99' } });
    expect(res.statusCode).toBe(401);
    expect((await me(sid)).statusCode).toBe(200);
  });
});
