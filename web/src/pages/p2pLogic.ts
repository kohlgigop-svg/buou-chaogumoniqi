// pages/p2pLogic.ts —— 玩家间借贷（P2P）面板的纯函数层（无 React、无网络，便于单测）。
//
// ⚠️ 与 `lifeLogic.ts` 的银行贷款（`LoanRow`）**口径完全不同**，不要互借函数：
//   · 银行贷款利息**逐日计提**，`owedTotal` 会自己涨；P2P 的 `repayAmount` 是
//     双方谈定的**固定**应还额，`owedTotal` 只会因还款而**减少**。
//   · 银行贷款没有「对手方」，P2P 的一切操作都要先看**我是什么角色**。
//
// 单位提醒：金额一律是**分**；`termDays` / `dueDay` / `daysLeft` 是**游戏日**。
import { fmtMoney } from '../format.js';
import type { P2pLoan, P2pStatus } from '../api.js';

// ---------- 状态与角色 ----------

const P2P_STATUS_LABEL: Record<string, string> = {
  pending: '待确认', active: '进行中', grace: '宽限期', overdue: '已逾期',
  repaid: '已还清', settled: '已结清', forgiven: '已豁免',
  rejected: '已拒绝', cancelled: '已撤回',
};

export function p2pStatusLabel(status: string): string {
  return P2P_STATUS_LABEL[status] ?? status;
}

/**
 * 状态色调。注意 `pending` 是**中性**（还没发生任何事），不是「进行中」——
 * 若把它染成主色，用户会以为钱已经划过去了。
 */
export function p2pTone(status: P2pStatus | string): 'active' | 'danger' | 'warning' | 'done' | 'flat' {
  if (status === 'overdue') return 'danger';
  if (status === 'grace') return 'warning';
  if (status === 'active') return 'active';
  if (status === 'repaid' || status === 'settled') return 'done';
  return 'flat';   // pending / forgiven / rejected / cancelled
}

/** 未结清状态集合（与共享的 `OPEN_STATUSES` 语义一致）。 */
const OPEN = new Set<string>(['pending', 'active', 'grace', 'overdue']);

export function p2pOpen(loan: Pick<P2pLoan, 'status'>): boolean {
  return OPEN.has(loan.status);
}

/** 待我确认：`pending` 且 `awaitingId` 指向我。 */
export function awaitsMe(loan: P2pLoan, meId: number): boolean {
  return loan.status === 'pending' && loan.awaitingId === meId;
}

/** 待对方确认（我发起的、还没被理的那笔）—— 只能撤回，不能同意。 */
export function awaitsThem(loan: P2pLoan, meId: number): boolean {
  return loan.status === 'pending' && loan.awaitingId !== null && loan.awaitingId !== meId;
}

/** 借款方可以主动还款：已生效（active/grace/overdue）且是我欠的钱。 */
export function canRepayP2p(loan: P2pLoan): boolean {
  return loan.myRole === 'borrower'
    && (loan.status === 'active' || loan.status === 'grace' || loan.status === 'overdue');
}

/** 「我」在这笔借据里的对手方 —— 借钱时对手方是出借人，放贷时对手方是借款人。 */
export function counterpartyOf(loan: P2pLoan): string {
  return loan.myRole === 'borrower' ? loan.lenderName : loan.borrowerName;
}

/**
 * 一句话说清这笔债的关系，直接给用户读：
 *   · 借款方视角：「我向 X 借 ¥A，到期还给 X ¥B」
 *   · 出借方视角：「我借给 X ¥A，到期收回 ¥B」
 */
export function relationLine(loan: P2pLoan): string {
  const other = counterpartyOf(loan);
  if (loan.myRole === 'borrower') {
    return `我向 ${other} 借 ${fmtMoney(loan.principal)}，到期还 ${fmtMoney(loan.repayAmount)}`;
  }
  return `我借给 ${other} ${fmtMoney(loan.principal)}，到期收 ${fmtMoney(loan.repayAmount)}`;
}

/** 利息额（分）= 应还 − 本金。负值（脏数据）夹紧到 0。 */
export function interestOf(loan: Pick<P2pLoan, 'principal' | 'repayAmount'>): number {
  return Math.max(0, loan.repayAmount - loan.principal);
}

/**
 * 实际年化近似（比例，非百分数）。
 *
 * ⚠️ 这里刻意用**简单利率年化**（利息/本金 ÷ 天数 × 365），不是复利 IRR ——
 * 目的只是给玩家一个「这利率贵不贵」的量级感。游戏里 1 年 365 日，
 * 但**借期上限只有 120 日**，极端短借的年化数字会很大，这是正确的。
 * 本金为 0 或期限为 0 时返回 null（避免除零），调用方须处理 null。
 */
export function annualizedRate(loan: Pick<P2pLoan, 'principal' | 'repayAmount' | 'termDays'>): number | null {
  if (loan.principal <= 0 || loan.termDays <= 0) return null;
  return (interestOf(loan) / loan.principal) / loan.termDays * 365;
}

/** 零息借据的标记文案（避免显示「年化 0.00%」这种没有人情味的写法）。 */
export function interestLabel(loan: P2pLoan): string {
  const interest = interestOf(loan);
  if (interest === 0) return '零息（仅还本）';
  return `利息 ${fmtMoney(interest)}`;
}

/** 到期提示：未生效为「等待双方确认」，已结清不提示，其余按剩余/超期天数给文案。 */
export function dueLabel(loan: P2pLoan): string {
  if (loan.status === 'pending') return '尚未生效，等待对方确认';
  if (loan.status === 'repaid' || loan.status === 'settled') return '已结清';
  if (loan.status === 'forgiven') return '已豁免（借款人破产）';
  if (loan.status === 'rejected' || loan.status === 'cancelled') return '未生效';
  if (loan.dueDay === null) return '—';
  const left = loan.daysLeft ?? 0;
  if (left > 1) return `第 ${loan.dueDay} 日到期（还有 ${left} 日）`;
  if (left === 1) return `第 ${loan.dueDay} 日到期（明天）`;
  if (left === 0) return `第 ${loan.dueDay} 日到期（今天）`;
  return `第 ${loan.dueDay} 日到期（已超期 ${-left} 日）`;
}

/** 还款进度 0..100。应还为 0 时按 100（已清）处理，不出 NaN。 */
export function repayPct(loan: Pick<P2pLoan, 'repaid' | 'repayAmount'>): number {
  if (loan.repayAmount <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((loan.repaid / loan.repayAmount) * 100)));
}

// ---------- 条款计算（发起表单） ----------

/**
 * 由本金 + 利率倍数算应还额（分）。
 *
 * ⚠️ 必须与**服务端**校验口径一致：服务端 `validateTerms` 判的是
 * `repayAmount <= floor(principal * maxRateMult)`，故这里也用 `Math.floor` ——
 * 用 `Math.round` 会在边界上算出比服务端上限大 1 分、被 403 拒掉的数。
 */
export function repayFromMult(principalCents: number, rateMult: number): number {
  if (!Number.isFinite(principalCents) || !Number.isFinite(rateMult)) return 0;
  return Math.floor(Math.max(0, principalCents) * Math.max(0, rateMult));
}

/**
 * 由应还额反推利率倍数（用于把用户填的「应还额」换算成百分比显示）。
 * 本金为 0 → 0。
 */
export function multFromRepay(principalCents: number, repayCents: number): number {
  if (principalCents <= 0) return 0;
  return repayCents / principalCents;
}

/** 把比例渲染成「+12.5%」；零息给「零息」。 */
export function rateMultLabel(mult: number): string {
  if (mult <= 1) return '零息';
  const pct = (mult - 1) * 100;
  // 小于 10% 时留两位小数（5.25% 这种要紧），否则一位足够且更易读。
  return `+${pct.toFixed(pct < 10 ? 2 : 1)}%`;
}

/** 输入（元）→ 分。用于发起表单的本金 / 应还额字段。 */
export function parseYuanInput(text: string, label = '金额'): { cents: number } | { error: string } {
  const t = text.trim();
  if (t === '') return { error: `请输入${label}` };
  const yuan = Number(t);
  if (!Number.isFinite(yuan)) return { error: `${label}格式不正确` };
  if (yuan <= 0) return { error: `${label}须大于 0` };
  const cents = Math.round(yuan * 100);
  if (!Number.isSafeInteger(cents)) return { error: `${label}超出可用范围` };
  return { cents };
}

// ---------- 发起表单校验 ----------

export interface ProposeDraft {
  counterpartyId: number | null;
  /** 本金（元，原始输入串）。 */
  principalText: string;
  /** 应还额（元，原始输入串）。 */
  repayText: string;
  termText: string;
}

export interface ProposeLimits {
  maxPrincipal: number; minRateMult: number; maxRateMult: number;
  minTermDays: number; maxTermDays: number;
}

/**
 * 发起表单的**本地**校验 —— 目的只是让用户少跑一趟服务端。
 * 服务端仍会完整复检（甚至更严：连 `Number.isSafeInteger` 都查），
 * 故这里**不必**穷尽所有边界，但口径不能反（否则会出现「本地拦下了合法请求」）。
 *
 * 校验顺序刻意与用户填写顺序一致（对手方 → 本金 → 应还 → 期限），
 * 这样第一个报错就是用户最先该改的那个字段。
 */
export function validatePropose(draft: ProposeDraft, limits: ProposeLimits):
  { ok: true; principal: number; repayAmount: number; termDays: number; counterpartyId: number }
  | { ok: false; error: string } {
  if (draft.counterpartyId === null) return { ok: false, error: '请先选择对手方' };

  const p = parseYuanInput(draft.principalText, '本金');
  if ('error' in p) return { ok: false, error: p.error };
  if (p.cents > limits.maxPrincipal) {
    return { ok: false, error: `本金超过单笔上限 ${fmtMoney(limits.maxPrincipal)}` };
  }

  const r = parseYuanInput(draft.repayText, '应还金额');
  if ('error' in r) return { ok: false, error: r.error };
  if (r.cents < p.cents) return { ok: false, error: '应还金额不得低于本金（零息请填与本金相同）' };
  // 与服务端同口径：`repayAmount <= floor(principal × maxRateMult)`
  if (r.cents > repayFromMult(p.cents, limits.maxRateMult)) {
    return { ok: false, error: `利息超出上限（应还不超过本金的 ${((limits.maxRateMult - 1) * 100).toFixed(0)}%）` };
  }

  const term = Number(draft.termText.trim());
  if (draft.termText.trim() === '' || !Number.isInteger(term)) {
    return { ok: false, error: '请输入整数天数作为还款周期' };
  }
  if (term < limits.minTermDays || term > limits.maxTermDays) {
    return { ok: false, error: `还款周期须在 ${limits.minTermDays}~${limits.maxTermDays} 日之间` };
  }

  return { ok: true, principal: p.cents, repayAmount: r.cents, termDays: term,
    counterpartyId: draft.counterpartyId };
}

// ---------- 列表分组 ----------

export interface P2pBuckets {
  /** 别人发给我、等我点头的（最优先，通常 0~1 条）。 */
  awaitingMe: P2pLoan[];
  /** 我发起的、还在等对方点头的。 */
  awaitingThem: P2pLoan[];
  /** 已生效、还没结清的（含宽限 / 逾期）。 */
  open: P2pLoan[];
  /** 已经了结的历史（含各类终止态）。 */
  closed: P2pLoan[];
}

/**
 * 按「我现在该做什么」分桶，而不是按状态字段机械分组 ——
 * 玩家打开这个页面的第一诉求是「有没有人等我回话」，其次是「我欠谁的、什么到期」。
 */
export function bucketLoans(loans: P2pLoan[], meId: number): P2pBuckets {
  const b: P2pBuckets = { awaitingMe: [], awaitingThem: [], open: [], closed: [] };
  for (const l of loans) {
    if (awaitsMe(l, meId)) b.awaitingMe.push(l);
    else if (awaitsThem(l, meId)) b.awaitingThem.push(l);
    else if (l.status === 'active' || l.status === 'grace' || l.status === 'overdue') b.open.push(l);
    else b.closed.push(l);
  }
  return b;
}

/** 汇总：我的借入（负债）与借出（债权）各多少、有没有逾期的。 */
export interface P2pSummary {
  /** 我欠别人的本金合计（分）。 */
  borrowedPrincipal: number;
  /** 别人欠我的本金合计（分）。 */
  lentPrincipal: number;
  /** 待我确认的条数（用于顶部红点/提示）。 */
  pendingIn: number;
  hasOverdue: boolean;
  hasGrace: boolean;
}

/**
 * 汇总只统计**已生效**的借据（active/grace/overdue）：
 * pending 的钱还没动过，计进去会让用户以为自己已经欠了钱。
 */
export function summarizeP2p(loans: P2pLoan[], meId: number): P2pSummary {
  let borrowed = 0;
  let lent = 0;
  let pendingIn = 0;
  let hasOverdue = false;
  let hasGrace = false;
  for (const l of loans) {
    if (awaitsMe(l, meId)) pendingIn += 1;
    if (l.status !== 'active' && l.status !== 'grace' && l.status !== 'overdue') continue;
    if (l.myRole === 'borrower') borrowed += l.principal;
    else lent += l.principal;
    if (l.status === 'overdue') hasOverdue = true;
    if (l.status === 'grace') hasGrace = true;
  }
  return { borrowedPrincipal: borrowed, lentPrincipal: lent, pendingIn, hasOverdue, hasGrace };
}
