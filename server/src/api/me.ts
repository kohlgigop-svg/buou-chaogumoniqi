// api/me.ts —— /api/me 汇总视图 + orders/trades/ledger 倒序分页查询（均 requireAuth，强制 user_id 归属）。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { GameClock } from '../core/clock.js';
import { valuation, positions, todayPnl } from '../domain/portfolio.js';
import { workStatus } from '../domain/work.js';
import { engineDay } from '../core/clock.js';

export interface MeDeps { db: DB; cfg: Config; clock: GameClock; now: () => number }

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const PageSchema = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  before: z.coerce.number().int().min(1).optional(),
});
const OrdersQuerySchema = PageSchema.extend({
  status: z.enum(['open', 'done', 'cancelled', 'expired']).optional(),
});

interface PageQuery { limit?: number; before?: number; status?: string }
interface PageResult { items: unknown[]; nextBefore: number | null }

function page(db: DB, table: 'orders' | 'trades' | 'ledger', userId: number, q: PageQuery): PageResult {
  const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const conds = ['user_id = ?'];
  const params: (number | string)[] = [userId];
  if (q.status !== undefined) { conds.push('status = ?'); params.push(q.status); }
  if (q.before !== undefined) { conds.push('id < ?'); params.push(q.before); }
  const items = db.prepare(`SELECT * FROM ${table} WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as { id: number }[];
  const last = items[items.length - 1];
  return { items, nextBefore: last !== undefined ? last.id : null };
}

export async function registerMeRoutes(app: FastifyInstance, deps: MeDeps): Promise<void> {
  const { db, cfg, clock, now } = deps;

  app.get('/api/me', { preHandler: app.requireAuth }, async (req) => ({
    user: req.user,
    valuation: valuation(db, req.user.id),
    positions: positions(db, req.user.id),
    work: workStatus(db, cfg, clock, now(), req.user.id),
    // 当日盈亏：单开一个字段而不是塞进 valuation —— valuation 是「累计快照」口径，
    // 混入当日口径会让两个语义不同的数字挤在同一个对象里，容易被误用。
    todayPnl: todayPnl(db, req.user.id, engineDay(db)),
  }));

  app.get('/api/orders', { preHandler: app.requireAuth }, async (req) =>
    page(db, 'orders', req.user.id, OrdersQuerySchema.parse(req.query)));

  app.get('/api/trades', { preHandler: app.requireAuth }, async (req) =>
    page(db, 'trades', req.user.id, PageSchema.parse(req.query)));

  app.get('/api/ledger', { preHandler: app.requireAuth }, async (req) =>
    page(db, 'ledger', req.user.id, PageSchema.parse(req.query)));
}
