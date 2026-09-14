// domain/p2p.ts —— 玩家间借贷（P2P）。
//
// 与 NPC 银行贷款（domain/loans.ts）的关键区别：
//   · loans 是**银行授信**，放款时 BANK→user 凭空增加借款方现金（额度受信誉档约束）；
//   · p2p 是**玩家对玩家**，放款时资金从出借方可用现金**真实划转**到借款方，
//     故没有"授信额度"，只有「出借方有没有这笔钱」。
//
// 流程（规格：由一方发起 → 协商还款周期与金额 → 双方同意后生效 → 到期自动扣款 →
// 余额不足则影响个人信誉）：
//   ① propose —— 发起方提交条款（方向可以是"我要借"或"我要放贷"），此时**不划款**，
//      借据 status='pending'、awaiting_id=对手方；
//   ② accept  —— 对手方确认。**唯一划款时点**：出借方 A→借款方 A。status='active'，
//      写 start_day/due_day；
//   ③ reject / cancel —— 未生效即终止，无资金变动；
//   ④ 到期（结算钩子）—— 自动从借款方可用现金划扣应还额给出借方；
//      余额不足 → 进入宽限/逾期，按日扣借款人信誉（与 NPC 贷款同口径）。
//
// 纪律：所有资金变动一律走 ledger 复式过账（post），kind 前缀 'P2P_'，
// 保证 auditGlobal 恒零与 auditUser 逐用户勾稽仍然成立。
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { SettlementHook, TickCtx } from '../engine/types.js';
import { post } from '../core/ledger.js';
import { applyCreditEvent } from './credit.js';
import { engineDay } from '../core/clock.js';
import { AppError } from '../api/app.js';
import type { Cents } from '../core/money.js';

export type P2pStatus = 'pending' | 'active' | 'repaid' | 'grace' | 'overdue'
  | 'settled' | 'forgiven' | 'rejected' | 'cancelled';

/** 未结清（占用"一对玩家一笔"名额、且计入负债视图）的状态集合。 */
const OPEN_STATUSES = ['pending', 'active', 'grace', 'overdue'] as const;

export interface P2pRow {
  id: number; borrower_id: number; lender_id: number; pair_lo: number; pair_hi: number;
  principal: Cents; repay_amount: Cents; term_days: number; proposed_by: 'borrow' | 'lend';
  awaiting_id: number | null; day_created: number; start_day: number | null;
  due_day: number | null; repaid: Cents; status: P2pStatus; note: string;
}

/** 规范化一对玩家为 (小 id, 大 id)，与唯一索引口径一致。 */
function pairKey(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

function load(db: DB, id: number): P2pRow {
  const row = db.prepare('SELECT * FROM p2p_loans WHERE id = ?').get(id) as P2pRow | undefined;
  if (row === undefined) throw new AppError('P2P_NOT_FOUND', 404, 'p2p loan not found');
  return row;
}

/** 未偿金额（本息合计）。 */
function owedOf(r: P2pRow): Cents { return r.repay_amount - r.repaid; }

function cashOf(db: DB, userId: number): Cents {
  return (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(userId) as
    { a: number }).a;
}

function requireUser(db: DB, userId: number): void {
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: number } | undefined;
  if (u === undefined) throw new AppError('P2P_NO_COUNTERPARTY', 404, 'counterparty not found');
}

/** 协商条款的合法性校验（利率/周期/金额），propose 与 accept 前都要过。 */
function validateTerms(cfg: Config, principal: Cents, repayAmount: Cents, termDays: number): void {
  if (!Number.isSafeInteger(principal) || principal <= 0) {
    throw new AppError('BAD_AMOUNT', 400, 'principal must be a positive integer');
  }
  if (principal > cfg.p2p.maxPrincipal) {
    throw new AppError('P2P_AMOUNT_LIMIT', 403, `principal exceeds ${cfg.p2p.maxPrincipal}`);
  }
  if (!Number.isSafeInteger(repayAmount) || repayAmount < principal) {
    throw new AppError('P2P_BAD_REPAY', 400, 'repay amount must be >= principal');
  }
  if (repayAmount > Math.floor(principal * cfg.p2p.maxRateMult)) {
    throw new AppError('P2P_RATE_LIMIT', 403, `rate exceeds ${(cfg.p2p.maxRateMult - 1) * 100}%`);
  }
  if (!Number.isInteger(termDays) || termDays < cfg.p2p.minTermDays || termDays > cfg.p2p.maxTermDays) {
    throw new AppError('P2P_BAD_TERM', 400,
      `term must be within [${cfg.p2p.minTermDays}, ${cfg.p2p.maxTermDays}] days`);
  }
}

export interface ProposeInput {
  /** 发起方角色：'borrow' = 我借钱（对手方是出借人）；'lend' = 我放贷（对手方是借款人）。 */
  role: 'borrow' | 'lend';
  counterpartyId: number;
  principal: Cents;
  /** 应还总额（本金 + 利息）。等于 principal 即零息。 */
  repayAmount: Cents;
  termDays: number;
  note?: string;
}

/**
 * 发起一笔 P2P 借款请求（**不划款**）。
 *
 * 校验顺序（先到先拒）：
 *   1 对手方存在且不是自己（P2P_NO_COUNTERPARTY / P2P_SELF）
 *   2 条款合法（利率/周期/金额，见 validateTerms）
 *   3 该对玩家没有未结清借据（P2P_PAIR_BUSY；由唯一索引兜底，这里先给出可读错误）
 *   4 若我是出借方（role='lend'）→ 必须**当下**就够钱（P2P_INSUFFICIENT_CASH）；
 *     若我是借款方（role='borrow'），钱在对手方那边，此处只留待 accept 时校验。
 *
 * 返回借据 id，status='pending'、awaiting_id=对手方。
 */
export function propose(db: DB, cfg: Config, meId: number, input: ProposeInput): number {
  const { role, counterpartyId } = input;
  if (counterpartyId === meId) throw new AppError('P2P_SELF', 400, 'cannot borrow from yourself');
  requireUser(db, counterpartyId);
  validateTerms(cfg, input.principal, input.repayAmount, input.termDays);

  const borrowerId = role === 'borrow' ? meId : counterpartyId;
  const lenderId = role === 'borrow' ? counterpartyId : meId;
  const [lo, hi] = pairKey(meId, counterpartyId);

  const busy = (db.prepare(`SELECT COUNT(*) c FROM p2p_loans WHERE pair_lo = ? AND pair_hi = ?
    AND status IN ('pending','active','grace','overdue')`).get(lo, hi) as { c: number }).c;
  if (busy > 0) {
    throw new AppError('P2P_PAIR_BUSY', 409, 'an open p2p loan already exists with this player');
  }

  // 出借方发起时：钱必须现在就够（accept 时还要再查一次 —— 期间可能被花掉）。
  if (role === 'lend' && cashOf(db, meId) < input.principal) {
    throw new AppError('P2P_INSUFFICIENT_CASH', 400, 'not enough available cash to lend');
  }

  const day = engineDay(db);
  const r = db.prepare(`INSERT INTO p2p_loans(borrower_id, lender_id, pair_lo, pair_hi,
    principal, repay_amount, term_days, proposed_by, awaiting_id, day_created, status, note)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`)
    .run(borrowerId, lenderId, lo, hi, input.principal, input.repayAmount, input.termDays,
      role, counterpartyId, day, input.note ?? '');
  return Number(r.lastInsertRowid);
}

/**
 * 对手方接受 → 借据生效。**唯一划款时点**：
 *   出借方可用现金 → 借款方可用现金（kind 'P2P_DRAW'）。
 *
 * 前置：status='pending' 且 meId 是 awaiting_id（只有对手方能接受）。
 * 出借方资金检查在**事务内**再查一次 —— 发起后到接受前可能已把钱花掉。
 * 生效后 status='active'、start_day=当日、due_day=当日+term_days。
 */
export function accept(db: DB, cfg: Config, meId: number, loanId: number): void {
  const r = load(db, loanId);
  if (r.status !== 'pending') throw new AppError('P2P_NOT_PENDING', 409, 'loan is not awaiting confirmation');
  if (r.awaiting_id !== meId) throw new AppError('P2P_NOT_COUNTERPARTY', 403, 'only the counterparty can accept');
  validateTerms(cfg, r.principal, r.repay_amount, r.term_days);

  const day = engineDay(db);
  db.transaction(() => {
    // 事务内双重检查：并发 accept 或期间资金被花掉。
    const fresh = load(db, loanId);
    if (fresh.status !== 'pending') throw new AppError('P2P_NOT_PENDING', 409, 'loan is not awaiting confirmation');
    if (cashOf(db, r.lender_id) < r.principal) {
      throw new AppError('P2P_INSUFFICIENT_CASH', 400, 'lender no longer has enough available cash');
    }
    post(db, day, 0, 'p2p', loanId, [
      { account: r.lender_id, bucket: 'A', amount: -r.principal, kind: 'P2P_DRAW' },
      { account: r.borrower_id, bucket: 'A', amount: r.principal, kind: 'P2P_DRAW' },
    ]);
    db.prepare(`UPDATE p2p_loans SET status = 'active', awaiting_id = NULL,
      start_day = ?, due_day = ? WHERE id = ?`).run(day, day + r.term_days, loanId);
  })();
}

/** 对手方拒绝（或借款方撤回自己的申请）。status → rejected，无资金变动。 */
export function reject(db: DB, meId: number, loanId: number): void {
  const r = load(db, loanId);
  if (r.status !== 'pending') throw new AppError('P2P_NOT_PENDING', 409, 'loan is not awaiting confirmation');
  // 只有「等待确认的那一方」或其对手方（发起人撤回）能终结该请求。
  const isCounterparty = r.awaiting_id === meId;
  const isProposer = r.borrower_id === meId || r.lender_id === meId;
  if (!isCounterparty && !isProposer) {
    throw new AppError('P2P_NOT_PARTY', 403, 'not a party to this loan');
  }
  db.prepare(`UPDATE p2p_loans SET status = 'rejected', awaiting_id = NULL WHERE id = ?`).run(loanId);
}

/**
 * 借款方主动提前还款（可部分）。按「先冲已偿额」线性推进 repaid；
 * 全额结清时按提前/按期给借款人信誉分（与 NPC 贷款同口径）。
 * 资金：借款方 A → 出借方 A（kind 'P2P_REPAY'）。
 */
export function repayP2p(db: DB, cfg: Config, meId: number, loanId: number,
    amount: Cents): { paid: Cents; closed: boolean } {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError('BAD_AMOUNT', 400, 'amount must be a positive integer');
  }
  const r = load(db, loanId);
  if (r.borrower_id !== meId) throw new AppError('P2P_NOT_BORROWER', 403, 'only the borrower repays');
  if (r.status === 'pending') throw new AppError('P2P_NOT_ACTIVE', 409, 'loan has not taken effect');
  if (r.status === 'repaid' || r.status === 'settled' || r.status === 'forgiven') {
    throw new AppError('P2P_CLOSED', 409, 'loan already closed');
  }
  const owed = owedOf(r);
  const pay = Math.min(amount, owed);
  if (cashOf(db, meId) < pay) {
    throw new AppError('P2P_INSUFFICIENT_CASH', 400, `need ${pay} available`);
  }
  const day = engineDay(db);
  const closed = pay === owed;
  db.transaction(() => {
    post(db, day, 0, 'p2p', loanId, [
      { account: meId, bucket: 'A', amount: -pay, kind: 'P2P_REPAY' },
      { account: r.lender_id, bucket: 'A', amount: pay, kind: 'P2P_REPAY' },
    ]);
    db.prepare(`UPDATE p2p_loans SET repaid = repaid + ?, status = ? WHERE id = ?`)
      .run(pay, closed ? 'repaid' : r.status, loanId);
    if (closed && r.due_day !== null) {
      const early = day < r.due_day;
      applyCreditEvent(db, cfg, meId, early ? cfg.p2p.repayEarly : cfg.p2p.repayOnTime,
        early ? 'P2P_REPAY_EARLY' : 'P2P_REPAY_ON_TIME', day);
    }
  })();
  return { paid: pay, closed };
}

export interface P2pView {
  id: number; borrowerId: number; borrowerName: string; lenderId: number; lenderName: string;
  principal: Cents; repayAmount: Cents; repaid: Cents; owedTotal: Cents; termDays: number;
  proposedBy: 'borrow' | 'lend'; awaitingId: number | null; awaitingName: string | null;
  dayCreated: number; startDay: number | null; dueDay: number | null;
  status: P2pStatus; note: string;
  /** 我在本笔借据中的角色，便于前端直接渲染「我要还」还是「等他还」。 */
  myRole: 'borrower' | 'lender';
  daysLeft: number | null;
}

const VIEW_SQL = `SELECT p.*, ub.username borrowerName, ul.username lenderName,
    ua.username awaitingName
  FROM p2p_loans p
  JOIN users ub ON ub.id = p.borrower_id
  JOIN users ul ON ul.id = p.lender_id
  LEFT JOIN users ua ON ua.id = p.awaiting_id`;

/** 与我相关的全部借据（发起的 + 收到的），未结清优先、其次按 id 倒序。 */
export function listP2p(db: DB, meId: number): P2pView[] {
  const rows = db.prepare(`${VIEW_SQL} WHERE p.borrower_id = ? OR p.lender_id = ?
    ORDER BY (p.status IN ('pending','active','grace','overdue')) DESC, p.id DESC`)
    .all(meId, meId) as (P2pRow & { borrowerName: string; lenderName: string;
      awaitingName: string | null })[];
  const today = engineDay(db);
  return rows.map(r => toView(r, meId, today));
}

function toView(r: P2pRow & { borrowerName: string; lenderName: string; awaitingName: string | null },
    meId: number, today: number): P2pView {
  return {
    id: r.id, borrowerId: r.borrower_id, borrowerName: r.borrowerName,
    lenderId: r.lender_id, lenderName: r.lenderName,
    principal: r.principal, repayAmount: r.repay_amount, repaid: r.repaid,
    owedTotal: owedOf(r), termDays: r.term_days, proposedBy: r.proposed_by,
    awaitingId: r.awaiting_id, awaitingName: r.awaitingName,
    dayCreated: r.day_created, startDay: r.start_day, dueDay: r.due_day,
    status: r.status, note: r.note,
    myRole: r.borrower_id === meId ? 'borrower' : 'lender',
    daysLeft: r.due_day === null ? null : r.due_day - today,
  };
}

// ---------- 日终结算钩子 ----------

/**
 * 每个交易日结算时对每笔生效中的 P2P 借据执行：
 *   ① 到期判定：day >= due_day 且未还清 → 尝试自动扣款（借款人可用现金 → 出借方）；
 *   ② 扣款成功且全额结清 → status='repaid'（按期，不扣信誉也不奖励 —— 奖励在 repayP2p 里给）；
 *   ③ 扣款不足 → 进入 grace（宽限内不扣信誉）；
 *   ④ 超过宽限期 → overdue，按日扣借款人信誉（与 NPC 贷款同口径）。
 *
 * 逾期**不做**强制平仓：P2P 是玩家之间的私债，处置权应交给出借方
 * （可通过协商或自行承担损失），系统只负责信誉惩罚与自动扣款。
 * 借款人破产时（NPC 贷款破产结算会豁免全部 loans），本钩子把对应借据置 forgiven，
 * 出借方承担损失 —— 与「债务豁免」的语义一致。
 */
export class P2pSettlementHook implements SettlementHook {
  private readonly db: DB;
  private readonly cfg: Config;

  constructor(deps: { db: DB; cfg: Config }) {
    this.db = deps.db;
    this.cfg = deps.cfg;
  }

  onSettlement(ctx: TickCtx): void {
    const { db, cfg } = this;
    const day = ctx.day;

    // 借款人已破产（NPC 债务已豁免）→ P2P 债务一并豁免，出借方承担损失。
    const forgiven = db.prepare(`SELECT p.* FROM p2p_loans p
      JOIN users u ON u.id = p.borrower_id
      WHERE p.status IN ('active','grace','overdue') AND u.bankrupt_count > 0
        AND u.credit <= ?`).all(cfg.credit.bankruptcyScore) as P2pRow[];
    for (const r of forgiven) {
      db.prepare(`UPDATE p2p_loans SET status = 'forgiven' WHERE id = ?`).run(r.id);
    }

    const open = db.prepare(`SELECT * FROM p2p_loans
      WHERE status IN ('active','grace','overdue') ORDER BY due_day, id`).all() as P2pRow[];
    for (const r of open) {
      if (r.due_day === null) continue;
      const owed = owedOf(r);

      // ① 到期（或已逾期）→ 尝试自动扣款，能扣多少扣多少。
      let paid: Cents = 0;
      if (day >= r.due_day) {
        const avail = cashOf(db, r.borrower_id);
        paid = Math.min(avail, owed);
        if (paid > 0) {
          db.transaction(() => {
            post(db, day, ctx.tickInDay, 'p2p', r.id, [
              { account: r.borrower_id, bucket: 'A', amount: -paid, kind: 'P2P_AUTO_REPAY' },
              { account: r.lender_id, bucket: 'A', amount: paid, kind: 'P2P_AUTO_REPAY' },
            ]);
            db.prepare('UPDATE p2p_loans SET repaid = repaid + ? WHERE id = ?').run(paid, r.id);
          })();
        }
      }
      const settled = r.repaid + paid >= r.repay_amount;

      // ② 状态推进（due_day 当天即最后还款日；进入 due_day 未清即算到期未还 → 宽限）
      let status: P2pStatus = r.status;
      if (settled) status = 'repaid';
      else if (day >= r.due_day) status = 'grace';
      if (status === 'grace' && day >= r.due_day + cfg.p2p.graceDays) status = 'overdue';

      db.prepare('UPDATE p2p_loans SET status = ? WHERE id = ?').run(status, r.id);
      if (status === 'overdue') {
        applyCreditEvent(db, cfg, r.borrower_id, cfg.p2p.overduePerDay, 'P2P_OVERDUE', day);
      }
    }
  }
}

/** 某用户的 P2P 负债视图（供净资产/杠杆计算合并）。 */
export function p2pDebtOf(db: DB, userId: number): Cents {
  return (db.prepare(`SELECT COALESCE(SUM(repay_amount - repaid), 0) v FROM p2p_loans
    WHERE borrower_id = ? AND status IN ('active','grace','overdue')`)
    .get(userId) as { v: number }).v;
}

/** 某用户的 P2P 债权视图（别人欠我的，计入净资产）。 */
export function p2pCreditOf(db: DB, userId: number): Cents {
  return (db.prepare(`SELECT COALESCE(SUM(repay_amount - repaid), 0) v FROM p2p_loans
    WHERE lender_id = ? AND status IN ('active','grace','overdue')`)
    .get(userId) as { v: number }).v;
}

export { OPEN_STATUSES };
