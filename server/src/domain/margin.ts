// domain/margin.ts —— 融资融券（信用交易）：开户、融资买入、融券卖出、卖券还款、买券还券、
// 直接还款、维持担保比例、逐日计息与「T+1 追保 → 强制平仓」。
//
// 与 NPC 银行贷款（domain/loans.ts）是**两套东西**，不要互相套用：
//   loans  = 无抵押信用贷，钱到手随便花，按信誉分定额度；
//   margin = 有担保的杠杆交易，钱只能买指定标的，实时受维持担保比例约束。
//
// 现实规则（A 股）在本模块的落点：
//   · 保证金比例 initRatioE6（默认 500_000 = 50%）：
//     融资买入金额 A 中自有保证金 = A × 比例，券商借出 A − 保证金。
//     开仓后维持担保比例 = A / (A − 保证金) = 200%（纯融资）。
//   · 融券卖出所得**全部冻结**，另需自备同比例的保证金；两者都冻结在 F 桶。
//     开仓后维持担保比例 = (保证金 + 卖出净额) / 融券市值 = 150%。
//   · 维持担保比例 = (现金 + 全部持仓市值) / (融资负债 + 融券市值 + 利息费用)。
//     跌破警戒线 150% → 不能再开新仓；跌破平仓线 130% → 进入追保，
//     **T+1 日结算仍未补足即强制平仓**。
//
// ⚠️ 三个最容易写错的地方，下面都有专门注释：
//   ① 担保物口径 = **全部**现金与持仓，不是只算信用持仓（见 marginState 注释）；
//   ② 融资买入的股票仍进 holdings，靠新增的 qty_margin 列标记「不可卖」；
//   ③ 债务**不进 ledger**（ledger 记现金流向，不记债权），故「豁免债务」不会让
//      auditGlobal 失衡 —— 放款那天的 `BANK -X / user +X` 才是唯一的记账点。
import type { DB } from '../db/database.js';
import { ACC } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { SettlementHook, TickCtx } from '../engine/types.js';
import { commission, stampTax, transferFee, roundHalfUpDiv, type Cents } from '../core/money.js';
import { post, type Leg } from '../core/ledger.js';
import { applyCreditEvent } from './credit.js';
import { engineDay } from '../core/clock.js';
import { AppError } from '../api/app.js';

/**
 * 按 e6 比例取整（四舍五入到分）：`base × e6 / 1e6`。
 *
 * ⚠️ 不能写成 `roundHalfUpDiv(base * e6, 1_000_000)`：`base` 是分（可达 1e12 量级），
 * `e6` 可达 1e6，两者相乘会突破 `Number.MAX_SAFE_INTEGER`（9.007e15），
 * 而 `roundHalfUpDiv` 对非安全整数会抛 `bad dividend` → 500。
 * 先做浮点除法再乘，把中间量压回安全范围。
 */
function mulE6(base: Cents, e6: number): Cents {
  return Math.round(base * (e6 / 1_000_000));
}

// ---------- 行类型 ----------

export interface MarginAccountRow {
  user_id: number; debt: Cents; interest: Cents; opened_day: number;
  warn_since_day: number | null; liquidated_count: number;
}

export interface MarginPositionRow {
  user_id: number; code: string; kind: 'long' | 'short';
  qty: number; cost: Cents; frozen: Cents; opened_day: number;
}

interface QuoteRow { code: string; name: string; status: string; price: number;
  limitUp: number; limitDown: number; adv: number }

// ---------- 基础读取 ----------

export function marginAccount(db: DB, userId: number): MarginAccountRow | null {
  return (db.prepare('SELECT * FROM margin_accounts WHERE user_id = ?').get(userId) as
    MarginAccountRow | undefined) ?? null;
}

export function isMarginOpen(db: DB, userId: number): boolean {
  return marginAccount(db, userId) !== null;
}

function creditOf(db: DB, userId: number): number {
  const r = db.prepare('SELECT credit c FROM users WHERE id = ?').get(userId) as
    { c: number } | undefined;
  if (r === undefined) throw new AppError('UNAUTHORIZED', 401, 'not logged in');
  return r.c;
}

function cashAvailable(db: DB, userId: number): Cents {
  return (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(userId) as
    { a: number }).a;
}

function cashFrozen(db: DB, userId: number): Cents {
  return (db.prepare('SELECT cash_frozen f FROM users WHERE id = ?').get(userId) as
    { f: number }).f;
}

function quoteOf(db: DB, code: string): QuoteRow | undefined {
  return db.prepare(`SELECT s.code, s.name, s.status, t.price, t.limit_up limitUp,
      t.limit_down limitDown, t.adv
    FROM stocks s JOIN stock_state t ON t.code = s.code WHERE s.code = ?`).get(code) as
    QuoteRow | undefined;
}

/** 可交易标的（存在、未退市、有有效价）。 */
function tradableQuote(db: DB, code: string): QuoteRow {
  const q = quoteOf(db, code);
  if (q === undefined || q.status === 'delisted') {
    throw new AppError('BAD_CODE', 404, 'stock not found or delisted');
  }
  if (!Number.isInteger(q.price) || q.price <= 0) {
    throw new AppError('BAD_CODE', 409, 'stock has no valid price');
  }
  return q;
}

function advOf(db: DB, code: string): number {
  return (db.prepare('SELECT adv FROM stock_state WHERE code = ?').get(code) as
    { adv: number } | undefined)?.adv ?? 1;
}

function requireAccount(db: DB, userId: number): MarginAccountRow {
  const a = marginAccount(db, userId);
  if (a === null) throw new AppError('MARGIN_NOT_OPEN', 403, 'margin account not opened');
  return a;
}

function loadPosition(db: DB, userId: number, code: string,
    kind: 'long' | 'short'): MarginPositionRow | null {
  return (db.prepare('SELECT * FROM margin_positions WHERE user_id = ? AND code = ? AND kind = ?')
    .get(userId, code, kind) as MarginPositionRow | undefined) ?? null;
}

// ---------- 开户 ----------

/** 开通信用账户：信誉分 ≥ `margin.minCredit`。幂等（重复开通不报错）。 */
export function openMarginAccount(db: DB, cfg: Config, userId: number): void {
  if (creditOf(db, userId) < cfg.margin.minCredit) {
    throw new AppError('CREDIT_LOW', 403,
      `credit score must be >= ${cfg.margin.minCredit} to open a margin account`);
  }
  db.prepare(`INSERT OR IGNORE INTO margin_accounts(user_id, debt, interest, opened_day,
    warn_since_day, liquidated_count) VALUES (?,0,0,?,NULL,0)`).run(userId, engineDay(db));
}

// ---------- 账户视图 ----------

export interface MarginPositionView {
  code: string; name: string; kind: 'long' | 'short';
  qty: number; cost: Cents; price: Cents; marketValue: Cents;
  /** 浮盈（分）：多头 = 市值 − 成本；空头 = 卖出净额 − 当前市值。 */
  pnl: Cents; pnlPct: number;
  /** 该笔空头冻结在 F 桶的资金（多头恒为 0）。 */
  frozen: Cents; openedDay: number;
}

export interface MarginState {
  open: boolean;
  /** 开通门槛（信誉分）。 */
  minCredit: number;
  /** 当前信誉分是否够开通。 */
  eligible: boolean;
  credit: number;

  debt: Cents; interest: Cents;
  /** 融资负债本息合计 = debt + interest。 */
  owedTotal: Cents;
  /** 融券市值合计。 */
  shortValue: Cents;
  /** 总负债 = owedTotal + shortValue。 */
  liability: Cents;
  /** 担保物 = 现金（A+F）+ 全部持仓市值。 */
  collateral: Cents;
  cash: Cents;
  positionsValue: Cents;

  /** 维持担保比例（1.0 = 100%）；无负债时为 null（不是 0，也不是 Infinity —— 前端要能区分）。 */
  ratio: number | null;
  /** 同上，乘 1e6 取整后的整数，便于前端与阈值直接比较、避免浮点误差。 */
  ratioE6: number | null;

  /** ok = 可开新仓；warn = 低于警戒线（禁止开仓）；call = 低于平仓线（追保中）。 */
  status: 'ok' | 'warn' | 'call';
  canOpen: boolean;
  warnSinceDay: number | null;
  liquidatedCount: number;

  /** 融资负债上限 = 信誉分 × maxDebtPerCreditPoint。 */
  creditCap: Cents;
  /** 还能再借多少（融资负债上限 − 当前本金负债），下限 0。 */
  debtRoom: Cents;
  /** 还能融资买入多少**金额**（同时受可用现金与负债上限约束），下限 0。 */
  maxFinanceCents: Cents;
  /** 还能融券卖出多少**金额**（受可用现金与负债上限约束），下限 0。 */
  maxShortCents: Cents;

  positions: MarginPositionView[];
}

/**
 * 账户全景（纯读）。`financeBuy` / `shortSell` 的闸门与 `GET /api/margin` 都走它，
 * 保证「UI 说能买」与「服务端放行」不可能漂移（与 `borrowRoom` 同一条教训）。
 *
 * ⚠️ 担保物口径 = 该用户的**全部现金 + 全部持仓市值**，不是只算信用持仓。
 *    原因：本游戏不把信用账户与普通账户分家 —— `ledger.bucket` 只有 'A'/'F' 两桶，
 *    另开一个「信用现金」桶会让 `auditUser` 的勾稽（Σ ledger(A) === cash_available）
 *    失守。钱是同一个口袋里的，所以担保物也只能按同一个口袋算。
 *    副作用是「净资产越大越不容易被强平」，这与现实一致（现实里你也可以随时往
 *    信用账户补钱），且被 `maxDebtPerCreditPoint` 从绝对额上兜住。
 */
export function marginState(db: DB, cfg: Config, userId: number): MarginState {
  const acct = marginAccount(db, userId);
  const credit = creditOf(db, userId);
  const cashA = cashAvailable(db, userId), cashF = cashFrozen(db, userId);

  const positionsValue = (db.prepare(`SELECT COALESCE(SUM(
        CASE WHEN s.status = 'delisted' THEN 0 ELSE h.qty_total * t.price END), 0) v
      FROM holdings h
      JOIN stocks s ON s.code = h.code
      JOIN stock_state t ON t.code = h.code
      WHERE h.user_id = ? AND h.qty_total > 0`).get(userId) as { v: number }).v;

  const rows = db.prepare(`SELECT p.code, s.name, p.kind, p.qty, p.cost, p.frozen, p.opened_day od,
      CASE WHEN s.status = 'delisted' THEN 0 ELSE t.price END price
    FROM margin_positions p
    JOIN stocks s ON s.code = p.code
    JOIN stock_state t ON t.code = p.code
    WHERE p.user_id = ? ORDER BY p.kind, p.code`).all(userId) as
    { code: string; name: string; kind: 'long' | 'short'; qty: number; cost: Cents;
      frozen: Cents; od: number; price: number }[];

  const positions: MarginPositionView[] = rows.map(r => {
    const mv = r.qty * r.price;
    const pnl = r.kind === 'long' ? mv - r.cost : r.cost - mv;
    return {
      code: r.code, name: r.name, kind: r.kind, qty: r.qty, cost: r.cost, price: r.price,
      marketValue: mv, pnl, pnlPct: r.cost > 0 ? pnl / r.cost : 0,
      frozen: r.frozen, openedDay: r.od,
    };
  });

  const shortValue = positions.reduce((s, p) => s + (p.kind === 'short' ? p.marketValue : 0), 0);
  const debt = acct?.debt ?? 0, interest = acct?.interest ?? 0;
  const owedTotal = debt + interest;
  const liability = owedTotal + shortValue;
  const cash = cashA + cashF;
  const collateral = cash + positionsValue;

  // 无负债时比例没有意义：返回 null 而不是 Infinity —— 前端要把它渲染成「—」，
  // 而 JSON 里 Infinity 会被序列化成 null，等于两个语义不同的状态撞在一起。
  const ratio = liability > 0 ? collateral / liability : null;
  const ratioE6 = ratio === null ? null : Math.round(ratio * 1_000_000);
  const status: MarginState['status'] = ratioE6 === null || ratioE6 >= cfg.margin.warnRatioE6
    ? 'ok'
    : ratioE6 >= cfg.margin.liqRatioE6 ? 'warn' : 'call';

  const eligible = credit >= cfg.margin.minCredit;
  const creditCap = credit * cfg.margin.maxDebtPerCreditPoint;
  const debtRoom = Math.max(0, creditCap - debt);
  // 融资买入金额 A 需满足：自有保证金 A×initRatio ≤ 可用现金；
  // 借入额 A×(1−initRatio) ≤ 负债空间。两条都换算成 A 的上限再取小。
  const init = cfg.margin.initRatioE6;
  const lev = 1_000_000 - init;
  // 融资：占用现金 = 金额×比例 + 买入费用。费用用「万 8」这个略高的固定费率做上界估算
  // —— **宁可少报也不能多报**：报多了玩家点下去必被服务端拒（INSUFFICIENT_CASH），
  // 那正是 borrowRoom 注释里记着的那类事故。真正的闸门仍在 financeBuy 里按真实费用算。
  const maxFinanceCents = (acct === null || init <= 0) ? 0 : Math.max(0, Math.min(
    Math.floor(cashA / (init / 1_000_000 + 0.0008)),
    lev > 0 ? Math.floor(debtRoom * 1_000_000 / lev) : 0,
  ));
  // 融券：占用现金 = 金额×比例 + 费用。费用是阶梯+按比例的混合（佣金有 500 分保底），
  // 这里用「万 8」这个略高的固定费率做上界估算 —— **宁可少报也不能多报**：
  // 报多了玩家点下去必被服务端拒（INSUFFICIENT_CASH），那正是 borrowRoom 注释里
  // 记着的那类事故。真正的闸门仍在 shortSell 里按真实费用算。
  const maxShortCents = (acct === null || init <= 0) ? 0 : Math.max(0, Math.min(
    Math.floor(cashA / (init / 1_000_000 + 0.0008)),
    debtRoom,
  ));

  return {
    open: acct !== null, minCredit: cfg.margin.minCredit, eligible, credit,
    debt, interest, owedTotal, shortValue, liability, collateral, cash, positionsValue,
    ratio, ratioE6, status,
    canOpen: acct !== null && eligible && status === 'ok',
    warnSinceDay: acct?.warn_since_day ?? null,
    liquidatedCount: acct?.liquidated_count ?? 0,
    creditCap, debtRoom, maxFinanceCents, maxShortCents, positions,
  };
}

// ---------- 写路径 ----------

function assertQty(qty: number): void {
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    throw new AppError('BAD_QTY', 400, 'qty must be a positive integer');
  }
}

function requireMinOrder(cfg: Config, amount: Cents): void {
  if (amount < cfg.margin.minOrderCents) {
    throw new AppError('BAD_AMOUNT', 400, `order amount must be >= ${cfg.margin.minOrderCents}`);
  }
}

/** 低于警戒线一律不许开新仓（A 股规则：维持担保比例低于警戒线时禁止融资买入/融券卖出）。 */
function requireOpenable(db: DB, cfg: Config, userId: number): void {
  const st = marginState(db, cfg, userId);
  if (st.ratioE6 !== null && st.ratioE6 < cfg.margin.warnRatioE6) {
    throw new AppError('MARGIN_CALL', 403,
      'maintenance ratio is below the warning line; no new margin positions allowed');
  }
}

/**
 * 系统单的 `client_key`。`orders` 有 `UNIQUE(user_id, client_key)`，而强平/信用交易
 * 可能在同一 tick 对同一只股票连续下多张单，所以不能用「日期+股票」这种粗粒度键。
 * 取「当前最大 id + 1」做序号：插入后 max(id) 立即增长，故同一事务内连续调用天然唯一。
 * （orders 行从不删除，故跨事务也不会撞。）
 */
function systemClientKey(db: DB, tag: string): string {
  const next = (db.prepare('SELECT COALESCE(MAX(id), 0) + 1 v FROM orders').get() as
    { v: number }).v;
  return `${tag}-${next}`;
}

interface SystemFill { orderId: number; tradeId: number }

/**
 * 补一张「立即可见的系统单」+ 一条成交。
 *
 * 为什么要补订单：`trades.order_id` 是 `NOT NULL REFERENCES orders(id)`，
 * 而融资买入/融券卖出/强平都**不走订单簿**（担保品必须立刻可估值，挂单会引入
 * 「未成交但已计息」的歧义），所以直接成交前必须自己造一张 `type='M'`、`status='done'`
 * 的订单行，否则成交明细无法回溯。
 */
function insertSystemFill(db: DB, day: number, tick: number, userId: number, code: string,
    side: 'B' | 'S', price: Cents, qty: number, comm: Cents, stamp: Cents, tf: Cents,
    tag: string): SystemFill {
  const orderId = Number(db.prepare(`INSERT INTO orders(user_id, code, side, type, price, qty,
      filled, frozen, status, client_key, day, created_tick)
      VALUES (?,?,?,'M',?,?,?,0,'done',?,?,?)`)
    .run(userId, code, side, price, qty, qty, systemClientKey(db, tag), day, tick).lastInsertRowid);
  const tradeId = Number(db.prepare(`INSERT INTO trades(order_id, user_id, code, side, price, qty,
      commission, stamp, transfer, day, tick) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orderId, userId, code, side, price, qty, comm, stamp, tf, day, tick).lastInsertRowid);
  return { orderId, tradeId };
}

/** 融资买入的股票进 holdings，并记下「其中多少是担保物」（不可卖）。 */
function addMarginHolding(db: DB, userId: number, code: string, qty: number, cost: Cents): void {
  db.prepare(`INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total, qty_margin)
    VALUES (?,?,?,0,?,?)
    ON CONFLICT(user_id, code) DO UPDATE SET
      qty_total = qty_total + excluded.qty_total,
      cost_total = cost_total + excluded.cost_total,
      qty_margin = qty_margin + excluded.qty_margin`)
    .run(userId, code, qty, cost, qty);
}

/**
 * 卖掉一部分担保股票。
 *
 * ⚠️ 只递减 qty_total / qty_margin / cost_total，**不动 qty_sellable** ——
 * 卖掉的本来就是不可卖的那部分，动了会把「可卖量」越算越少（甚至负）。
 * 不变式：`qty_sellable ≤ qty_total − qty_margin`。
 */
function reduceMarginHolding(db: DB, userId: number, code: string, qty: number,
    costOut: Cents): void {
  const h = db.prepare('SELECT qty_total qt FROM holdings WHERE user_id = ? AND code = ?')
    .get(userId, code) as { qt: number } | undefined;
  if (h === undefined) return;
  const left = h.qt - qty;
  if (left <= 0) {
    db.prepare(`UPDATE holdings SET qty_total = 0, qty_sellable = 0, qty_margin = 0,
      cost_total = 0 WHERE user_id = ? AND code = ?`).run(userId, code);
    return;
  }
  db.prepare(`UPDATE holdings SET qty_total = ?, qty_margin = MAX(0, qty_margin - ?),
    cost_total = MAX(0, cost_total - ?) WHERE user_id = ? AND code = ?`)
    .run(left, qty, costOut, userId, code);
}

/** 按持仓比例分摊成本（与 matcher 的 costOut 同口径）。 */
function holdingCostOut(db: DB, userId: number, code: string, qty: number): Cents {
  const h = db.prepare('SELECT qty_total qt, cost_total ct FROM holdings WHERE user_id = ? AND code = ?')
    .get(userId, code) as { qt: number; ct: number } | undefined;
  if (h === undefined || h.qt <= 0) return 0;
  return roundHalfUpDiv(h.ct * qty, h.qt);
}

function upsertPosition(db: DB, userId: number, code: string, kind: 'long' | 'short',
    qty: number, cost: Cents, frozen: Cents, day: number): void {
  db.prepare(`INSERT INTO margin_positions(user_id, code, kind, qty, cost, frozen, opened_day)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id, code, kind) DO UPDATE SET
      qty = qty + excluded.qty, cost = cost + excluded.cost,
      frozen = frozen + excluded.frozen`)
    .run(userId, code, kind, qty, cost, frozen, day);
}

/** 减仓（qty 与 cost 按比例分摊；减到 0 就删行，`margin_positions.qty > 0` 是 CHECK 约束）。 */
function reducePosition(db: DB, userId: number, code: string, kind: 'long' | 'short',
    qty: number, costOut: Cents, frozenOut: Cents): void {
  const p = loadPosition(db, userId, code, kind);
  if (p === null) return;
  const left = p.qty - qty;
  if (left <= 0) {
    db.prepare('DELETE FROM margin_positions WHERE user_id = ? AND code = ? AND kind = ?')
      .run(userId, code, kind);
    return;
  }
  db.prepare(`UPDATE margin_positions SET qty = ?, cost = MAX(0, cost - ?),
    frozen = MAX(0, frozen - ?) WHERE user_id = ? AND code = ? AND kind = ?`)
    .run(left, costOut, frozenOut, userId, code, kind);
}

export interface MarginTradeResult {
  orderId: number; tradeId: number; code: string; qty: number; price: Cents;
  /** 成交金额（分，不含费）。 */
  amount: Cents;
  /** 费用合计（分）。 */
  fees: Cents;
  /** 本次借入额（融券恒为 0）。 */
  loanAmount: Cents;
  /** 本次占用的自有保证金（分）。 */
  marginUsed: Cents;
}

/**
 * 融资买入。
 *
 * 门槛（按此顺序，先到先拒）：
 *   1 已开通信用账户（MARGIN_NOT_OPEN）
 *   2 标的可交易、有有效价（BAD_CODE）
 *   3 维持担保比例 ≥ 警戒线（MARGIN_CALL）
 *   4 单笔金额 ≥ margin.minOrderCents（BAD_AMOUNT）
 *   5 可用现金 ≥ 自有保证金 + 费用（INSUFFICIENT_CASH）
 *   6 借入额 ≤ 融资负债上限 − 已欠本金（MARGIN_LIMIT）
 *
 * 记账（一次性多条腿，`post` 会逐腿检查用户余额不得为负）：
 *   BANK −借入额 → user(A) +借入额            ← 放款（唯一的记账点）
 *   user(A) −(成交额+费) → MARKET +成交额 / CLEARING +费   ← 买股票
 * 用户净现金变化 = −(保证金 + 费)，正是「自己掏的那部分」。
 */
export function financeBuy(db: DB, cfg: Config, userId: number, code: string,
    qty: number): MarginTradeResult {
  assertQty(qty);
  requireAccount(db, userId);
  const q = tradableQuote(db, code);
  requireOpenable(db, cfg, userId);

  const amount = q.price * qty;
  requireMinOrder(cfg, amount);
  const marginUsed = mulE6(amount, cfg.margin.initRatioE6);
  const loanAmount = amount - marginUsed;
  const comm = commission(amount), tf = transferFee(amount);
  const total = amount + comm + tf;

  if (cashAvailable(db, userId) < marginUsed + comm + tf) {
    throw new AppError('INSUFFICIENT_CASH', 400,
      `need ${marginUsed + comm + tf} available cash for the margin portion`);
  }
  const st = marginState(db, cfg, userId);
  if (loanAmount > st.debtRoom) {
    throw new AppError('MARGIN_LIMIT', 403, `exceeds margin debt cap ${st.creditCap}`);
  }

  const day = engineDay(db);
  const result: MarginTradeResult = {
    orderId: 0, tradeId: 0, code, qty, price: q.price, amount, fees: comm + tf,
    loanAmount, marginUsed,
  };
  db.transaction(() => {
    const fill = insertSystemFill(db, day, 0, userId, code, 'B', q.price, qty, comm, 0, tf, 'mgf');
    post(db, day, 0, 'trade', fill.tradeId, [
      { account: ACC.BANK, bucket: 'A', amount: -loanAmount, kind: 'MARGIN_FINANCE' },
      { account: userId, bucket: 'A', amount: loanAmount, kind: 'MARGIN_FINANCE' },
      { account: userId, bucket: 'A', amount: -total, kind: 'MARGIN_BUY' },
      { account: ACC.MARKET, bucket: 'A', amount, kind: 'MARGIN_BUY' },
      { account: ACC.CLEARING, bucket: 'A', amount: comm + tf, kind: 'MARGIN_BUY' },
    ]);
    addMarginHolding(db, userId, code, qty, total);
    upsertPosition(db, userId, code, 'long', qty, total, 0, day);
    db.prepare('UPDATE margin_accounts SET debt = debt + ? WHERE user_id = ?').run(loanAmount, userId);
    result.orderId = fill.orderId;
    result.tradeId = fill.tradeId;
  })();
  return result;
}

/**
 * 融券卖出（做空）。
 *
 * 门槛与融资买入相同（含维持担保比例 ≥ 警戒线），另加：
 *   · 可用现金 ≥ 自备保证金（amount × 比例）；
 *   · 名义金额 ≤ 融资负债上限 − 已欠本金（券源也要占额度，否则可以无限做空）。
 *
 * 记账：
 *   MARKET −成交额 → user(A) +卖出净额 / CLEARING +费 / TAX +印花税   ← 卖出
 *   user(A) −(净额+自备保证金) → user(F) +(净额+自备保证金)          ← 全额冻结作担保
 * 用户净现金变化 = −自备保证金。冻结额 = 卖出净额 + 自备保证金，
 * 故开仓后维持担保比例 = 1.5（默认 50% 保证金比例时）。
 */
export function shortSell(db: DB, cfg: Config, userId: number, code: string,
    qty: number): MarginTradeResult {
  assertQty(qty);
  requireAccount(db, userId);
  const q = tradableQuote(db, code);
  requireOpenable(db, cfg, userId);

  const amount = q.price * qty;
  requireMinOrder(cfg, amount);
  const comm = commission(amount), tf = transferFee(amount), stamp = stampTax(amount);
  const fees = comm + tf + stamp;
  const net = amount - fees;
  if (net <= 0) throw new AppError('BAD_AMOUNT', 400, 'order too small to cover fees');
  // ⚠️ 保证金 = 卖出金额 × 比例 **+ 卖出费用**，不是单纯的「比例 × 金额」。
  //    卖出所得是**扣费后**的净额，若不把费用补进保证金，开仓瞬间的维持担保比例会是
  //    `(0.5A + A − fee) / A ≈ 149.9%` —— **低于 150% 警戒线**。后果不是数字难看，
  //    而是玩家一开仓就再也开不了第二笔，偏偏此时账上现金已经见底，只能干等股价下跌。
  //    补上费用后，冻结额 = 净额 + 保证金 = 1.5A，开仓瞬间正好 150%。
  const marginUsed = mulE6(amount, cfg.margin.initRatioE6) + fees;
  if (cashAvailable(db, userId) < marginUsed) {
    throw new AppError('INSUFFICIENT_CASH', 400,
      `need ${marginUsed} available cash as short margin`);
  }
  const st = marginState(db, cfg, userId);
  if (amount > st.debtRoom) {
    throw new AppError('MARGIN_LIMIT', 403, `exceeds margin debt cap ${st.creditCap}`);
  }

  const day = engineDay(db);
  const frozen = net + marginUsed;
  const result: MarginTradeResult = {
    orderId: 0, tradeId: 0, code, qty, price: q.price, amount, fees,
    loanAmount: 0, marginUsed,
  };
  db.transaction(() => {
    const fill = insertSystemFill(db, day, 0, userId, code, 'S', q.price, qty, comm, stamp, tf, 'mgs');
    const legs: Leg[] = [
      { account: ACC.MARKET, bucket: 'A', amount: -amount, kind: 'MARGIN_SHORT' },
      { account: ACC.CLEARING, bucket: 'A', amount: comm + tf, kind: 'MARGIN_SHORT' },
      { account: ACC.TAX, bucket: 'A', amount: stamp, kind: 'MARGIN_SHORT' },
      { account: userId, bucket: 'A', amount: net, kind: 'MARGIN_SHORT' },
      // 卖出所得 + 自备保证金一并 A→F 冻结（A 桶只是中转，随后全额转出）
      { account: userId, bucket: 'A', amount: -(net + marginUsed), kind: 'MARGIN_FREEZE' },
      { account: userId, bucket: 'F', amount: frozen, kind: 'MARGIN_FREEZE' },
    ];
    post(db, day, 0, 'trade', fill.tradeId, legs);
    upsertPosition(db, userId, code, 'short', qty, net, frozen, day);
    result.orderId = fill.orderId;
    result.tradeId = fill.tradeId;
  })();
  return result;
}

export interface SellRepayResult extends MarginTradeResult {
  interestPaid: Cents; principalPaid: Cents; owedLeft: Cents;
}

/**
 * 卖券还款：卖掉融资买入的担保股票，所得优先冲抵负债（先息后本），剩余留在可用现金。
 * 不足部分不追缴（负债继续按日计息），故这是玩家主动降杠杆的主要手段。
 */
export function sellToRepay(db: DB, cfg: Config, userId: number, code: string,
    qty: number): SellRepayResult {
  assertQty(qty);
  const acct = requireAccount(db, userId);
  const q = tradableQuote(db, code);
  const pos = loadPosition(db, userId, code, 'long');
  if (pos === null) throw new AppError('POSITION_NOT_FOUND', 404, 'no financed position in this code');
  if (qty > pos.qty) throw new AppError('BAD_QTY', 400, `exceeds position ${pos.qty}`);

  const amount = q.price * qty;
  const comm = commission(amount), tf = transferFee(amount), stamp = stampTax(amount);
  const net = amount - comm - tf - stamp;
  const owed = acct.debt + acct.interest;
  const pay = Math.min(net, owed);
  const interestPaid = Math.min(pay, acct.interest);
  const principalPaid = pay - interestPaid;
  const costOut = holdingCostOut(db, userId, code, qty);
  const posCostOut = roundHalfUpDiv(pos.cost * qty, pos.qty);

  const day = engineDay(db);
  db.transaction(() => {
    const fill = insertSystemFill(db, day, 0, userId, code, 'S', q.price, qty, comm, stamp, tf, 'mgx');
    post(db, day, 0, 'trade', fill.tradeId, [
      { account: ACC.MARKET, bucket: 'A', amount: -amount, kind: 'MARGIN_SELL_REPAY' },
      { account: userId, bucket: 'A', amount: net, kind: 'MARGIN_SELL_REPAY' },
      { account: ACC.CLEARING, bucket: 'A', amount: comm + tf, kind: 'MARGIN_SELL_REPAY' },
      { account: ACC.TAX, bucket: 'A', amount: stamp, kind: 'MARGIN_SELL_REPAY' },
      { account: userId, bucket: 'A', amount: -pay, kind: 'MARGIN_REPAY' },
      { account: ACC.BANK, bucket: 'A', amount: pay, kind: 'MARGIN_REPAY' },
    ]);
    reduceMarginHolding(db, userId, code, qty, costOut);
    reducePosition(db, userId, code, 'long', qty, posCostOut, 0);
    db.prepare('UPDATE margin_accounts SET debt = debt - ?, interest = interest - ? WHERE user_id = ?')
      .run(principalPaid, interestPaid, userId);
  })();
  return {
    orderId: 0, tradeId: 0, code, qty, price: q.price, amount, fees: comm + tf + stamp,
    loanAmount: 0, marginUsed: 0, interestPaid, principalPaid,
    owedLeft: Math.max(0, owed - pay),
  };
}

export interface BuyCoverResult extends MarginTradeResult {
  /** 本次从 F 桶解冻的金额（分）。 */
  released: Cents;
}

/**
 * 买券还券：买回等量股票还给券商，资金优先来自该笔空头冻结的担保金
 * （按 `frozen × 还券量 / 持仓量` 比例解冻），不足的部分由可用现金补。
 * 股票涨了就可能要倒贴现金 —— 这正是做空的风险。
 */
export function buyToCover(db: DB, cfg: Config, userId: number, code: string,
    qty: number): BuyCoverResult {
  assertQty(qty);
  requireAccount(db, userId);
  const q = tradableQuote(db, code);
  const pos = loadPosition(db, userId, code, 'short');
  if (pos === null) throw new AppError('POSITION_NOT_FOUND', 404, 'no short position in this code');
  if (qty > pos.qty) throw new AppError('BAD_QTY', 400, `exceeds position ${pos.qty}`);

  const amount = q.price * qty;
  const comm = commission(amount), tf = transferFee(amount);
  const cost = amount + comm + tf;
  const released = roundHalfUpDiv(pos.frozen * qty, pos.qty);
  const fromF = Math.min(cost, released);
  const fromA = cost - fromF;
  if (cashAvailable(db, userId) < fromA) {
    throw new AppError('INSUFFICIENT_CASH', 400, `need ${fromA} available cash to buy back`);
  }
  const posCostOut = roundHalfUpDiv(pos.cost * qty, pos.qty);

  const day = engineDay(db);
  db.transaction(() => {
    const fill = insertSystemFill(db, day, 0, userId, code, 'B', q.price, qty, comm, 0, tf, 'mgb');
    post(db, day, 0, 'trade', fill.tradeId, [
      { account: userId, bucket: 'F', amount: -released, kind: 'MARGIN_UNFREEZE' },
      { account: userId, bucket: 'A', amount: released, kind: 'MARGIN_UNFREEZE' },
      { account: userId, bucket: 'A', amount: -cost, kind: 'MARGIN_BUY_COVER' },
      { account: ACC.MARKET, bucket: 'A', amount, kind: 'MARGIN_BUY_COVER' },
      { account: ACC.CLEARING, bucket: 'A', amount: comm + tf, kind: 'MARGIN_BUY_COVER' },
    ]);
    reducePosition(db, userId, code, 'short', qty, posCostOut, released);
  })();
  return {
    orderId: 0, tradeId: 0, code, qty, price: q.price, amount, fees: comm + tf,
    loanAmount: 0, marginUsed: 0, released,
  };
}

export interface RepayMarginResult { interestPaid: Cents; principalPaid: Cents; owedLeft: Cents }

/** 直接还款（现金 → 券商），先息后本。追保时把比例抬回去的主要手段之一。 */
export function repayMargin(db: DB, cfg: Config, userId: number, amount: Cents): RepayMarginResult {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError('BAD_AMOUNT', 400, 'amount must be a positive integer');
  }
  const acct = requireAccount(db, userId);
  const owed = acct.debt + acct.interest;
  if (owed <= 0) throw new AppError('NOTHING_OWED', 409, 'no margin debt to repay');
  const pay = Math.min(amount, owed);
  if (cashAvailable(db, userId) < pay) {
    throw new AppError('INSUFFICIENT_CASH', 400, `need ${pay} available`);
  }
  const interestPaid = Math.min(pay, acct.interest);
  const principalPaid = pay - interestPaid;
  const day = engineDay(db);
  db.transaction(() => {
    post(db, day, 0, 'margin', userId, [
      { account: userId, bucket: 'A', amount: -pay, kind: 'MARGIN_REPAY' },
      { account: ACC.BANK, bucket: 'A', amount: pay, kind: 'MARGIN_REPAY' },
    ]);
    db.prepare('UPDATE margin_accounts SET debt = debt - ?, interest = interest - ? WHERE user_id = ?')
      .run(principalPaid, interestPaid, userId);
  })();
  return { interestPaid, principalPaid, owedLeft: Math.max(0, owed - pay) };
}

// ---------- 日终结算钩子 ----------

export interface MarginHookDeps { db: DB; cfg: Config }

/**
 * 每个交易日结算时（`engine/settlement.ts` 第 2 步）对全部信用账户执行：
 *   ① 退市清理：把已被 `processDelistings` 换成现金的股票对应的持仓行收掉
 *   ② 逐日计息：融资按本金 × 日息；融券按**市值** × 日费率
 *   ③ 维持担保比例检查：跌破平仓线记下 `warn_since_day`，**次日仍不达标才强平**（T+1 追保）
 *
 * ⚠️ 顺序：`matcher.onDayEnd` 在钩子之前跑（settlement 第 1 步），所以此刻 F 桶里
 *    只剩融券担保金（挂单冻结已全部释放），强平买回时不用担心误用别人的挂单资金。
 */
export class MarginSettlementHook implements SettlementHook {
  private readonly db: DB;
  private readonly cfg: Config;

  constructor(deps: MarginHookDeps) {
    this.db = deps.db;
    this.cfg = deps.cfg;
  }

  onSettlement(ctx: TickCtx): void {
    this.reconcile(ctx);
    this.accrueInterest();
    this.checkMaintenance(ctx);
  }

  /**
   * 对账：让 `margin_positions` 与 `holdings` 保持一致。
   *
   * 为什么需要这一步 —— 有两条路径会**绕过信用交易**去动担保股票：
   *   ① `processDelistings` 直接 `DELETE FROM holdings` 并折成现金；
   *   ② `LoanSettlementHook` 的破产清仓会把该用户**全部** holdings 卖光（含担保物）。
   * 两条都是别的模块的职责，不该在那里塞融资融券的分支；这里做一次收敛即可，
   * 且收敛是幂等的、只会把仓位往「实际持有」上夹。
   */
  private reconcile(ctx: TickCtx): void {
    const { db } = this;

    // ① 清理**孤儿账户**：用户行已不存在（被 `DELETE /api/admin/users/:id` 删掉）
    //    但 margin 行还留着。
    //
    //    为什么必须在这里兜底（而不是只靠 admin 删除路径）：`margin_accounts` /
    //    `margin_positions` **没有**指向 users 的外键，漏删不报错；而下面的
    //    `checkMaintenance` 会遍历 `margin_accounts` 并对每行调 `marginState()`，
    //    它第一件事就是读 `users.credit` —— 用户不存在即抛 `UNAUTHORIZED`，
    //    把**整个 tick 事务**带崩。线上表现是「结算卡死、行情停摆」，
    //    而日志里只有一句 401，极难联想到是删号留下的。
    //    两处都清（admin 管新账、这里管旧账），且都是幂等的。
    //
    //    ⚠️ 只删 margin 两张表，**绝不动 ledger**（append-only，且全局平衡靠它）：
    //    债务本就不进 ledger，所以「删号即债务消失」不会让 auditGlobal 失衡。
    //
    //    两张表各查一次并集：正常情况下 orphan 账户与 orphan 持仓是同一个人，
    //    但半删状态（账户行已清、持仓行没清）也要能收敛。
    const orphanIds = new Set<number>([
      ...(db.prepare('SELECT user_id FROM margin_accounts WHERE user_id NOT IN (SELECT id FROM users)')
        .all() as { user_id: number }[]).map(r => r.user_id),
      ...(db.prepare('SELECT DISTINCT user_id FROM margin_positions WHERE user_id NOT IN (SELECT id FROM users)')
        .all() as { user_id: number }[]).map(r => r.user_id),
    ]);
    for (const id of orphanIds) {
      db.prepare('DELETE FROM margin_positions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM margin_accounts WHERE user_id = ?').run(id);
    }

    const rows = db.prepare(`SELECT p.user_id, p.code, p.kind, p.qty, p.cost, p.frozen,
        s.status, COALESCE(h.qty_total, 0) held
      FROM margin_positions p
      JOIN stocks s ON s.code = p.code
      LEFT JOIN holdings h ON h.user_id = p.user_id AND h.code = p.code`).all() as
      { user_id: number; code: string; kind: 'long' | 'short'; qty: number; cost: Cents;
        frozen: Cents; status: string; held: number }[];

    for (const r of rows) {
      if (r.kind === 'short') {
        if (r.status !== 'delisted') continue;
        // 券已不存在，无法买券还券 —— 冻结资金全额解冻还给玩家（把公司做退市，空头赚满）。
        if (r.frozen > 0) {
          post(db, ctx.day, ctx.tickInDay, 'margin', r.user_id, [
            { account: r.user_id, bucket: 'F', amount: -r.frozen, kind: 'MARGIN_UNFREEZE' },
            { account: r.user_id, bucket: 'A', amount: r.frozen, kind: 'MARGIN_UNFREEZE' },
          ]);
        }
        db.prepare('DELETE FROM margin_positions WHERE user_id = ? AND code = ? AND kind = ?')
          .run(r.user_id, r.code, r.kind);
        continue;
      }
      // 多头：仓位不得超过实际持有（退市 / 破产清仓都会让 held 变小甚至归零）。
      const held = r.status === 'delisted' ? 0 : Math.min(r.held, r.qty);
      if (held >= r.qty) continue;
      if (held <= 0) {
        db.prepare('DELETE FROM margin_positions WHERE user_id = ? AND code = ? AND kind = ?')
          .run(r.user_id, r.code, r.kind);
        db.prepare('UPDATE holdings SET qty_margin = 0 WHERE user_id = ? AND code = ?')
          .run(r.user_id, r.code);
        continue;
      }
      const costOut = roundHalfUpDiv(r.cost * (r.qty - held), r.qty);
      db.prepare(`UPDATE margin_positions SET qty = ?, cost = MAX(0, cost - ?)
        WHERE user_id = ? AND code = ? AND kind = ?`)
        .run(held, costOut, r.user_id, r.code, r.kind);
      // qty_margin 也夹到实际持有量，否则日终解冻会算出负的 qty_sellable（被 MAX 夹成 0，
      // 但那意味着普通持仓也被误判成担保物，玩家会发现自己的股票莫名其妙卖不掉）。
      db.prepare('UPDATE holdings SET qty_margin = MIN(qty_margin, qty_total) WHERE user_id = ? AND code = ?')
        .run(r.user_id, r.code);
    }
  }

  private accrueInterest(): void {
    const { db, cfg } = this;
    const accounts = db.prepare('SELECT * FROM margin_accounts').all() as MarginAccountRow[];
    const upd = db.prepare('UPDATE margin_accounts SET interest = interest + ? WHERE user_id = ?');
    const selShorts = db.prepare(`SELECT p.qty, t.price, s.status FROM margin_positions p
      JOIN stock_state t ON t.code = p.code JOIN stocks s ON s.code = p.code
      WHERE p.user_id = ? AND p.kind = 'short'`);
    for (const a of accounts) {
      let add = 0;
      if (a.debt > 0) add += mulE6(a.debt, cfg.margin.financeRateE6);
      for (const s of selShorts.all(a.user_id) as { qty: number; price: number; status: string }[]) {
        if (s.status === 'delisted') continue;
        add += mulE6(s.qty * s.price, cfg.margin.shortRateE6);
      }
      if (add > 0) upd.run(add, a.user_id);
    }
  }

  private checkMaintenance(ctx: TickCtx): void {
    const { db, cfg } = this;
    const accounts = db.prepare('SELECT user_id FROM margin_accounts').all() as { user_id: number }[];
    for (const { user_id } of accounts) {
      const st = marginState(db, cfg, user_id);
      const breach = st.liability > 0 && st.ratioE6 !== null && st.ratioE6 < cfg.margin.liqRatioE6;
      if (!breach) {
        if (st.warnSinceDay !== null) {
          db.prepare('UPDATE margin_accounts SET warn_since_day = NULL WHERE user_id = ?').run(user_id);
        }
        continue;
      }
      if (st.warnSinceDay === null) {
        // T 日：只记下「进入追保」，给玩家一天时间自行补足（卖券还款 / 直接还款 / 追加持仓）。
        db.prepare('UPDATE margin_accounts SET warn_since_day = ? WHERE user_id = ?')
          .run(ctx.day, user_id);
      } else if (ctx.day > st.warnSinceDay) {
        // T+1 日仍未补足 → 强平。
        this.liquidate(ctx, user_id);
      }
    }
  }

  /**
   * 强制平仓：
   *   ① 多头全部卖出（带滑点，市价打到跌停价为止）
   *   ② 空头全部买回（资金优先用该笔冻结的担保金，不足才动可用现金）
   *   ③ 用全部可用现金冲抵负债（先息后本）
   *   ④ 若信用持仓已全部了结而债务仍有残额 → 债务豁免（BANK 承担损失）。
   *      债务不进 ledger，故这里只改表、不记账，`auditGlobal` 不会失衡。
   */
  private liquidate(ctx: TickCtx, userId: number): void {
    const { db, cfg } = this;
    const longs = db.prepare(`SELECT p.code, p.qty FROM margin_positions p
      JOIN stocks s ON s.code = p.code
      WHERE p.user_id = ? AND p.kind = 'long' AND s.status != 'delisted' ORDER BY p.code`)
      .all(userId) as { code: string; qty: number }[];
    for (const p of longs) this.forceSell(ctx, userId, p.code, p.qty);

    const shorts = db.prepare(`SELECT p.code, p.qty FROM margin_positions p
      JOIN stocks s ON s.code = p.code
      WHERE p.user_id = ? AND p.kind = 'short' AND s.status != 'delisted' ORDER BY p.code`)
      .all(userId) as { code: string; qty: number }[];
    for (const p of shorts) this.forceBuy(ctx, userId, p.code, p.qty);

    const acct = marginAccount(db, userId);
    if (acct !== null) {
      const owed = acct.debt + acct.interest;
      const pay = Math.min(cashAvailable(db, userId), owed);
      if (pay > 0) {
        const interestPaid = Math.min(pay, acct.interest);
        post(db, ctx.day, ctx.tickInDay, 'margin', userId, [
          { account: userId, bucket: 'A', amount: -pay, kind: 'MARGIN_FORCED_REPAY' },
          { account: ACC.BANK, bucket: 'A', amount: pay, kind: 'MARGIN_FORCED_REPAY' },
        ]);
        db.prepare('UPDATE margin_accounts SET debt = debt - ?, interest = interest - ? WHERE user_id = ?')
          .run(pay - interestPaid, interestPaid, userId);
      }
      // 还有仓位没平掉（券源买不回来等）就保留残债，等下一个交易日再处理；
      // 全部平完才豁免 —— 否则会出现「债务清了、空头还在」的无担保敞口。
      const left = (db.prepare('SELECT COUNT(*) c FROM margin_positions WHERE user_id = ?')
        .get(userId) as { c: number }).c;
      if (left === 0) {
        db.prepare(`UPDATE margin_accounts SET debt = 0, interest = 0, warn_since_day = NULL,
          liquidated_count = liquidated_count + 1 WHERE user_id = ?`).run(userId);
      }
    }
    applyCreditEvent(db, cfg, userId, cfg.credit.forcedLiq, 'MARGIN_FORCED_LIQ', ctx.day);
  }

  /** 强平卖出：不走订单簿，按现价 ×(1−滑点) 与跌停价孰高成交。 */
  private forceSell(ctx: TickCtx, userId: number, code: string, qty: number): void {
    const { db, cfg } = this;
    const q = ctx.quotes.get(code);
    if (q === undefined) return;
    const pos = loadPosition(db, userId, code, 'long');
    if (pos === null) return;
    const n = Math.min(qty, pos.qty);
    if (n <= 0) return;

    const slip = cfg.trading.slippageK * Math.sqrt(n / Math.max(1, advOf(db, code)));
    const price = Math.max(1, Math.max(q.limitDown, Math.round(q.price * (1 - slip))));
    const amount = price * n;
    const comm = commission(amount), tf = transferFee(amount), stamp = stampTax(amount);
    const net = amount - comm - tf - stamp;
    const costOut = holdingCostOut(db, userId, code, n);
    const posCostOut = roundHalfUpDiv(pos.cost * n, pos.qty);

    db.transaction(() => {
      const fill = insertSystemFill(db, ctx.day, ctx.tickInDay, userId, code, 'S', price, n,
        comm, stamp, tf, 'mgl');
      post(db, ctx.day, ctx.tickInDay, 'trade', fill.tradeId, [
        { account: ACC.MARKET, bucket: 'A', amount: -amount, kind: 'MARGIN_FORCED_SELL' },
        { account: userId, bucket: 'A', amount: net, kind: 'MARGIN_FORCED_SELL' },
        { account: ACC.CLEARING, bucket: 'A', amount: comm + tf, kind: 'MARGIN_FORCED_SELL' },
        { account: ACC.TAX, bucket: 'A', amount: stamp, kind: 'MARGIN_FORCED_SELL' },
      ]);
      reduceMarginHolding(db, userId, code, n, costOut);
      reducePosition(db, userId, code, 'long', n, posCostOut, 0);
    })();
  }

  /**
   * 强平买回（还券）。
   *
   * 与玩家主动 `buyToCover` 的关键差别：**这里绝不能因为现金不足而抛错** ——
   * 抛错会让整个 tick 事务回滚、结算卡死。做法是允许券商**垫付**差额：
   * 缺口由 BANK 直接划给用户（`BANK` 是系统账户，可为负），同时等额记进 `debt`，
   * 于是「空头爆仓」被平滑地转成「欠券商一笔钱」，由后面的清偿/豁免逻辑接手。
   * 这既符合现实（券商代垫后向投资者追偿），也避免出现「买不回来就永远挂着」的死结。
   */
  private forceBuy(ctx: TickCtx, userId: number, code: string, qty: number): void {
    const { db, cfg } = this;
    const q = ctx.quotes.get(code);
    if (q === undefined) return;
    const pos = loadPosition(db, userId, code, 'short');
    if (pos === null) return;
    const n = Math.min(qty, pos.qty);
    if (n <= 0) return;

    const slip = cfg.trading.slippageK * Math.sqrt(n / Math.max(1, advOf(db, code)));
    const price = Math.min(q.limitUp, Math.max(1, Math.round(q.price * (1 + slip))));
    const amount = price * n;
    const comm = commission(amount), tf = transferFee(amount);
    const cost = amount + comm + tf;
    const released = roundHalfUpDiv(pos.frozen * n, pos.qty);
    const cashA = cashAvailable(db, userId);
    // 缺口 = 买回成本 − 解冻的担保金 − 手头现金。为正说明做空亏穿了担保金。
    const deficit = Math.max(0, cost - released - cashA);
    const posCostOut = roundHalfUpDiv(pos.cost * n, pos.qty);

    db.transaction(() => {
      const fill = insertSystemFill(db, ctx.day, ctx.tickInDay, userId, code, 'B', price, n,
        comm, 0, tf, 'mgc');
      const legs: Leg[] = [];
      if (deficit > 0) {
        legs.push({ account: ACC.BANK, bucket: 'A', amount: -deficit, kind: 'MARGIN_SHORT_FUND' },
          { account: userId, bucket: 'A', amount: deficit, kind: 'MARGIN_SHORT_FUND' });
      }
      legs.push(
        { account: userId, bucket: 'F', amount: -released, kind: 'MARGIN_UNFREEZE' },
        { account: userId, bucket: 'A', amount: released, kind: 'MARGIN_UNFREEZE' },
        { account: userId, bucket: 'A', amount: -cost, kind: 'MARGIN_FORCED_BUY' },
        { account: ACC.MARKET, bucket: 'A', amount, kind: 'MARGIN_FORCED_BUY' },
        { account: ACC.CLEARING, bucket: 'A', amount: comm + tf, kind: 'MARGIN_FORCED_BUY' },
      );
      post(db, ctx.day, ctx.tickInDay, 'trade', fill.tradeId, legs);
      reducePosition(db, userId, code, 'short', n, posCostOut, released);
      if (deficit > 0) {
        db.prepare('UPDATE margin_accounts SET debt = debt + ? WHERE user_id = ?').run(deficit, userId);
      }
    })();
  }
}
