// api/margin.ts —— 融资融券（信用交易）路由：账户视图、开户、四种下单动作、直接还款。
// 域逻辑全部在 domain/margin.ts；本文件只做 zod 校验与「返回最新账户视图」的装配。
//
// 约定：**每个写接口都回传完整的 `state`**。理由是这些动作彼此强耦合
// （融资买入会同时改现金、持仓、负债、维持担保比例），让客户端自己推算新状态
// 必然与实际不符 —— 前端只能整块替换。
import type { FastifyInstance } from 'fastify';
import {
  MarginFinanceSchema, MarginShortSchema, MarginSellRepaySchema,
  MarginBuyCoverSchema, MarginRepaySchema,
} from '@pt/shared';
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import {
  marginState, openMarginAccount, financeBuy, shortSell, sellToRepay, buyToCover, repayMargin,
} from '../domain/margin.js';

export interface MarginDeps { db: DB; cfg: Config }

export async function registerMarginRoutes(app: FastifyInstance, deps: MarginDeps): Promise<void> {
  const { db, cfg } = deps;
  const state = (userId: number): ReturnType<typeof marginState> => marginState(db, cfg, userId);

  /**
   * 账户视图：开通状态、负债、维持担保比例（含警戒/平仓线）、可开仓额度、持仓明细。
   * 未开通也返回 200（`open: false` + `eligible`），让前端直接渲染开通引导，
   * 不必把「没开通」当成错误来处理。
   */
  app.get('/api/margin', { preHandler: app.requireAuth }, async (req) => ({
    state: state(req.user.id),
    // 阈值随 config 一起下发：前端文案里写死 150%/130% 会在运营热改后说谎。
    limits: {
      initRatioE6: cfg.margin.initRatioE6,
      financeRateE6: cfg.margin.financeRateE6,
      shortRateE6: cfg.margin.shortRateE6,
      warnRatioE6: cfg.margin.warnRatioE6,
      liqRatioE6: cfg.margin.liqRatioE6,
      minOrderCents: cfg.margin.minOrderCents,
      maxDebtPerCreditPoint: cfg.margin.maxDebtPerCreditPoint,
    },
  }));

  /** 开通信用账户（信誉分门槛在域层校验）。幂等。 */
  app.post('/api/margin/open', { preHandler: app.requireAuth }, async (req) => {
    openMarginAccount(db, cfg, req.user.id);
    return { state: state(req.user.id) };
  });

  /** 融资买入：借钱买股，股票作为担保物（不可卖，须走「卖券还款」）。 */
  app.post('/api/margin/finance', { preHandler: app.requireAuth }, async (req) => {
    const input = MarginFinanceSchema.parse(req.body);
    const result = financeBuy(db, cfg, req.user.id, input.code, input.qty);
    return { result, state: state(req.user.id) };
  });

  /** 融券卖出：借券卖出，所得全额冻结作担保。 */
  app.post('/api/margin/short', { preHandler: app.requireAuth }, async (req) => {
    const input = MarginShortSchema.parse(req.body);
    const result = shortSell(db, cfg, req.user.id, input.code, input.qty);
    return { result, state: state(req.user.id) };
  });

  /** 卖券还款：卖掉担保股票，所得先冲利息再冲本金。 */
  app.post('/api/margin/sell-repay', { preHandler: app.requireAuth }, async (req) => {
    const input = MarginSellRepaySchema.parse(req.body);
    const result = sellToRepay(db, cfg, req.user.id, input.code, input.qty);
    return { result, state: state(req.user.id) };
  });

  /** 买券还券：买回股票还给券商，资金优先来自该笔空头的冻结担保金。 */
  app.post('/api/margin/buy-cover', { preHandler: app.requireAuth }, async (req) => {
    const input = MarginBuyCoverSchema.parse(req.body);
    const result = buyToCover(db, cfg, req.user.id, input.code, input.qty);
    return { result, state: state(req.user.id) };
  });

  /** 直接还款（现金 → 券商）。追保时把维持担保比例抬回安全区的手段之一。 */
  app.post('/api/margin/repay', { preHandler: app.requireAuth }, async (req) => {
    const input = MarginRepaySchema.parse(req.body);
    const result = repayMargin(db, cfg, req.user.id, input.amount);
    return { result, state: state(req.user.id) };
  });
}
