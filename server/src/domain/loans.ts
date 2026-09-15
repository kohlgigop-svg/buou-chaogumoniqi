// domain/loans.ts —— NPC"布偶银行"信用贷：产品查表、借款门槛、还款（先息后本）、
// 日终计息/宽限/逾期推进、逾期第 10 日强制平仓、资不抵债破产结算。
//
// 计息口径（规格 §9）：单利，每交易日计提 rate × outstanding，四舍五入到分；
// 宽限/逾期期罚息 ×penaltyMult。到期一次还本，支持随时部分/全额提前还款。
import type { DB } from '../db/database.js';
import { ACC } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { Engine } from '../engine/engine.js';
import type { SettlementHook, TickCtx, StockQuote } from '../engine/types.js';
import { commission, stampTax, transferFee, roundHalfUpDiv, type Cents } from '../core/money.js';
import { post, type Leg } from '../core/ledger.js';
import { valuation } from './portfolio.js';
import { applyCreditEvent, setCredit, tierOf } from './credit.js';
import { AppError } from '../api/app.js';
import { engineDay } from '../core/clock.js';

/** 计的息精确到分：outstanding × rate_e6 / 1e6，四舍五入。 */
function accrue(outstanding: Cents, rateE6: number): Cents {
  return roundHalfUpDiv(outstanding * rateE6, 1_000_000);
}

export interface LoanProduct { termDays: number; rateE6: number; capCents: Cents }

/** 按信誉分查表；<500 拒贷（空数组）。期限档固定取 cfg.loans.termDays。 */
export function loanProducts(cfg: Config, score: number): LoanProduct[] {
  const tier = tierOf(cfg, score);
  if (tier === null) return [];
  return cfg.loans.termDays.map(termDays => ({
    termDays, rateE6: tier.rateE6, capCents: tier.capCents,
  }));
}

interface LoanRow {
  id: number; user_id: number; principal: Cents; outstanding: Cents; rate_e6: number;
  term_days: number; start_day: number; due_day: number; accrued_interest: Cents; status: string;
}

function loadLoan(db: DB, loanId: number): LoanRow {
  const row = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId) as LoanRow | undefined;
  if (row === undefined) throw new AppError('LOAN_NOT_FOUND', 404, 'loan not found');
  return row;
}

/** 未偿本息合计（含已计提利息）。 */
function owed(l: LoanRow): Cents { return l.outstanding + l.accrued_interest; }

/**
 * 借款。门槛（按此顺序，先到先拒）：
 *   1 信誉 ≥ 500（否则 CREDIT_LOW）
 *   2 期限 ∈ termDays（否则 BAD_TERM）
 *   3 金额 > 0
 *   4 无 grace/overdue 贷在身（否则 OVERDUE_EXISTS）
 *   5 amount ≤ 授信额度剩余（信誉分 × cfg.loans.capPerCreditPoint − 未偿本金合计）
 *     （否则 LOAN_LIMIT）
 *   6 未偿本息 + amount ≤ 净资产 × score/leverageDivisor（否则 LEVERAGE）
 *
 * ⚠️ 第 5、6 条**都正比于信誉分**，故谁先拒只取决于净资产：
 *    额度 < 杠杆 ⟺ 净资产 > capPerCreditPoint × leverageDivisor
 *    （默认 500_000 × 300 = 150_000_000 分 = ¥1,500,000）。
 *    净资产低于 ¥1,500,000 的玩家实际被**杠杆**卡住，调大 capPerCreditPoint 无感。
 * 放款：ledger BANK→user（kind 'LOAN_DRAW'），loans 行 status='active'，due_day = day + term。
 */
export function borrow(db: DB, cfg: Config, engine: Engine, userId: number,
    amount: Cents, termDays: number): number {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError('BAD_AMOUNT', 400, 'amount must be a positive integer');
  }
  const day = engineDayOf(db);
  const score = (db.prepare('SELECT credit c FROM users WHERE id = ?').get(userId) as
    { c: number } | undefined)?.c;
  if (score === undefined) throw new AppError('UNAUTHORIZED', 401, 'not logged in');
  const tier = tierOf(cfg, score);
  if (tier === null) throw new AppError('CREDIT_LOW', 403, 'credit score below 500');

  if (!cfg.loans.termDays.includes(termDays)) {
    throw new AppError('BAD_TERM', 400, `term must be one of ${cfg.loans.termDays.join('/')}`);
  }

  const blocking = (db.prepare(`SELECT COUNT(*) c FROM loans
    WHERE user_id = ? AND status IN ('grace','overdue')`).get(userId) as { c: number }).c;
  if (blocking > 0) throw new AppError('OVERDUE_EXISTS', 403, 'has overdue loan, no new loan allowed');

  const openPrincipal = (db.prepare(`SELECT COALESCE(SUM(outstanding),0) v FROM loans
    WHERE user_id = ? AND status IN ('active','grace','overdue')`).get(userId) as { v: number }).v;
  if (openPrincipal + amount > tier.capCents) {
    throw new AppError('LOAN_LIMIT', 403, `exceeds credit cap ${tier.capCents}`);
  }

  const v = valuation(db, userId);
  // 杠杆上限按"借款前净资产"计（规格 §9：与查表额度取严）。
  // 净资产 ≤ 0 时杠杆空间为零：必须先以明确的 LEVERAGE 拒绝，而不能把负值送进
  // roundHalfUpDiv（其契约要求非负被除数，否则抛 "bad dividend" → 500/进程崩溃）。
  if (v.totalAssets <= 0) {
    throw new AppError('LEVERAGE', 403, 'net worth is not positive, no borrowing capacity');
  }
  const leverageCap = roundHalfUpDiv(v.totalAssets * score, cfg.loans.leverageDivisor);
  if (v.loansOutstanding + amount > leverageCap) {
    throw new AppError('LEVERAGE', 403, `exceeds leverage cap ${leverageCap}`);
  }

  const dueDay = day + termDays;
  let loanId = 0;
  db.transaction(() => {
    const r = db.prepare(`INSERT INTO loans(user_id, principal, outstanding, rate_e6, term_days,
      start_day, due_day, accrued_interest, status) VALUES (?,?,?,?,?,?,?,0,'active')`)
      .run(userId, amount, amount, tier.rateE6, termDays, day, dueDay);
    loanId = Number(r.lastInsertRowid);
    post(db, day, 0, 'loan', loanId, [
      { account: ACC.BANK, bucket: 'A', amount: -amount, kind: 'LOAN_DRAW' },
      { account: userId, bucket: 'A', amount, kind: 'LOAN_DRAW' },
    ]);
  })();
  return loanId;
}

export interface RepayResult { interestPaid: Cents; principalPaid: Cents; closed: boolean }

/**
 * 还款：先冲已计提利息，再冲本金。全额结清（应还归零）时：
 *   day < due_day → 提前还清 +repayEarly；否则 +repayOnTime。多余金额不收取。
 */
export function repay(db: DB, cfg: Config, engine: Engine, userId: number,
    loanId: number, amount: Cents): RepayResult {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError('BAD_AMOUNT', 400, 'amount must be a positive integer');
  }
  const l = loadLoan(db, loanId);
  if (l.user_id !== userId) throw new AppError('LOAN_NOT_FOUND', 404, 'loan not found');
  if (l.status === 'repaid' || l.status === 'forgiven') {
    throw new AppError('LOAN_CLOSED', 409, 'loan already closed');
  }
  if (l.status === 'liquidated') throw new AppError('LOAN_CLOSED', 409, 'loan already liquidated');

  const day = engineDayOf(db);
  const avail = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(userId) as
    { a: number }).a;
  if (avail < Math.min(amount, owed(l))) {
    throw new AppError('INSUFFICIENT_CASH', 400, `need ${Math.min(amount, owed(l))} available`);
  }

  const total = owed(l);
  const pay = Math.min(amount, total);
  const interestPaid = Math.min(pay, l.accrued_interest);
  const principalPaid = pay - interestPaid;
  const closed = pay === total;
  const wasEarly = day < l.due_day;

  db.transaction(() => {
    db.prepare(`UPDATE loans SET accrued_interest = accrued_interest - ?, outstanding = outstanding - ?,
      status = ? WHERE id = ?`).run(interestPaid, principalPaid, closed ? 'repaid' : l.status, loanId);
    post(db, day, 0, 'loan', loanId, [
      { account: userId, bucket: 'A', amount: -pay, kind: 'LOAN_REPAY' },
      { account: ACC.BANK, bucket: 'A', amount: pay, kind: 'LOAN_REPAY' },
    ]);
    if (closed) {
      applyCreditEvent(db, cfg, userId, wasEarly ? cfg.credit.repayEarly : cfg.credit.repayOnTime,
        wasEarly ? 'REPAY_EARLY' : 'REPAY_ON_TIME', day);
    }
  })();
  return { interestPaid, principalPaid, closed };
}

/** 当前贷款视图（含实时应还 = outstanding + accrued_interest）。 */
export interface LoanView { id: number; principal: Cents; outstanding: Cents; accruedInterest: Cents;
  owedTotal: Cents; rateE6: number; termDays: number; startDay: number; dueDay: number; status: string }

export function listLoans(db: DB, userId: number): LoanView[] {
  const rows = db.prepare(`SELECT * FROM loans WHERE user_id = ?
    ORDER BY status = 'active' DESC, id DESC`).all(userId) as LoanRow[];
  return rows.map(l => ({
    id: l.id, principal: l.principal, outstanding: l.outstanding,
    accruedInterest: l.accrued_interest, owedTotal: owed(l), rateE6: l.rate_e6,
    termDays: l.term_days, startDay: l.start_day, dueDay: l.due_day, status: l.status,
  }));
}

// ---------- 日终结算钩子 ----------

interface OrderRowLike { id: number; user_id: number; code: string; qty: number; filled: number; frozen: number }

/** 结算用的只读行情读取器（组合 ctx.quotes 与 engine.getQuote）。 */
type QuoteLookup = (code: string) => StockQuote | undefined;

export interface LoanHookDeps { db: DB; cfg: Config;
  /** 强平取价入口：结算 tick 优先用 ctx.quotes（当日快照），冷启动兜底查库。 */
  quotes?: QuoteLookup }

/**
 * 每个交易日结算时对每笔未结清贷款执行：
 *   ① 计息（宽限/逾期期罚息 ×penaltyMult）
 *   ② 状态推进：day > due_day → grace；day > due_day + graceDays → overdue（每日 −8 信誉）
 *   ③ day ≥ due_day + graceDays + liqOverdueDay → 强制平仓
 *   ④ 清仓后仍不足 → 破产结算
 */
export class LoanSettlementHook implements SettlementHook {
  private readonly db: DB;
  private readonly cfg: Config;

  constructor(deps: LoanHookDeps) {
    this.db = deps.db;
    this.cfg = deps.cfg;
  }

  onSettlement(ctx: TickCtx): void {
    const loans = this.db.prepare(`SELECT * FROM loans
      WHERE status IN ('active','grace','overdue') ORDER BY user_id, id`).all() as LoanRow[];
    // 已在本 tick 破产结算过的用户跳过后续处理，避免同一日重复清算。
    const settled = new Set<number>();
    for (const l of loans) {
      if (settled.has(l.user_id)) continue;
      if (this.step(l, ctx, settled)) settled.add(l.user_id);
    }
  }

  /** 处理一笔贷款；返回 true 表示该用户已完成强平/破产（后续贷款不再单独处理）。 */
  private step(l: LoanRow, ctx: TickCtx, settled: Set<number>): boolean {
    const { db, cfg } = this;
    const day = ctx.day;
    // ① 计息：宽限/逾期期罚息加倍
    const penalized = l.status !== 'active';
    const rate = l.rate_e6 * (penalized ? cfg.loans.penaltyMult : 1);
    const accrued = accrue(l.outstanding, rate);

    // ② 状态推进（due_day 当天即为最后还款日；进入 due_day 即算到期未还 → 宽限）
    let status = l.status;
    if (status === 'active' && day >= l.due_day) status = 'grace';
    if (status === 'grace' && day >= l.due_day + cfg.loans.graceDays) status = 'overdue';

    db.prepare('UPDATE loans SET accrued_interest = accrued_interest + ?, status = ? WHERE id = ?')
      .run(accrued, status, l.id);

    if (status === 'overdue') {
      applyCreditEvent(db, cfg, l.user_id, cfg.credit.overduePerDay, 'OVERDUE', day);
    }

    // ③ 强平日判定
    const liqDay = l.due_day + cfg.loans.graceDays + cfg.loans.liqOverdueDay;
    if (day >= liqDay && status === 'overdue') {
      this.liquidateUser(l.user_id, ctx, liqDay);
      return true;
    }
    return false;
  }

  /**
   * 强制平仓 + 破产判定：
   *   a) 持仓按市值降序逐只以现价 ×(1−滑点) 全量卖出（费用/印花照收，ledger 同 TRADE_SELL 腿）
   *   b) 以卖出所得 + 现有现金，偿还该用户全部逾期贷（先息后本）
   *   c) 清仓后现金仍不足偿付全部未偿本息 → 破产：剩余现金全额冲抵，其余贷款 forgiven，
   *      credit 置 bankruptcyScore，bankrupt_count+1，MARKET→user 发 reliefCash，
   *      所有 open 订单强制 cancelled 并释放冻结
   */
  private liquidateUser(userId: number, ctx: TickCtx, day: number): void {
    const { db, cfg } = this;
    const quoteOf = (code: string): StockQuote | undefined => ctx.quotes.get(code);

    // a) 清仓
    const holds = db.prepare(`SELECT code, qty_total qt FROM holdings
      WHERE user_id = ? AND qty_total > 0 ORDER BY qty_total * (
        SELECT price FROM stock_state WHERE code = holdings.code) DESC, code ASC`).all(userId) as
      { code: string; qt: number }[];
    for (const h of holds) {
      const q = quoteOf(h.code);
      if (q === undefined) continue; // 停牌/退市：本轮无法卖出，保留持仓
      const slip = cfg.trading.slippageK * Math.sqrt(h.qt / Math.max(1, advOf(db, h.code)));
      const pExec = Math.max(1, Math.max(q.limitDown, Math.round(q.price * (1 - slip))));
      this.forceSell(userId, h.code, h.qt, pExec, ctx);
    }

    // b) 逐一清偿（先息后本）；不足则进入破产
    const open = db.prepare(`SELECT * FROM loans WHERE user_id = ?
      AND status IN ('active','grace','overdue') ORDER BY status = 'overdue' DESC, id ASC`).all(userId) as LoanRow[];
    let bankrupt = false;
    for (const l of open) {
      const avail = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(userId) as
        { a: number }).a;
      if (avail <= 0) { bankrupt = true; break; }
      const need = owed(l);
      const pay = Math.min(avail, need);
      const interestPaid = Math.min(pay, l.accrued_interest);
      const principalPaid = pay - interestPaid;
      const closed = pay === need;
      db.prepare(`UPDATE loans SET accrued_interest = accrued_interest - ?, outstanding = outstanding - ?,
        status = ? WHERE id = ?`).run(interestPaid, principalPaid, closed ? 'liquidated' : l.status, l.id);
      post(db, day, 0, 'loan', l.id, [
        { account: userId, bucket: 'A', amount: -pay, kind: 'LOAN_LIQ' },
        { account: ACC.BANK, bucket: 'A', amount: pay, kind: 'LOAN_LIQ' },
      ]);
      if (!closed) { bankrupt = true; break; }
    }

    applyCreditEvent(db, cfg, userId, cfg.credit.forcedLiq, 'FORCED_LIQ', day);

    if (!bankrupt) return;

    // c) 破产结算（规格 §9："剩余资产清零、债务豁免、信誉置 400、发救济金"）。
    // 顺序：① 撤销全部挂单并释放冻结 → ② 用解冻后的全部现金冲抵债务 → ③ 豁免剩余债务
    //      → ④ 信誉置位/计数 → ⑤ 发救济金。先释放再冲抵，确保冻结资金也被纳入"资产清零"。
    const orders = db.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'open'").all(userId) as OrderRowLike[];
    for (const o of orders) {
      if (o.frozen > 0) {
        post(db, day, ctx.tickInDay, 'order', o.id, [
          { account: userId, bucket: 'F', amount: -o.frozen, kind: 'ORDER_RELEASE' },
          { account: userId, bucket: 'A', amount: o.frozen, kind: 'ORDER_RELEASE' },
        ]);
      }
      db.prepare("UPDATE orders SET status = 'cancelled', frozen = 0 WHERE id = ?").run(o.id);
    }

    const cash = (db.prepare('SELECT cash_available a, cash_frozen f FROM users WHERE id = ?')
      .get(userId) as { a: number; f: number });
    const remaining = db.prepare(`SELECT COALESCE(SUM(outstanding + accrued_interest),0) v FROM loans
      WHERE user_id = ? AND status IN ('active','grace','overdue')`).get(userId) as { v: number };
    if (cash.a > 0) {
      // 剩余现金全额交出：先冲抵债务（不超过应还额），超出部分作为破产罚没入 BANK。
      const toDebt = Math.min(cash.a, remaining.v);
      if (toDebt > 0) {
        post(db, day, 0, 'bankruptcy', userId, [
          { account: userId, bucket: 'A', amount: -toDebt, kind: 'BANKRUPTCY' },
          { account: ACC.BANK, bucket: 'A', amount: toDebt, kind: 'BANKRUPTCY' },
        ]);
      }
      const forfeit = cash.a - toDebt;
      if (forfeit > 0) {
        post(db, day, 0, 'bankruptcy', userId, [
          { account: userId, bucket: 'A', amount: -forfeit, kind: 'BANKRUPTCY_FORFEIT' },
          { account: ACC.BANK, bucket: 'A', amount: forfeit, kind: 'BANKRUPTCY_FORFEIT' },
        ]);
      }
    }
    // 债务豁免
    db.prepare(`UPDATE loans SET outstanding = 0, accrued_interest = 0, status = 'forgiven'
      WHERE user_id = ? AND status IN ('active','grace','overdue')`).run(userId);
    // 信誉置位 + 计数
    setCredit(db, cfg, userId, cfg.credit.bankruptcyScore, 'BANKRUPTCY', day);
    db.prepare('UPDATE users SET bankrupt_count = bankrupt_count + 1, cash_frozen = 0 WHERE id = ?')
      .run(userId);
    // 救济金：以"最低生活保障"名义发放，避免"梭哈失败重开"成为优势策略
    post(db, day, 0, 'relief', userId, [
      { account: ACC.MARKET, bucket: 'A', amount: -cfg.loans.reliefCash, kind: 'RELIEF' },
      { account: userId, bucket: 'A', amount: cfg.loans.reliefCash, kind: 'RELIEF' },
    ]);
  }

  /** 强平单笔卖出（不走订单簿，直接以 pExec 全额成交）。
   *  trades.order_id 为 NOT NULL 且引用 orders(id)，故为强平补一张
   *  立即可见的"系统强平单"（type='M'、client_key 唯一、status='done'），
   *  使成交明细可回溯、又不进入订单簿。 */
  private forceSell(userId: number, code: string, qty: number, price: number, ctx: TickCtx): void {
    const { db } = this;
    const amount = price * qty;
    const comm = commission(amount), tf = transferFee(amount), stamp = stampTax(amount);
    const net = amount - comm - tf - stamp;
    const h = db.prepare('SELECT qty_total qt, cost_total ct FROM holdings WHERE user_id = ? AND code = ?')
      .get(userId, code) as { qt: number; ct: number } | undefined;
    const qtBefore = h?.qt ?? 0, ctBefore = h?.ct ?? 0;
    const costOut = qtBefore > 0 ? roundHalfUpDiv(ctBefore * qty, qtBefore) : 0;

    const orderId = Number(db.prepare(`INSERT INTO orders(user_id, code, side, type, price, qty,
      filled, frozen, status, client_key, day, created_tick)
      VALUES (?,?,'S','M',?,?,?,0,'done',?,?,?)`)
      .run(userId, code, price, qty, qty, `liq-${ctx.day}-${ctx.tickInDay}-${userId}-${code}`,
        ctx.day, ctx.tickInDay).lastInsertRowid);

    const r = db.prepare(`INSERT INTO trades(order_id, user_id, code, side, price, qty,
      commission, stamp, transfer, day, tick) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderId, userId, code, 'S', price, qty, comm, stamp, tf, ctx.day, ctx.tickInDay);
    const tradeId = Number(r.lastInsertRowid);
    const legs: Leg[] = [
      { account: ACC.MARKET, bucket: 'A', amount: -amount, kind: 'FORCED_SELL' },
      { account: userId, bucket: 'A', amount: net, kind: 'FORCED_SELL' },
      { account: ACC.CLEARING, bucket: 'A', amount: comm + tf, kind: 'FORCED_SELL' },
      { account: ACC.TAX, bucket: 'A', amount: stamp, kind: 'FORCED_SELL' },
    ];
    post(db, ctx.day, ctx.tickInDay, 'trade', tradeId, legs);
    if (qtBefore - qty <= 0) {
      db.prepare('DELETE FROM holdings WHERE user_id = ? AND code = ?').run(userId, code);
    } else {
      // 部分卖出（当前强平总是全量，保留分支以防未来改成分批卖）：可卖量同样递减并夹到 0。
      db.prepare(`UPDATE holdings SET qty_total = qty_total - ?,
        qty_sellable = MAX(0, qty_sellable - ?),
        cost_total = cost_total - ? WHERE user_id = ? AND code = ?`)
        .run(qty, qty, costOut, userId, code);
    }
  }
}

function advOf(db: DB, code: string): number {
  return (db.prepare('SELECT adv FROM stock_state WHERE code = ?').get(code) as { adv: number }).adv;
}

/** 引擎当前 day（与 api/app.ts 同口径，避免重复实现漂移）。 */
function engineDayOf(db: DB): number { return engineDay(db); }
