// api/auth.ts —— 注册/登录/登出/改密路由：IP 日限额、argon2id、锁定、会话 cookie。
import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { RegisterSchema, LoginSchema, ChangePasswordSchema } from '@pt/shared';
import { ACC, type DB } from '../db/database.js';
import { post } from '../core/ledger.js';
import type { Config } from '../config/defaults.js';
import { AppError, engineDay, type AuthUser } from './app.js';

const DAY_MS = 86_400_000;
const ABILITY_KINDS = ['EDU', 'CODE', 'FIN', 'FIT', 'COMM', 'DESIGN'] as const;

export interface AuthDeps { db: DB; cfg: Config; now: () => number }

/**
 * 建号的核心事务：插 users 行 + 六项能力 + 创世入账 + 开会话。
 *
 * 抽出来是为了让**管理后台的测试账号接口**复用同一套逻辑 —— 否则「测试账号」
 * 会走一条与真实注册不同的代码路径，两边迟早漂移（测试造出的账号状态与真实
 * 玩家不一致，测出来的结论就不可信）。
 *
 * ⚠️ 入账方向必须与注册一致：`@market -initialCash` / `新用户 +initialCash`。
 *    ledger 有 append-only 触发器，且 `auditGlobal` 要求总和恒为 0，
 *    两边金额必须严格配对。
 */
export async function createUser(
  db: DB, cfg: Config, nowMs: number,
  opts: { username: string; password: string; regIp: string; markTest?: boolean },
): Promise<{ userId: number; sid: string }> {
  const pwdHash = await hash(opts.password); // argon2id 默认参数（事务外：hash 为异步）
  const day = engineDay(db);
  let userId = 0;
  let sid = '';
  try {
    db.transaction(() => {
      const r = db.prepare(`INSERT INTO users(username, pwd_hash, reg_ip, created_day, created_at)
        VALUES (?,?,?,?,?)`).run(opts.username, pwdHash, opts.regIp, day, Math.floor(nowMs / 1000));
      userId = Number(r.lastInsertRowid);
      const insAb = db.prepare('INSERT INTO abilities(user_id, kind, level) VALUES (?,?,0)');
      for (const kind of ABILITY_KINDS) insAb.run(userId, kind);
      post(db, day, 0, 'genesis', userId, [
        { account: ACC.MARKET, bucket: 'A', amount: -cfg.auth.initialCash, kind: 'GENESIS' },
        { account: userId, bucket: 'A', amount: cfg.auth.initialCash, kind: 'GENESIS' },
      ]);
      sid = newSession(db, userId, nowMs, cfg.auth.sessionDays);
      // 测试账号打标记：便于日后一键清理，且不占真实注册名额的语义更明确
      if (opts.markTest === true) {
        db.prepare("UPDATE users SET reg_ip = ? WHERE id = ?").run(`test:${opts.regIp}`, userId);
      }
    })();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
      throw new AppError('USERNAME_TAKEN', 409, 'username already taken');
    }
    throw e;
  }
  return { userId, sid };
}


function newSession(db: DB, userId: number, nowMs: number, sessionDays: number): string {
  const sid = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(id, user_id, expires_at, created_at) VALUES (?,?,?,?)')
    .run(sid, userId, nowMs + sessionDays * DAY_MS, Math.floor(nowMs / 1000));
  return sid;
}

function setSidCookie(reply: FastifyReply, sid: string, sessionDays: number): void {
  reply.setCookie('sid', sid, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionDays * 86_400,
  });
}

function userView(db: DB, id: number): AuthUser {
  const r = db.prepare('SELECT id, username, credit, is_admin ia, bankrupt_count bc FROM users WHERE id = ?')
    .get(id) as { id: number; username: string; credit: number; ia: number; bc: number };
  return { id: r.id, username: r.username, credit: r.credit, isAdmin: r.ia === 1, bankruptCount: r.bc };
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { db, cfg, now } = deps;

  /**
   * ⚠️ 路由级兜底带**必须高于**业务上限 `cfg.auth.ipRegPerDay`，否则会在业务检查之前
   * 先抛 `RATE_LIMIT` —— 用户看到的是「请求过于频繁」而不是「今日注册名额已用完」，
   * 且把 `ipRegPerDay` 调高也不会生效（兜底带先拦住）。
   *
   * 这里取 60/hour：既是暴力注册的防护上限，也保证一天内任何低于它的
   * `ipRegPerDay` 都由业务规则给出正确的 429 REG_LIMIT。
   * 与 `ipRegPerDay` 的边界关系由 `auth.test.ts` 的「兜底带必须高于业务上限」锁住。
   */
  const REG_ROUTE_MAX_PER_HOUR = 60;

  app.post('/api/auth/register',
    { config: { rateLimit: { max: REG_ROUTE_MAX_PER_HOUR, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const { username, password } = RegisterSchema.parse(req.body);
      const t = now();
      const ip = req.ip;
      // 业务规则：同 reg_ip 当前 UTC 日注册数 ≥ ipRegPerDay → 429
      const dayStartSec = Math.floor(t / DAY_MS) * 86_400;
      const cnt = (db.prepare('SELECT COUNT(*) c FROM users WHERE reg_ip = ? AND created_at >= ? AND created_at < ?')
        .get(ip, dayStartSec, dayStartSec + 86_400) as { c: number }).c;
      if (cnt >= cfg.auth.ipRegPerDay) throw new AppError('REG_LIMIT', 429, 'too many registrations from this IP today');

      const { userId, sid } = await createUser(db, cfg, t, { username, password, regIp: ip });
      setSidCookie(reply, sid, cfg.auth.sessionDays);
      return { user: userView(db, userId) };
    });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = LoginSchema.parse(req.body);
    const t = now();
    const att = db.prepare('SELECT fails, locked_until lu FROM login_attempts WHERE username = ?')
      .get(username) as { fails: number; lu: number } | undefined;
    if (att !== undefined && t < att.lu) throw new AppError('LOCKED', 423, 'account locked, try again later');

    const u = db.prepare(`SELECT id, pwd_hash ph, status FROM users WHERE username = ? AND kind = 'user'`)
      .get(username) as { id: number; ph: string | null; status: string } | undefined;
    // 封禁账户：在验密之前即拒绝（不泄露密码正确性）。
    if (u !== undefined && u.status === 'banned') {
      throw new AppError('BANNED', 403, 'account banned');
    }
    if (u === undefined || u.ph === null || !(await verify(u.ph, password))) {
      const fails = (att?.fails ?? 0) + 1;
      if (fails >= cfg.auth.loginLockN) {
        db.prepare('INSERT OR REPLACE INTO login_attempts(username, fails, locked_until) VALUES (?,0,?)')
          .run(username, t + cfg.auth.loginLockMin * 60_000);
      } else {
        db.prepare('INSERT OR REPLACE INTO login_attempts(username, fails, locked_until) VALUES (?,?,0)')
          .run(username, fails);
      }
      throw new AppError('BAD_CREDENTIALS', 401, 'invalid username or password');
    }
    db.prepare('DELETE FROM login_attempts WHERE username = ?').run(username);
    const sid = newSession(db, u.id, t, cfg.auth.sessionDays);
    setSidCookie(reply, sid, cfg.auth.sessionDays);
    return { user: userView(db, u.id) };
  });

  app.post('/api/auth/logout', { preHandler: app.requireAuth }, async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.cookies['sid']);
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', { preHandler: app.requireAuth }, async (req) => {
    const { oldPassword, newPassword } = ChangePasswordSchema.parse(req.body);
    const u = db.prepare('SELECT pwd_hash ph FROM users WHERE id = ?')
      .get(req.user.id) as { ph: string | null };
    if (u.ph === null || !(await verify(u.ph, oldPassword))) {
      throw new AppError('BAD_CREDENTIALS', 401, 'wrong password');
    }
    const newHash = await hash(newPassword);
    const sid = req.cookies['sid'];
    db.transaction(() => {
      db.prepare('UPDATE users SET pwd_hash = ? WHERE id = ?').run(newHash, req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(req.user.id, sid);
    })();
    return { ok: true };
  });
}
