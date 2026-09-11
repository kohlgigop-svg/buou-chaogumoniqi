// api/bank.ts —— 布偶银行：产品查询、借款、还款、贷款列表、信誉流水（均 requireAuth）。
// 域逻辑全部在 domain/loans.ts + domain/credit.ts；本文件只做 zod 校验与归属装配。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BorrowSchema, RepaySchema } from '@pt/shared';
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { Engine } from '../engine/engine.js';
import { loanProducts, borrow, repay, listLoans } from '../domain/loans.js';

export interface BankDeps { db: DB; cfg: Config; engine: Engine }

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export async function registerBankRoutes(app: FastifyInstance, deps: BankDeps): Promise<void> {
  const { db, cfg, engine } = deps;

  /** 产品表：按当前信誉分给出各期限档的额度与日息；<500 返回空数组 + creditLow 标记。 */
  app.get('/api/bank/products', { preHandler: app.requireAuth }, async (req) => {
    const score = req.user.credit;
    return { credit: score, creditLow: score < cfg.credit.min + 150, // 500 门槛线
      products: loanProducts(cfg, score) };
  });

  /** 借款：门槛与放款见 domain/loans.borrow（金额单位：分）。 */
  app.post('/api/bank/loans', { preHandler: app.requireAuth }, async (req) => {
    const input = BorrowSchema.parse(req.body);
    const loanId = borrow(db, cfg, engine, req.user.id, input.amount, input.termDays);
    return { loanId, loans: listLoans(db, req.user.id) };
  });

  /** 还款：先息后本；全清时按提前/按期给信誉分。 */
  app.post('/api/bank/loans/:id/repay', { preHandler: app.requireAuth }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const input = RepaySchema.parse(req.body);
    const result = repay(db, cfg, engine, req.user.id, id, input.amount);
    return { ...result, loans: listLoans(db, req.user.id) };
  });

  /** 我的全部贷款（含实时应还 = outstanding + accrued_interest）。 */
  app.get('/api/bank/loans', { preHandler: app.requireAuth }, async (req) => (
    { credit: req.user.credit, loans: listLoans(db, req.user.id) }
  ));

  /** 信誉视图：当前分 + 近 50 条事件（倒序）。 */
  app.get('/api/credit', { preHandler: app.requireAuth }, async (req) => {
    const events = db.prepare(`SELECT day, delta, reason, score_after scoreAfter FROM credit_events
      WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(req.user.id);
    return { credit: req.user.credit, events };
  });
}
