// domain/credit.ts —— 信誉分（350–850）变动与流水。
// 所有变动一律写 credit_events（delta + reason + 变动后分数），函数返回新的分数。
// 不开事务：调用方（借款 / 结算钩子 / 管理接口）已在事务内。
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';

/** 信誉事件原因（写库字符串，勿随意改：流水/报表按此聚合）。 */
export type CreditReason =
  | 'REPAY_ON_TIME'   // 按期还清 +15
  | 'REPAY_EARLY'     // 提前还清 +20
  | 'OVERDUE'         // 逾期每日 −8
  | 'FORCED_LIQ'      // 被强制平仓 −80
  | 'BANKRUPTCY'      // 破产 → 直接置 400
  | 'SHIFT'           // 完成打工班次 +1（20 日内上限）
  | (string & {});    // 预留：管理后台人工调整等

const SHIFT_WINDOW_DAYS = 20;

function userCredit(db: DB, userId: number): number {
  const row = db.prepare('SELECT credit c FROM users WHERE id = ?').get(userId) as
    { c: number } | undefined;
  if (row === undefined) throw new Error(`no user ${userId}`);
  return row.c;
}

function record(db: DB, userId: number, delta: number, reason: CreditReason,
    day: number, after: number): void {
  db.prepare('INSERT INTO credit_events(user_id, day, delta, reason, score_after) VALUES (?,?,?,?,?)')
    .run(userId, day, delta, reason, after);
}

/** 施加一次信誉变动：clamp 到 [cfg.credit.min, cfg.credit.max]，写流水，返回新分数。 */
export function applyCreditEvent(db: DB, cfg: Config, userId: number, delta: number,
    reason: CreditReason, day: number): number {
  const cur = userCredit(db, userId);
  const next = Math.max(cfg.credit.min, Math.min(cfg.credit.max, cur + delta));
  if (next !== cur) db.prepare('UPDATE users SET credit = ? WHERE id = ?').run(next, userId);
  record(db, userId, next - cur, reason, day, next);
  return next;
}

/** 把分数置为某值（破产等"置位"语义；流水 delta = 实际差值）。 */
export function setCredit(db: DB, cfg: Config, userId: number, score: number,
    reason: CreditReason, day: number): number {
  const cur = userCredit(db, userId);
  const next = Math.max(cfg.credit.min, Math.min(cfg.credit.max, score));
  if (next !== cur) db.prepare('UPDATE users SET credit = ? WHERE id = ?').run(next, userId);
  record(db, userId, next - cur, reason, day, next);
  return next;
}

/**
 * 打工班次信誉 +1，但最近 20 日内经 SHIFT 途径累计增量不得超过 shiftCapPer20d。
 * 已达上限则返回当前分数（不写流水）。
 */
export function shiftCredit(db: DB, cfg: Config, userId: number, day: number): number {
  const gained = (db.prepare(`SELECT COALESCE(SUM(delta),0) s FROM credit_events
    WHERE user_id = ? AND reason = 'SHIFT' AND day > ?`).get(userId, day - SHIFT_WINDOW_DAYS) as
    { s: number }).s;
  if (gained >= cfg.credit.shiftCapPer20d) return userCredit(db, userId);
  return applyCreditEvent(db, cfg, userId, cfg.credit.shiftPoint, 'SHIFT', day);
}

/**
 * 分数 → 授信档（<500 返回 null；tiers 按 minScore 降序，取首个 ≤ 分数的档）。
 *
 * ⚠️ **额度是公式、不是查表**：`信誉分 × cfg.loans.capPerCreditPoint`（分）。
 *    默认 capPerCreditPoint = 500_000 分，即「个人信誉分 × 5000 元」
 *    （600 分 → ¥3,000,000）。故 `tiers` 只保留 `[minScore, rateE6]` 两列。
 *
 * ⚠️ 额度与杠杆上限（`净资产 × 分数 / leverageDivisor`）**都正比于信誉分**，
 *    取严时谁生效只取决于净资产：额度 < 杠杆 ⟺ 净资产 > capPerCreditPoint × leverageDivisor
 *    （默认 500_000 × 300 = 150_000_000 分 = ¥1,500,000）。净资产低于此值时**杠杆先触发**，
 *    此时调大 capPerCreditPoint 不会有任何可见效果。
 */
export function tierOf(cfg: Config, score: number): { capCents: number; rateE6: number } | null {
  for (const [minScore, rateE6] of cfg.loans.tiers) {
    if (score >= minScore) return { capCents: score * cfg.loans.capPerCreditPoint, rateE6 };
  }
  return null;
}
