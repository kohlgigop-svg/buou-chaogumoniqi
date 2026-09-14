// domain/portfolio.ts —— 估值口径与持仓视图（纯读，不写库）。
import type { DB } from '../db/database.js';
import { roundHalfUpDiv, type Cents } from '../core/money.js';

export interface Valuation {
  cashAvailable: Cents;
  cashFrozen: Cents;
  positionsValue: Cents;      // Σ qty_total×stock_state.price（stocks.status='delisted' 按 0）
  loansOutstanding: Cents;    // Σ(outstanding+accrued_interest)，status IN ('active','grace','overdue')
  p2pDebt: Cents;             // 我欠其他玩家的（P2P 借款人视角）
  p2pCredit: Cents;           // 其他玩家欠我的（P2P 出借人视角）
  totalAssets: Cents;         // cashAvailable+cashFrozen+positionsValue+p2pCredit−loansOutstanding−p2pDebt
  totalInflow: Cents;         // Σ ledger.amount：bucket='A' AND kind IN ('GENESIS','RELIEF') AND amount>0
  returnPct: number;          // totalInflow>0 ? (totalAssets−totalInflow)/totalInflow : 0
}

export interface Position {
  code: string; name: string; qtyTotal: number; qtySellable: number;
  costTotal: Cents; avgCost: Cents; price: Cents; pnl: Cents; pnlPct: number;
}

export interface TodayPnlRow {
  /** 持仓当日浮动盈亏（分）：Σ qty_total × (price − prev_close)。 */
  positionPnl: Cents;
  /** 当日现金净流（分）：Σ ledger.amount（bucket='A'，day=当前游戏日）。 */
  cashFlow: Cents;
  /** 两者之和（分）。 */
  total: Cents;
}

/**
 * 当日盈亏（分）。口径 = **持仓当日浮动盈亏 + 当日现金净流**。
 *
 * 为什么不能用 `GET /ledger` 在客户端算：分页 `limit` 上限 200 且无 `day` 过滤，
 * 活跃用户一天就可能超过 → 会**静默算错**（这也是首页原先放弃「今日盈亏」的原因）。
 * 放到服务端可以用一条聚合 SQL 精确算，不受分页限制。
 *
 * 口径说明（很重要，避免与 `valuation.returnPct` 混淆）：
 * - `positionPnl` 用 `stock_state.prev_close` 作日初基准，即**上一交易日收盘价**。
 *   `prev_close` 在结算时被更新为当日收盘价（见 `engine/candles.ts`），
 *   未开盘时它等于最近一次收盘，故此值在盘前为 0，符合直觉。
 * - `cashFlow` 取当日 bucket='A' 的全部流水（含佣金/印花税/过户费、工资、分红、
 *   还款、放款…）。**借款 LOAN_DRAW 会让当日现金净流为正**，但它同时增加负债，
 *   所以「当日盈亏」在借钱的那天会显示为盈利 —— 这是口径的已知取舍：
 *   它衡量的是「今天口袋里多了多少钱」，不是「今天净资产涨了多少」。
 *   `valuation.returnPct`（累计收益率）才是净资产口径。
 * - 冻结/解冻（ORDER_FREEZE / ORDER_UNFREEZE / ORDER_RELEASE）在 A 桶是一对
 *   方向相反、金额相等的记录，但**跨日挂单时它们不在同一天**，故单看当日会有
 *   偏移。这是可接受的：未成交挂单的资金本来就不该算作当日盈亏。
 */
export function todayPnl(db: DB, userId: number, day: number): TodayPnlRow {
  const positionPnl = (db.prepare(`SELECT COALESCE(SUM(
        CASE WHEN s.status = 'delisted' THEN 0
             ELSE h.qty_total * (ss.price - ss.prev_close) END), 0) v
      FROM holdings h
      JOIN stocks s ON s.code = h.code
      JOIN stock_state ss ON ss.code = h.code
      WHERE h.user_id = ? AND h.qty_total > 0`).get(userId) as { v: number }).v;
  const cashFlow = (db.prepare(`SELECT COALESCE(SUM(amount), 0) v FROM ledger
      WHERE user_id = ? AND bucket = 'A' AND day = ?`).get(userId, day) as { v: number }).v;
  return { positionPnl, cashFlow, total: positionPnl + cashFlow };
}

export function valuation(db: DB, userId: number): Valuation {

  const cash = db.prepare('SELECT cash_available a, cash_frozen f FROM users WHERE id = ?')
    .get(userId) as { a: number; f: number } | undefined;
  if (cash === undefined) throw new Error(`no user ${userId}`);
  const positionsValue = (db.prepare(`SELECT COALESCE(SUM(
        CASE WHEN s.status = 'delisted' THEN 0 ELSE h.qty_total * ss.price END), 0) v
      FROM holdings h
      JOIN stocks s ON s.code = h.code
      JOIN stock_state ss ON ss.code = h.code
      WHERE h.user_id = ? AND h.qty_total > 0`).get(userId) as { v: number }).v;
  const loansOutstanding = (db.prepare(`SELECT COALESCE(SUM(outstanding + accrued_interest), 0) v
      FROM loans WHERE user_id = ? AND status IN ('active','grace','overdue')`).get(userId) as { v: number }).v;
  // P2P 债权债务：借出的钱是我的资产（别人欠我），借入的钱是我的负债。
  // 只在 status IN ('active','grace','overdue') 时计入 —— pending 尚未划款，不构成任何一方的权利义务。
  const p2pDebt = (db.prepare(`SELECT COALESCE(SUM(repay_amount - repaid), 0) v FROM p2p_loans
      WHERE borrower_id = ? AND status IN ('active','grace','overdue')`).get(userId) as { v: number }).v;
  const p2pCredit = (db.prepare(`SELECT COALESCE(SUM(repay_amount - repaid), 0) v FROM p2p_loans
      WHERE lender_id = ? AND status IN ('active','grace','overdue')`).get(userId) as { v: number }).v;
  const totalInflow = (db.prepare(`SELECT COALESCE(SUM(amount), 0) v FROM ledger
      WHERE user_id = ? AND bucket = 'A' AND kind IN ('GENESIS','RELIEF') AND amount > 0`)
    .get(userId) as { v: number }).v;
  const totalAssets = cash.a + cash.f + positionsValue + p2pCredit - loansOutstanding - p2pDebt;
  return {
    cashAvailable: cash.a, cashFrozen: cash.f, positionsValue, loansOutstanding,
    p2pDebt, p2pCredit, totalAssets, totalInflow,
    returnPct: totalInflow > 0 ? (totalAssets - totalInflow) / totalInflow : 0,
  };
}

export function positions(db: DB, userId: number): Position[] {
  const rows = db.prepare(`SELECT h.code, s.name, h.qty_total qt, h.qty_sellable qs, h.cost_total ct,
      CASE WHEN s.status = 'delisted' THEN 0 ELSE ss.price END price
    FROM holdings h
    JOIN stocks s ON s.code = h.code
    JOIN stock_state ss ON ss.code = h.code
    WHERE h.user_id = ? AND NOT (h.qty_total = 0 AND h.qty_sellable = 0)
    ORDER BY h.code`).all(userId) as
    { code: string; name: string; qt: number; qs: number; ct: number; price: number }[];
  return rows.map(r => {
    const pnl = r.qt * r.price - r.ct;
    return {
      code: r.code, name: r.name, qtyTotal: r.qt, qtySellable: r.qs, costTotal: r.ct,
      avgCost: r.qt > 0 ? roundHalfUpDiv(r.ct, r.qt) : 0,
      price: r.price, pnl,
      pnlPct: r.ct > 0 ? pnl / r.ct : 0,
    };
  });
}
