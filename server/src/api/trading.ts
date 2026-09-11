// api/trading.ts —— 下单/撤单路由（均 requireAuth）：zod 校验 → engineNow → 域函数。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PlaceOrderSchema } from '@pt/shared';
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import { engineNow, placeOrder, cancelOrder } from '../trading/orders.js';

export interface TradingDeps { db: DB; cfg: Config }

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export async function registerTradingRoutes(app: FastifyInstance, deps: TradingDeps): Promise<void> {
  const { db, cfg } = deps;

  app.post('/api/orders', { preHandler: app.requireAuth }, async (req) => {
    const input = PlaceOrderSchema.parse(req.body);
    const en = engineNow(db);
    return placeOrder(db, cfg, en.day, en.nextTick, en.phase, req.user.id, input);
  });

  app.delete('/api/orders/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = IdParamSchema.parse(req.params);
    cancelOrder(db, req.user.id, id);
    return reply.status(204).send();
  });
}
