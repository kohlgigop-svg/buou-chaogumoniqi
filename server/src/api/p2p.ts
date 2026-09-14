// api/p2p.ts —— 玩家间借贷（P2P）：找对手方、发起协商、同意/拒绝、还款、我的借据。
// 域逻辑全部在 domain/p2p.ts；本文件只做 zod 校验与归属装配（与 api/bank.ts 同风格）。
//
// 权限模型：每笔借据只有**双方**可见/可操作，且各操作再校验自己的角色
// （只有对手方能 accept、只有借款方能 repay…），错误码由 domain 层给出。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { P2pProposeSchema, P2pRepaySchema } from '@pt/shared';
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import { propose, accept, reject, repayP2p, listP2p, p2pDebtOf, p2pCreditOf } from '../domain/p2p.js';

export interface P2pDeps { db: DB; cfg: Config }

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** 按用户名前缀/包含查找潜在对手方（最多 20 条）。排除自己、被封禁与系统账号。 */
const SearchSchema = z.object({ q: z.string().min(1).max(16) });

export async function registerP2pRoutes(app: FastifyInstance, deps: P2pDeps): Promise<void> {
  const { db, cfg } = deps;

  /**
   * 找对手方：按用户名模糊匹配（用于发起借款时选人）。
   * 只回 id / username / credit，不回余额 —— 借钱前不该先看别人有多少钱。
   */
  app.get('/api/p2p/players', { preHandler: app.requireAuth }, async (req) => {
    const { q } = SearchSchema.parse(req.query);
    const rows = db.prepare(`SELECT id, username, credit FROM users
      WHERE id != ? AND kind = 'user' AND status = 'active' AND username LIKE ?
      ORDER BY (username = ?) DESC, id ASC LIMIT 20`)
      .all(req.user.id, `%${q}%`, q) as { id: number; username: string; credit: number }[];
    return { players: rows };
  });

  /** 条款边界（前端表单的 min/max，避免用户填了才被拒）。 */
  app.get('/api/p2p/limits', { preHandler: app.requireAuth }, async () => ({
    maxPrincipal: cfg.p2p.maxPrincipal,
    minRateMult: cfg.p2p.minRateMult,
    maxRateMult: cfg.p2p.maxRateMult,
    minTermDays: cfg.p2p.minTermDays,
    maxTermDays: cfg.p2p.maxTermDays,
    graceDays: cfg.p2p.graceDays,
  }));

  /** 与我相关的全部借据 + 债权债务汇总。 */
  app.get('/api/p2p/loans', { preHandler: app.requireAuth }, async (req) => ({
    loans: listP2p(db, req.user.id),
    debt: p2pDebtOf(db, req.user.id),
    credit: p2pCreditOf(db, req.user.id),
  }));

  /** 发起借款请求（不划款，等待对手方确认）。 */
  app.post('/api/p2p/loans', { preHandler: app.requireAuth }, async (req) => {
    const input = P2pProposeSchema.parse(req.body);
    const id = propose(db, cfg, req.user.id, {
      role: input.role, counterpartyId: input.counterpartyId, principal: input.principal,
      repayAmount: input.repayAmount, termDays: input.termDays, note: input.note,
    });
    return { id, loans: listP2p(db, req.user.id) };
  });

  /** 对手方同意 → 借据生效并划款。 */
  app.post('/api/p2p/loans/:id/accept', { preHandler: app.requireAuth }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    accept(db, cfg, req.user.id, id);
    return { loans: listP2p(db, req.user.id) };
  });

  /** 对手方拒绝（或发起人撤回）。无资金变动。 */
  app.post('/api/p2p/loans/:id/reject', { preHandler: app.requireAuth }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    reject(db, req.user.id, id);
    return { loans: listP2p(db, req.user.id) };
  });

  /** 借款方主动还款（可部分；结清时按提前/按期给信誉分）。 */
  app.post('/api/p2p/loans/:id/repay', { preHandler: app.requireAuth }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const input = P2pRepaySchema.parse(req.body);
    const result = repayP2p(db, cfg, req.user.id, id, input.amount);
    return { ...result, loans: listP2p(db, req.user.id) };
  });
}
