// test/api/integration.test.ts —— Task 11：单用户全旅程 API 集成测试。
//
// 目标：用真实 HTTP 注入路径（buildApp + inject）跑通一名玩家从注册到"有房有贷有工有课有股"
//   的完整链路，验证各 Task（1–10）在组合场景下互相不打架。
//
// 旅程：
//   注册 → 登录态 /api/me → 行情概览/个股/新闻 → 下单 → 推进到成交 → 查持仓/成交/流水
//   → 借款 → 查看额度/信誉 → 还款 → 排班 → 报课 → 推进时间 → 领薪/能力提升
//   → 排行 → 管理员视角（改配置、看审计、封禁/解封）
//
// 时间推进用注入的 `now()`：GameClock 由 genesis 构造，引擎 catchUpTo(GENESIS + d*3600_000)。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS, type Config } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { PlayerMatcher } from '../../src/trading/matcher.js';
import { GameClock } from '../../src/core/clock.js';
import { post, auditUser } from '../../src/core/ledger.js';
import { buildApp } from '../../src/api/app.js';

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const SEED = 424242;
const PASS = 'p@ssw0rd!9';

let db: DB;
let app: FastifyInstance;
let engine: Engine;
let matcher: PlayerMatcher;
let clock: GameClock;
let nowMs: number;

let sid: string;
let uid: number;
let adminSid: string;
let adminId: number;

/** 游戏分钟 → 墙钟毫秒。 */
const msAtGmin = (gmin: number): number => GENESIS + gmin * 2500;
/** 推进到第 d 日结束（把 now 设到第 d 日 23:59 对应的墙钟，再 catchUp）。 */
async function gotoDay(d: number): Promise<void> {
  nowMs = GENESIS + d * 3_600_000;
  engine.catchUpTo(nowMs);
  await new Promise<void>(r => setImmediate(r));
}

const auth = (s: string): { cookies: { sid: string } } => ({ cookies: { sid: s } });

beforeEach(async () => {
  db = openDb(':memory:');
  const cfg: Config = DEFAULTS;
  nowMs = GENESIS;
  clock = new GameClock(GENESIS);
  matcher = new PlayerMatcher({ db, cfg, masterSeed: SEED });
  engine = new Engine({ db, cfg, masterSeed: SEED, genesisMs: GENESIS, matcher, flow: matcher });

  app = await buildApp({ db, cfg, engine, matcher, clock, now: () => nowMs });

  // 玩家
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username: 'alice', password: PASS }, remoteAddress: '1.1.1.1' });
  expect(reg.statusCode).toBe(200);
  uid = reg.json().user.id as number;
  sid = reg.cookies.find(c => c.name === 'sid')!.value;

  // 管理员（注册后直接提权）
  const areg = await app.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username: 'root', password: PASS }, remoteAddress: '2.2.2.2' });
  expect(areg.statusCode).toBe(200);
  adminId = areg.json().user.id as number;
  adminSid = areg.cookies.find(c => c.name === 'sid')!.value;
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(adminId);
});

afterEach(async () => { await app.close(); db.close(); });

describe('全旅程：注册 → 行情 → 交易 → 借贷 → 打工 → 排行 → 管理', () => {
  it('一名玩家的端到端链路全程 200，且账实自洽', async () => {
    // ── 1. 初始状态 ─────────────────────────────────────────────
    const me0 = await app.inject({ method: 'GET', url: '/api/me', ...auth(sid) });
    expect(me0.statusCode).toBe(200);
    const me0j = me0.json() as { user: { id: number; credit: number };
      valuation: { totalAssets: number; cash: number }; positions: unknown[];
      work: { busyUntil: number; shift: unknown; course: unknown } };
    expect(me0j.user.id).toBe(uid);
    expect(me0j.valuation.totalAssets).toBeGreaterThan(0);
    expect(me0j.positions).toHaveLength(0);
    expect(me0j.work).toMatchObject({ busyUntil: 0, shift: null, course: null });

    // ── 2. 行情面 ──────────────────────────────────────────────
    const ov = await app.inject({ method: 'GET', url: '/api/market/overview' });
    expect(ov.statusCode).toBe(200);
    const ovj = ov.json() as { index: { level: number; chgPct: number };
      sectors: { name: string; chgPct: number }[]; advancers: number; decliners: number;
      topGainers: unknown[]; topLosers: unknown[] };
    expect(ovj.index.level).toBeGreaterThan(0);
    expect(ovj.sectors.length).toBeGreaterThan(0);
    expect(ovj.topGainers.length).toBeGreaterThan(0);

    const list = await app.inject({ method: 'GET', url: '/api/stocks' });
    expect(list.statusCode).toBe(200);
    const stocks = list.json().stocks as { code: string; price: number }[];
    expect(stocks.length).toBeGreaterThan(0);

    const code = stocks[0]!.code;
    const detail = await app.inject({ method: 'GET', url: `/api/stocks/${code}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().quote).toBeTruthy();

    const candles = await app.inject({ method: 'GET', url: `/api/stocks/${code}/candles?type=day` });
    expect(candles.statusCode).toBe(200);

    expect((await app.inject({ method: 'GET', url: '/api/news' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/announcements' })).statusCode).toBe(200);

    // ── 3. 一个完整交易日的推进（建立日线/成交环境）─────────────
    await gotoDay(3);

    // ── 4. 交易：买 → 成交 → 查持仓/成交/流水 ──────────────────
    const q = (db.prepare('SELECT price p, limit_up up, limit_down dn FROM stock_state WHERE code = ?')
      .get(code) as { p: number; up: number; dn: number });
    const buy = await app.inject({ method: 'POST', url: '/api/orders', ...auth(sid),
      payload: { code, side: 'B', type: 'L', price: q.up, qty: 100, clientKey: 'e2e-buy-1' } });
    expect(buy.statusCode).toBe(200);
    const orderId = buy.json().orderId as number;
    expect(orderId).toBeGreaterThan(0);

    // 幂等：同 clientKey 重放返回同一 orderId，不重复冻结
    const buyAgain = await app.inject({ method: 'POST', url: '/api/orders', ...auth(sid),
      payload: { code, side: 'B', type: 'L', price: q.up, qty: 100, clientKey: 'e2e-buy-1' } });
    expect(buyAgain.statusCode).toBe(200);
    expect(buyAgain.json().orderId).toBe(orderId);
    expect(buyAgain.json().reused).toBe(true);

    // 挂涨停买价 → 下一 tick 大概率成交；推进几日后必有成交或单已完结
    await gotoDay(5);

    const orders = await app.inject({ method: 'GET', url: '/api/orders?limit=50', ...auth(sid) });
    expect(orders.statusCode).toBe(200);
    const trades = await app.inject({ method: 'GET', url: '/api/trades?limit=50', ...auth(sid) });
    expect(trades.statusCode).toBe(200);
    const ledger = await app.inject({ method: 'GET', url: '/api/ledger?limit=100', ...auth(sid) });
    expect(ledger.statusCode).toBe(200);
    expect((ledger.json().items as unknown[]).length).toBeGreaterThan(0);

    // 无论成交与否，账户必须自洽
    auditUser(db, uid);

    // ── 5. 借贷面 ──────────────────────────────────────────────
    const prodRes = await app.inject({ method: 'GET', url: '/api/bank/products', ...auth(sid) });
    expect(prodRes.statusCode).toBe(200);
    const products = prodRes.json().products as { termDays: number; capCents: number; rateE6: number }[];
    expect(products.length).toBeGreaterThan(0);

    const loan = await app.inject({ method: 'POST', url: '/api/bank/loans', ...auth(sid),
      payload: { amount: 1_000_000, termDays: 20 } });
    expect(loan.statusCode).toBe(200);
    const loanId = loan.json().loanId as number;
    expect(loanId).toBeGreaterThan(0);

    const loans = await app.inject({ method: 'GET', url: '/api/bank/loans', ...auth(sid) });
    expect(loans.statusCode).toBe(200);
    expect((loans.json().loans as { id: number }[]).some(l => l.id === loanId)).toBe(true);

    // 借出后现金增加，账本仍平
    auditUser(db, uid);
    const credit0 = await app.inject({ method: 'GET', url: '/api/credit', ...auth(sid) });
    expect(credit0.statusCode).toBe(200);
    expect(credit0.json().credit).toBeGreaterThan(0);

    // 部分还款
    const repay = await app.inject({ method: 'POST', url: `/api/bank/loans/${loanId}/repay`,
      ...auth(sid), payload: { amount: 200_000 } });
    expect(repay.statusCode).toBe(200);
    auditUser(db, uid);

    // ── 6. 打工面 ──────────────────────────────────────────────
    const jobs = await app.inject({ method: 'GET', url: '/api/jobs', ...auth(sid) });
    expect(jobs.statusCode).toBe(200);
    const jobList = jobs.json().jobs as { id: number; eligible: boolean; wage: number }[];
    expect(jobList).toHaveLength(10);
    const anyJob = jobList.find(j => j.eligible);
    expect(anyJob, 'at least one job should be eligible by default').toBeTruthy();

    // 排班：需把 now 对齐到当前游戏分钟（避免"开始时间已过"）
    const shift = await app.inject({ method: 'POST', url: '/api/shifts', ...auth(sid),
      payload: { jobId: anyJob!.id } });
    expect(shift.statusCode).toBe(200);
    const shiftId = shift.json().shiftId as number;

    const shiftList = await app.inject({ method: 'GET', url: '/api/shifts', ...auth(sid) });
    expect(shiftList.statusCode).toBe(200);
    expect((shiftList.json().shifts as { id: number }[]).some(s => s.id === shiftId)).toBe(true);

    const status = await app.inject({ method: 'GET', url: '/api/work/status', ...auth(sid) });
    expect(status.statusCode).toBe(200);
    expect(status.json().shift).toBeTruthy();

    // ── 7. 能力与课程 ──────────────────────────────────────────
    const abil = await app.inject({ method: 'GET', url: '/api/abilities', ...auth(sid) });
    expect(abil.statusCode).toBe(200);
    const levels = abil.json().abilities as Record<string, number>;
    expect(Object.keys(levels).sort()).toEqual(['CODE', 'COMM', 'DESIGN', 'EDU', 'FIN', 'FIT']);
    const nextCost = abil.json().nextCourseCost as Record<string, number | null>;
    expect(nextCost.EDU).toBeGreaterThan(0);

    const enroll = await app.inject({ method: 'POST', url: '/api/courses/enroll', ...auth(sid),
      payload: { ability: 'EDU' } });
    expect(enroll.statusCode).toBe(200);
    auditUser(db, uid);

    // ── 8. 推进时间：班次发薪 + 课程结业 ───────────────────────
    const cashBefore = (db.prepare('SELECT cash_available a FROM users WHERE id = ?')
      .get(uid) as { a: number }).a;
    await gotoDay(12);
    // 触发一次 API 读，走 requireAuth 的惰性结转
    const status2 = await app.inject({ method: 'GET', url: '/api/work/status', ...auth(sid) });
    expect(status2.statusCode).toBe(200);
    auditUser(db, uid);

    const cashAfter = (db.prepare('SELECT cash_available a FROM users WHERE id = ?')
      .get(uid) as { a: number }).a;
    expect(cashAfter).not.toBe(cashBefore);

    // 能力至少有一项提升过（课程结业）
    const abilities2 = await app.inject({ method: 'GET', url: '/api/abilities', ...auth(sid) });
    const sum2 = Object.values(abilities2.json().abilities as Record<string, number>)
      .reduce((a, b) => a + b, 0);
    expect(sum2, 'course should have raised at least one ability').toBeGreaterThan(0);

    // ── 9. 排行 ────────────────────────────────────────────────
    for (const by of ['total', 'return']) {
      const lb = await app.inject({ method: 'GET', url: `/api/leaderboard?by=${by}` });
      expect(lb.statusCode).toBe(200);
      expect((lb.json().rows as unknown[]).length).toBeGreaterThan(0);
    }

    // ── 10. 管理面 ─────────────────────────────────────────────
    // 非管理员访问 → 403
    const forbidden = await app.inject({ method: 'GET', url: '/api/admin/users', ...auth(sid) });
    expect(forbidden.statusCode).toBe(403);

    const users = await app.inject({ method: 'GET', url: '/api/admin/users', ...auth(adminSid) });
    expect(users.statusCode).toBe(200);
    expect((users.json().users as unknown[]).length).toBeGreaterThanOrEqual(2);

    const cfgGet = await app.inject({ method: 'GET', url: '/api/admin/config', ...auth(adminSid) });
    expect(cfgGet.statusCode).toBe(200);

    const cfgPut = await app.inject({ method: 'PUT', url: '/api/admin/config', ...auth(adminSid),
      payload: { key: 'trading.slippageK', value: 0.0002 } });
    expect(cfgPut.statusCode).toBe(200);
    // 白名单外键 → 400
    const cfgBad = await app.inject({ method: 'PUT', url: '/api/admin/config', ...auth(adminSid),
      payload: { key: 'auth.sessionDays', value: 1 } });
    expect(cfgBad.statusCode).toBe(400);

    const eng = await app.inject({ method: 'GET', url: '/api/admin/engine', ...auth(adminSid) });
    expect(eng.statusCode).toBe(200);
    expect(typeof eng.json().lagSeconds).toBe('number');
    expect(eng.json().day).toBeGreaterThan(0);

    const audit = await app.inject({ method: 'GET', url: '/api/admin/audit', ...auth(adminSid) });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().globalOk).toBe(true);
    expect(audit.json().usersOk).toBe(true);

    const announce = await app.inject({ method: 'POST', url: '/api/admin/announce', ...auth(adminSid),
      payload: { content: '集成测试公告' } });
    expect(announce.statusCode).toBe(200);
    const annList = await app.inject({ method: 'GET', url: '/api/announcements' });
    expect((annList.json().items as { content: string }[])
      .some(a => a.content === '集成测试公告')).toBe(true);

    // 封禁 → 该用户登录 403 → 解封后恢复
    const ban = await app.inject({ method: 'POST', url: `/api/admin/users/${uid}/ban`,
      ...auth(adminSid) });
    expect(ban.statusCode).toBe(200);
    const bannedLogin = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { username: 'alice', password: PASS }, remoteAddress: '3.3.3.3' });
    expect(bannedLogin.statusCode).toBe(403);

    const unban = await app.inject({ method: 'POST', url: `/api/admin/users/${uid}/unban`,
      ...auth(adminSid) });
    expect(unban.statusCode).toBe(200);
    const okLogin = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { username: 'alice', password: PASS }, remoteAddress: '4.4.4.4' });
    expect(okLogin.statusCode).toBe(200);

    const resetPwd = await app.inject({ method: 'POST',
      url: `/api/admin/users/${uid}/reset-password`, ...auth(adminSid),
      payload: { newPassword: 'newP@ss!42' } });
    expect(resetPwd.statusCode).toBe(200);
    const newLogin = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { username: 'alice', password: 'newP@ss!42' }, remoteAddress: '5.5.5.5' });
    expect(newLogin.statusCode).toBe(200);

    // 备份列表（无 dataDir 时也必须是 200 + 数组）
    const backups = await app.inject({ method: 'GET', url: '/api/admin/backups', ...auth(adminSid) });
    expect(backups.statusCode).toBe(200);
    expect(Array.isArray(backups.json().files)).toBe(true);

    // ── 11. 收尾：全局一致性 ───────────────────────────────────
    auditUser(db, uid);
    auditUser(db, adminId);
    const gsum = (db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger').get() as { s: number }).s;
    expect(gsum).toBe(0);
    void post; void ACC; // 保持与其它测试一致的导入面（显式说明未直接使用）
  }, 120_000);
});
