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

  app.post('/api/auth/register',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },  // 兜底带
    async (req, reply) => {
      const { username, password } = RegisterSchema.parse(req.body);
      const t = now();
      const ip = req.ip;
      // 业务规则：同 reg_ip 当前 UTC 日注册数 ≥ ipRegPerDay → 429
      const dayStartSec = Math.floor(t / DAY_MS) * 86_400;
      const cnt = (db.prepare('SELECT COUNT(*) c FROM users WHERE reg_ip = ? AND created_at >= ? AND created_at < ?')
        .get(ip, dayStartSec, dayStartSec + 86_400) as { c: number }).c;
      if (cnt >= cfg.auth.ipRegPerDay) throw new AppError('REG_LIMIT', 429, 'too many registrations from this IP today');

      const pwdHash = await hash(password); // argon2id 默认参数（事务外：hash 为异步）
      const day = engineDay(db);
      let userId = 0;
      let sid = '';
      try {
        db.transaction(() => {
          const r = db.prepare(`INSERT INTO users(username, pwd_hash, reg_ip, created_day, created_at)
            VALUES (?,?,?,?,?)`).run(username, pwdHash, ip, day, Math.floor(t / 1000));
          userId = Number(r.lastInsertRowid);
          const insAb = db.prepare('INSERT INTO abilities(user_id, kind, level) VALUES (?,?,0)');
          for (const kind of ABILITY_KINDS) insAb.run(userId, kind);
          post(db, day, 0, 'genesis', userId, [
            { account: ACC.MARKET, bucket: 'A', amount: -cfg.auth.initialCash, kind: 'GENESIS' },
            { account: userId, bucket: 'A', amount: cfg.auth.initialCash, kind: 'GENESIS' },
          ]);
          sid = newSession(db, userId, t, cfg.auth.sessionDays);
        })();
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
          throw new AppError('USERNAME_TAKEN', 409, 'username already taken');
        }
        throw e;
      }
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
