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

/**
 * 固定时钟：令游戏日内分钟 = 0（00:00），使「连排两班必然同日」成立，测试不受运行时刻影响。
 * `busyUntil=0` ⇒ 第 1 班 00:00–08:00、第 2 班 08:00–16:00，都在同一游戏日内。
 */
const FIXED_NOW = GENESIS;

async function register(username: string, ip: string): Promise<{ sid: string; id: number }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username, password: PASS }, remoteAddress: ip });
  expect(res.statusCode).toBe(200);
  return { sid: res.cookies.find(c => c.name === 'sid')!.value, id: res.json().user.id as number };
}

beforeEach(async () => {
  db = openDb(':memory:');
  const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 5, genesisMs: GENESIS });
  app = await buildApp({ db, cfg: DEFAULTS, engine, now: () => FIXED_NOW });
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
    //
    // ⚠️ 必须用【固定假时钟】，不能用真实 Date.now。
    // `scheduleShift` 用 `start = max(nowGmin, busyUntil)`，第 2 班从第 1 班的**下班时刻**排起；
    // 一班 8 游戏小时（480 gmin），若第 1 班跨过午夜，第 2 班就落进**下一个游戏日**，
    // 而日上限查询按 `start_gmin` 算天 → 查到新的一天（0 班）→ 不会触发 SHIFT_CAP。
    // 用真实时钟时，游戏日内分钟落在 [960, 1440)（约 1/3 的真实时段）就会失败 ——
    // 历史上这被误判成 flaky。固定时钟落在日内 00:00 起算处即可稳定命中同日。
    const s1 = await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid: aliceSid },
      payload: { jobId: 1 } });
    expect(s1.statusCode).toBe(200);
    const s2 = await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid: aliceSid },
      payload: { jobId: 1 } });
    expect(s2.statusCode).toBe(429);
    expect(s2.json().code).toBe('SHIFT_CAP');
  });

  it('⚠️ 玩家冲击参数可热改（顶层键，不在 trading.* 下）', async () => {
    // 这两个键是「玩家能不能推动盘面」的总开关，运营中要能即时调 —— 若不在白名单里，
    // 出错时只能改库重启，那就等于没有补救手段。
    for (const key of ['playerImpactLambda', 'playerImpactCap']) {
      const res = await app.inject({ method: 'PUT', url: '/api/admin/config', cookies: { sid: adminSid },
        payload: { key, value: key === 'playerImpactLambda' ? 12 : 0.08 } });
      expect(res.statusCode, key).toBe(200);
    }
    const snap = await app.inject({ method: 'GET', url: '/api/admin/config', cookies: { sid: adminSid } });
    const cfg = snap.json().config as { playerImpactLambda: number; playerImpactCap: number };
    expect(cfg.playerImpactLambda).toBe(12);
    expect(cfg.playerImpactCap).toBe(0.08);
  });

  it('⚠️ P2P 条款边界可热改（p2p. 前缀）', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/config', cookies: { sid: adminSid },
      payload: { key: 'p2p.maxTermDays', value: 60 } });
    expect(res.statusCode).toBe(200);
    // 热生效：边界立刻反映在公开的 limits 端点上
    const limits = await app.inject({ method: 'GET', url: '/api/p2p/limits', cookies: { sid: aliceSid } });
    expect(limits.json().maxTermDays).toBe(60);
  });

  it('白名单仍是白名单：auth.initialCash 之类的键依然被拒', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/config', cookies: { sid: adminSid },
      payload: { key: 'auth.initialCash', value: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CONFIG_KEY');
  });
});

// ---------- admin：删除测试账号 ----------

describe('admin：DELETE /api/admin/users/:id（清理测试账号）', () => {
  /** 造一个「干净」的测试账号：只有创世入账，无持仓无挂单。 */
  async function freshUser(name: string, ip: string) {
    return register(name, ip);
  }

  it('删除后：登录 401、管理员列表不再出现、audit 仍全绿', async () => {
    const t = await freshUser('zztest1', '5.5.5.1');
    const before = await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: { sid: adminSid } });
    expect(before.json().globalOk).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/api/admin/users/${t.id}`, cookies: { sid: adminSid } });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);

    // 登录应失败（用户行已不存在）
    const relog = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { username: 'zztest1', password: PASS } });
    expect(relog.statusCode).toBe(401);

    // 列表里不应再有
    const list = await app.inject({ method: 'GET', url: '/api/admin/users?q=zztest1', cookies: { sid: adminSid } });
    expect(list.json().users).toHaveLength(0);

    // ⚠️ 关键：全局账本仍必须平衡（ledger 行保留、users 行删除 → 总额仍为 0）
    const after = await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: { sid: adminSid } });
    expect(after.json().globalOk).toBe(true);
    expect(after.json().usersOk).toBe(true);
  });

  it('⚠️ 持有未平仓订单的用户默认拒删（409 USER_HAS_STATE），需 force=true', async () => {
    const t = await freshUser('zztest2', '5.5.5.2');
    // 造一笔挂单：直接写库（不改动撮合逻辑）
    db.prepare(`INSERT INTO orders(user_id, code, side, type, price, qty, client_key, day, created_tick)
      SELECT ?, code, 'B', 'L', 100, 100, 'k1', 1, 0 FROM stocks LIMIT 1`).run(t.id);

    const del = await app.inject({ method: 'DELETE', url: `/api/admin/users/${t.id}`, cookies: { sid: adminSid } });
    expect(del.statusCode).toBe(409);
    expect(del.json().code).toBe('USER_HAS_STATE');

    const forced = await app.inject({ method: 'DELETE', url: `/api/admin/users/${t.id}?force=true`,
      cookies: { sid: adminSid } });
    expect(forced.statusCode).toBe(200);
  });

  it('⚠️ 不能删管理员自己；不能删系统账号', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/admin/users?q=root', cookies: { sid: adminSid } });
    const myId = me.json().users[0].id as number;
    const self = await app.inject({ method: 'DELETE', url: `/api/admin/users/${myId}`, cookies: { sid: adminSid } });
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe('CANNOT_DELETE_ADMIN');

    // 系统账号 @market 的 id 是 1，kind='system' → 不可删
    const sys = await app.inject({ method: 'DELETE', url: '/api/admin/users/1', cookies: { sid: adminSid } });
    expect(sys.statusCode).toBe(404);
  });

  it('不存在的用户 → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/users/99999', cookies: { sid: adminSid } });
    expect(res.statusCode).toBe(404);
  });

  it('非管理员 → 403', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/admin/users/${aliceId}`, cookies: { sid: aliceSid } });
    expect(res.statusCode).toBe(403);
  });
});

// ---------- admin：测试账号（不占真实注册名额） ----------

describe('admin：测试账号不占 IP 注册名额', () => {
  it('⚠️ 建测试账号后，同 IP 的真实注册名额不被消耗', async () => {
    // 把名额压到 1：这样「真实注册 1 次就满」的边界最容易观察
    await app.inject({ method: 'PUT', url: '/api/admin/config', cookies: { sid: adminSid },
      payload: { key: 'auth.ipRegPerDay', value: 1 } });

    // 用 7.7.7.7 建 3 个测试账号 —— 应当全部成功，且都不占名额
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/admin/test-users', cookies: { sid: adminSid },
        payload: { username: `zztu${i}`, password: PASS }, remoteAddress: '7.7.7.7' });
      expect(r.statusCode).toBe(200);
    }

    // ⚠️ 关键：同 IP 的**真实**注册仍应有 1 个名额（名额没被测试账号吃掉）
    const real = await app.inject({ method: 'POST', url: '/api/auth/register',
      payload: { username: 'zztureal', password: PASS }, remoteAddress: '7.7.7.7' });
    expect(real.statusCode).toBe(200);

    // 再用掉第二个 → 超限
    const over = await app.inject({ method: 'POST', url: '/api/auth/register',
      payload: { username: 'zztureal2', password: PASS }, remoteAddress: '7.7.7.7' });
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe('REG_LIMIT');
  });

  it('测试账号可被列出（reg_ip 带 test: 前缀）', async () => {
    await app.inject({ method: 'POST', url: '/api/admin/test-users', cookies: { sid: adminSid },
      payload: { username: 'zzlisted', password: PASS }, remoteAddress: '7.7.7.8' });
    const res = await app.inject({ method: 'GET', url: '/api/admin/test-users', cookies: { sid: adminSid } });
    expect(res.statusCode).toBe(200);
    expect(res.json().users.map((u: { username: string }) => u.username)).toContain('zzlisted');
  });

  it('⚠️ 测试账号与真实账号走同一建号事务：初始资金一致、audit 全绿', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/admin/test-users', cookies: { sid: adminSid },
      payload: { username: 'zzsame', password: PASS }, remoteAddress: '7.7.7.9' });
    expect(r.statusCode).toBe(200);
    const id = r.json().user.id as number;
    const cash = db.prepare('SELECT cash_available c FROM users WHERE id = ?').get(id) as { c: number };
    expect(cash.c).toBe(DEFAULTS.auth.initialCash);
    // 六项能力已初始化
    const ab = db.prepare('SELECT COUNT(*) c FROM abilities WHERE user_id = ?').get(id) as { c: number };
    expect(ab.c).toBe(6);
    // 账本仍平衡
    const audit = await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: { sid: adminSid } });
    expect(audit.json().globalOk).toBe(true);
    expect(audit.json().usersOk).toBe(true);
  });

  it('非管理员不能建测试账号', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/test-users', cookies: { sid: aliceSid },
      payload: { username: 'zznope', password: PASS } });
    expect(res.statusCode).toBe(403);
  });

  it('用户名冲突 → 409 USERNAME_TAKEN（复用注册的约束语义）', async () => {
    await app.inject({ method: 'POST', url: '/api/admin/test-users', cookies: { sid: adminSid },
      payload: { username: 'zzdup', password: PASS }, remoteAddress: '7.7.7.10' });
    const again = await app.inject({ method: 'POST', url: '/api/admin/test-users', cookies: { sid: adminSid },
      payload: { username: 'zzdup', password: PASS }, remoteAddress: '7.7.7.10' });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('USERNAME_TAKEN');
  });
});

describe('admin：删除有交易记录的账号（外键顺序回归）', () => {
  it('⚠️ 有成交记录的用户也必须能删（trades.order_id → orders 外键）', async () => {
    const t = await register('zztraded', '6.6.6.1');
    // 造一条完整的「挂单 + 成交」链：成交行的 order_id 指向该用户的订单。
    // 这正是线上 4 个真实玩家删不掉的原因 —— 先删 orders 会触发外键约束失败。
    const code = (db.prepare('SELECT code FROM stocks LIMIT 1').get() as { code: string }).code;
    const oid = Number(db.prepare(`INSERT INTO orders(user_id, code, side, type, price, qty, filled,
        status, client_key, day, created_tick)
      VALUES (?,?,'B','L',100,100,100,'done','kt',1,0)`).run(t.id, code).lastInsertRowid);
    db.prepare(`INSERT INTO trades(order_id, user_id, code, side, price, qty,
        commission, stamp, transfer, day, tick)
      VALUES (?,?,?,'B',100,100,0,0,0,1,0)`).run(oid, t.id, code);
    db.prepare('INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total) VALUES (?,?,?,?,?)')
      .run(t.id, code, 100, 100, 10_000);

    // 有持仓 → 需 force
    const blocked = await app.inject({ method: 'DELETE', url: `/api/admin/users/${t.id}`,
      cookies: { sid: adminSid } });
    expect(blocked.statusCode).toBe(409);

    const del = await app.inject({ method: 'DELETE', url: `/api/admin/users/${t.id}?force=true`,
      cookies: { sid: adminSid } });
    // 修复前这里是 500（FOREIGN KEY constraint failed）
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);

    // 成交与挂单都应被清掉，不留孤儿
    expect((db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(t.id) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM trades WHERE user_id = ?').get(t.id) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM holdings WHERE user_id = ?').get(t.id) as { c: number }).c).toBe(0);

    // 账本仍必须平衡
    const audit = await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: { sid: adminSid } });
    expect(audit.json().globalOk).toBe(true);
    expect(audit.json().usersOk).toBe(true);
  });

  it('⚠️ 对手方视角：成交行挂在对方订单上时，删单方也不报外键错', async () => {
    const seller = await register('zzseller', '6.6.6.2');
    const buyer = await register('zzbuyer', '6.6.6.3');
    const code = (db.prepare('SELECT code FROM stocks LIMIT 1').get() as { code: string }).code;
    // 买方挂单，卖方成交：trades.order_id 指向**买方**的订单
    const oid = Number(db.prepare(`INSERT INTO orders(user_id, code, side, type, price, qty, filled,
        status, client_key, day, created_tick)
      VALUES (?,?,'B','L',100,100,100,'done','kb',1,0)`).run(buyer.id, code).lastInsertRowid);
    db.prepare(`INSERT INTO trades(order_id, user_id, code, side, price, qty,
        commission, stamp, transfer, day, tick)
      VALUES (?,?,?,'S',100,100,0,0,0,1,0)`).run(oid, seller.id, code);

    // 删卖方：其成交行挂在买方订单上，必须靠 `order_id IN (...)` 分支清掉
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/users/${seller.id}?force=true`,
      cookies: { sid: adminSid } });
    expect(del.statusCode).toBe(200);
    // 卖方的成交行已清；买方的订单仍在（不属于被删用户）
    expect((db.prepare('SELECT COUNT(*) c FROM trades WHERE user_id = ?').get(seller.id) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM orders WHERE id = ?').get(oid) as { c: number }).c).toBe(1);
  });
});
