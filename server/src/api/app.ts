// api/app.ts —— Fastify 应用骨架：cookie/rate-limit 插件、错误信封、会话鉴权、/healthz、/api/me。
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { Engine } from '../engine/engine.js';
import { registerAuthRoutes } from './auth.js';
import { registerMeRoutes } from './me.js';
import { registerTradingRoutes } from './trading.js';
import { registerBankRoutes } from './bank.js';
import { registerWorkRoutes } from './work.js';
import { registerMarketRoutes } from './market.js';
import { registerAdminRoutes } from './admin.js';
import { registerWsRoutes } from './ws.js';
import type { PlayerMatcher } from '../trading/matcher.js';
import { GameClock } from '../core/clock.js';
import { processDueForUser } from '../domain/work.js';

export interface AppDeps { db: DB; cfg: Config; engine: Engine; matcher?: PlayerMatcher | null;
  dataDir?: string; now?: () => number; clock?: GameClock }

export class AppError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

export interface AuthUser {
  id: number; username: string; credit: number; isAdmin: boolean; bankruptCount: number;
}

declare module 'fastify' {
  interface FastifyRequest { user: AuthUser }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const DAY_MS = 86_400_000;
const RENEW_BELOW_MS = 15 * DAY_MS; // 剩余 <15 天时滑动续期为 sessionDays

/** 引擎当前 day。**已挪到 `core/clock.ts`**（此处仅保留 re-export 以免破坏既有 import）。
 * 挪走的原因：`app.ts` 要 import 各 route 模块，而它们又 import `engineDay`，
 * 形成循环导入；`core/` 不依赖任何 route，是它的正确归属。 */
export { engineDay } from '../core/clock.js';

/** 仅 `/healthz` 用：回传原始 last_tick（前端据此推导游戏时间）。 */
function lastTick(db: DB): number {
  const row = db.prepare('SELECT last_tick lt FROM engine_state WHERE id = 1').get() as { lt: number };
  return row.lt;
}

interface SessionRow {
  exp: number; uid: number; username: string; credit: number;
  is_admin: number; bankrupt_count: number; status: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, cfg, engine } = deps;
  const now = deps.now ?? Date.now;
  // GameClock：优先注入（测试控时），否则从 engine_state.genesis_ms 构造。
  const clock = deps.clock ?? new GameClock(
    (db.prepare('SELECT genesis_ms gm FROM engine_state WHERE id = 1').get() as { gm: number }).gm);
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ code: 'VALIDATION', message: err.issues[0]?.message ?? 'invalid input' });
    }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ code: err.code, message: err.message });
    }
    if ((err as { statusCode?: number }).statusCode === 429) { // @fastify/rate-limit 兜底带
      return reply.status(429).send({ code: 'RATE_LIMIT', message: (err as Error).message });
    }
    req.log.error(err);
    return reply.status(500).send({ code: 'INTERNAL', message: 'internal error' });
  });

  // 会话鉴权（按路由 preHandler 使用，不做全局钩子）
  app.decorateRequest('user', null as unknown as AuthUser);
  app.decorate('requireAuth', async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const sid = req.cookies['sid'];
    if (sid === undefined || sid === '') throw new AppError('UNAUTHORIZED', 401, 'not logged in');
    const row = db.prepare(`SELECT s.expires_at exp, u.id uid, u.username, u.credit,
        u.is_admin, u.bankrupt_count, u.status
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(sid) as SessionRow | undefined;
    const t = now();
    if (row === undefined || row.exp <= t) throw new AppError('UNAUTHORIZED', 401, 'session expired');
    if (row.status === 'banned') throw new AppError('BANNED', 403, 'account banned');
    if (row.exp - t < RENEW_BELOW_MS) {
      db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
        .run(t + cfg.auth.sessionDays * DAY_MS, sid);
    }
    req.user = { id: row.uid, username: row.username, credit: row.credit,
      isAdmin: row.is_admin === 1, bankruptCount: row.bankrupt_count };
    // 惰性结转（幂等）：把该用户到点的班次/课程立即结清，使后续读接口看到最新状态。
    processDueForUser(db, cfg, clock, t, row.uid);
  });

  app.get('/healthz', async () => {
    const lt = lastTick(db);
    return { ok: true, day: Math.floor((lt + 1) / 1200) + 1, lastTick: lt };
  });

  await registerAuthRoutes(app, { db, cfg, now });
  await registerMeRoutes(app, { db, cfg, clock, now });
  await registerTradingRoutes(app, { db, cfg });
  await registerBankRoutes(app, { db, cfg, engine });
  await registerWorkRoutes(app, { db, cfg, clock, now });
  await registerMarketRoutes(app, { db });
  await registerAdminRoutes(app, { db, cfg, now, dataDir: deps.dataDir });
  await registerWsRoutes(app, { db, engine, matcher: deps.matcher ?? null, now });

  return app;
}
