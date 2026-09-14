// api/app.ts —— Fastify 应用骨架：cookie/rate-limit 插件、错误信封、会话鉴权、/healthz、/api/me，
// 以及（可选）托管前端构建产物的静态服务 + SPA history fallback。
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { Engine } from '../engine/engine.js';
import { registerAuthRoutes } from './auth.js';
import { registerMeRoutes } from './me.js';
import { registerTradingRoutes } from './trading.js';
import { registerBankRoutes } from './bank.js';
import { registerP2pRoutes } from './p2p.js';
import { registerWorkRoutes } from './work.js';
import { registerMarketRoutes } from './market.js';
import { registerAdminRoutes } from './admin.js';
import { registerWsRoutes } from './ws.js';
import type { PlayerMatcher } from '../trading/matcher.js';
import { GameClock } from '../core/clock.js';
import { processDueForUser } from '../domain/work.js';

export interface AppDeps { db: DB; cfg: Config; engine: Engine; matcher?: PlayerMatcher | null;
  dataDir?: string; now?: () => number; clock?: GameClock;
  /**
   * 前端构建产物目录（如 `web/dist`）。给定时托管静态资源并启用 SPA fallback；
   * 目录不存在则**静默跳过** —— 开发期只想跑 API 时不该因此启动失败。
   */
  webDist?: string }

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
  const { db, engine } = deps;
  // ⚠️ cfg 必须克隆：`PUT /api/admin/config` 会**原位改写**传入的 cfg 对象（见 admin.ts 的
  // applyOverride，它按 "a.b.c" 逐层深入并直接赋值）。若不克隆，调用方传进来的对象
  // —— 尤其是模块级的 `DEFAULTS` 单例 —— 会被永久污染，导致**跨测试、跨实例的状态泄漏**：
  // 实测 admin.test 把 DEFAULTS.work.shiftsPerDay 从 2 改成 1 后，同一进程内后续用例
  // 读到的仍是 1，谁先跑谁定调。`structuredClone` 深拷贝（cfg 是纯 JSON 数据，无函数）。
  const cfg: Config = structuredClone(deps.cfg);
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
  await registerP2pRoutes(app, { db, cfg });
  await registerWorkRoutes(app, { db, cfg, clock, now });
  await registerMarketRoutes(app, { db });
  await registerAdminRoutes(app, { db, cfg, now, dataDir: deps.dataDir });
  await registerWsRoutes(app, { db, engine, matcher: deps.matcher ?? null, now });

  await registerStaticServing(app, deps.webDist);

  return app;
}

/**
 * 托管前端构建产物 + SPA history fallback。
 *
 * 三个坑，逐一说明为什么这么写：
 *
 * ① `wildcard: false` —— 不让 `@fastify/static` 注册 `/*`。若它接管了通配路由，
 *    我们就无法在"未命中"时区分 SPA 路由与打错的 API 路径。
 *
 * ② **`setNotFoundHandler` 是唯一的 fallback 入口，且必须显式排除 `/api`、`/ws`、
 *    `/healthz`**。SPA 的直觉写法是"未命中一律回 index.html"，但本项目 `/api/*`
 *    的未命中**必须**保持 `{code:'NOT_FOUND'}` JSON 信封：前端 `api.ts` 会
 *    `JSON.parse` 响应体，拿到 HTML 会以 `Unexpected token '<'` 炸掉，
 *    报错完全指不到真正原因（打错了 URL）。`/ws` 未命中同理不得回 HTML，
 *    否则 WS 客户端握手失败时会读到一堆网页源码。
 *
 * ③ 只对 `GET`/`HEAD` fallback。POST 到一个不存在的路径回 index.html 毫无意义，
 *    还会掩盖"写接口打错"的问题。
 *
 * `webDist` 目录不存在时整体跳过：开发期只跑 API 是常态，不该因此启动失败。
 */
async function registerStaticServing(app: FastifyInstance, webDist?: string): Promise<void> {
  if (webDist === undefined || webDist === '' || !existsSync(webDist)) return;

  await app.register(fastifyStatic, { root: webDist, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    // 非 GET/HEAD：保持默认 JSON 404。
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJsonNotFound(req, reply);
    // API / WS / 健康检查：绝不能退化成 HTML。
    const url = req.raw.url ?? req.url;
    const path = url.split('?')[0] ?? '';
    if (path.startsWith('/api/') || path.startsWith('/api')
      || path.startsWith('/ws') || path.startsWith('/healthz')) {
      return sendJsonNotFound(req, reply);
    }
    return reply.sendFile('index.html');
  });
}

/** 统一的 JSON 404（与原默认行为一致的 `{code:'NOT_FOUND'}` 信封）。 */
function sendJsonNotFound(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.status(404).send({ code: 'NOT_FOUND', message: `route ${req.url} not found` });
}
