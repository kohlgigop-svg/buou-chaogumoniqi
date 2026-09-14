// domain/work.ts —— 打工与能力：职业资格/工资公式、班次排程与取消、课程报名与结业、
// 惰性结转（processDueForUser，API preHandler 调用）与结算钩子（WorkSettlementHook）。
//
// 时间基：gmin = clock.gameMinuteAbs(nowMs)。1 游戏分 = 2.5s 墙钟（见 core/clock.ts）。
//   一班 = shiftGameHours × 60 = 480 gmin；课程 = (level+1) × courseHoursPerLevel × 60 gmin。
//   游戏日归属：day = floor(gmin / 1440) + 1（与 GameClock.dayOfTick 同口径）。
//
// 幂等：所有"到点结转"都只对 status 未完成的记录生效，重复调用不会重复发薪/结业。
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { GameClock } from '../core/clock.js';
import { TICK_MS } from '../core/clock.js';
import type { SettlementHook, TickCtx } from '../engine/types.js';
import { post } from '../core/ledger.js';
import { ACC } from '../db/database.js';
import { roundHalfUpDiv, type Cents } from '../core/money.js';
import { shiftCredit } from './credit.js';
import { AppError } from '../api/app.js';

const GMIN_PER_HOUR = 60;
const GMIN_PER_DAY = 1440;

export type AbilityKind = 'EDU' | 'CODE' | 'FIN' | 'FIT' | 'COMM' | 'DESIGN';
export const ABILITY_KINDS: readonly AbilityKind[] =
  ['EDU', 'CODE', 'FIN', 'FIT', 'COMM', 'DESIGN'];

/** 游戏日（1 起算）归属：由 gmin 反推。 */
function dayOfGmin(gmin: number): number { return Math.floor(gmin / GMIN_PER_DAY) + 1; }

// ---------- 能力 ----------

export function abilityLevels(db: DB, userId: number): Record<AbilityKind, number> {
  const rows = db.prepare('SELECT kind, level FROM abilities WHERE user_id = ?').all(userId) as
    { kind: AbilityKind; level: number }[];
  const out = {} as Record<AbilityKind, number>;
  for (const k of ABILITY_KINDS) out[k] = 0;
  for (const r of rows) out[r.kind] = r.level;
  return out;
}

export function listAbilities(db: DB, userId: number): Record<AbilityKind, number> {
  return abilityLevels(db, userId);
}

// ---------- 职业 ----------

export interface JobRow { id: number; name: string; base_pay: Cents; min_credit: number | null;
  reqs: [AbilityKind, number][] }
export interface JobView extends JobRow { eligible: boolean; wage: Cents }

function parseReqs(json: string): [AbilityKind, number][] {
  const raw = JSON.parse(json) as [string, number][];
  return raw.map(([k, n]) => [k as AbilityKind, n]);
}

function loadJob(db: DB, jobId: number): JobRow {
  const r = db.prepare('SELECT id, name, base_pay, min_credit, reqs FROM jobs WHERE id = ?')
    .get(jobId) as { id: number; name: string; base_pay: number; min_credit: number | null; reqs: string } | undefined;
  if (r === undefined) throw new AppError('JOB_NOT_FOUND', 404, 'job not found');
  return { id: r.id, name: r.name, base_pay: r.base_pay, min_credit: r.min_credit, reqs: parseReqs(r.reqs) };
}

/** 工资：base × (1 + wageBonusPerPoint × Σ max(0, level − req))，四舍五入到分。 */
export function wageOf(cfg: Config, job: JobRow, levels: Record<AbilityKind, number>): Cents {
  let over = 0;
  for (const [kind, req] of job.reqs) over += Math.max(0, (levels[kind] ?? 0) - req);
  // base × (1 + k×over) = base × (1e6 + k_e6×over) / 1e6，其中 k_e6 = k×1e6。
  const kE6 = roundHalfUpDiv(cfg.work.wageBonusPerPoint * 1_000_000, 1);
  return roundHalfUpDiv(job.base_pay * (1_000_000 + kE6 * over), 1_000_000);
}

function isEligible(job: JobRow, levels: Record<AbilityKind, number>, credit: number): boolean {
  const reqOk = job.reqs.every(([k, n]) => (levels[k] ?? 0) >= n);
  const creditOk = job.min_credit === null || credit >= job.min_credit;
  return reqOk && creditOk;
}

export function listJobs(db: DB, cfg: Config, userId: number): JobView[] {
  const levels = abilityLevels(db, userId);
  const credit = (db.prepare('SELECT credit c FROM users WHERE id = ?').get(userId) as { c: number }).c;
  const rows = db.prepare('SELECT id, name, base_pay, min_credit, reqs FROM jobs ORDER BY id').all() as
    { id: number; name: string; base_pay: number; min_credit: number | null; reqs: string }[];
  return rows.map(r => {
    const job: JobRow = { id: r.id, name: r.name, base_pay: r.base_pay, min_credit: r.min_credit,
      reqs: parseReqs(r.reqs) };
    return { ...job, eligible: isEligible(job, levels, credit), wage: wageOf(cfg, job, levels) };
  });
}

// ---------- 班次 ----------

export interface ShiftRow { id: number; user_id: number; job_id: number; start_gmin: number;
  end_gmin: number; status: string; pay: Cents | null }

/** 忙碌到（gmin）：max(未取消班次的 end_gmin, 未结业课程的 end_gmin)，无则 0。 */
export function busyUntil(db: DB, userId: number): number {
  const a = db.prepare(`SELECT COALESCE(MAX(end_gmin),0) m FROM shifts
    WHERE user_id = ? AND status IN ('scheduled','working')`).get(userId) as { m: number };
  const b = db.prepare(`SELECT COALESCE(MAX(end_gmin),0) m FROM enrollments
    WHERE user_id = ? AND status = 'active'`).get(userId) as { m: number };
  return Math.max(a.m, b.m);
}

/**
 * 排班：资格（reqs + min_credit）→ start = max(gmin(now), busyUntil) → 当日班次上限
 * （start 所属游戏日已有 scheduled/working/done 班次数 ≥ shiftsPerDay → 429）。
 */
export function scheduleShift(db: DB, cfg: Config, clock: GameClock, nowMs: number,
    userId: number, jobId: number): number {
  const job = loadJob(db, jobId);
  const levels = abilityLevels(db, userId);
  for (const [kind, req] of job.reqs) {
    if ((levels[kind] ?? 0) < req) {
      throw new AppError('JOB_REQUIREMENT', 403, `requirements not met: ${kind}>=${req}`);
    }
  }
  if (job.min_credit !== null) {
    const credit = (db.prepare('SELECT credit c FROM users WHERE id = ?').get(userId) as { c: number }).c;
    if (credit < job.min_credit) {
      throw new AppError('JOB_REQUIREMENT', 403, `credit ${credit} < required ${job.min_credit}`);
    }
  }

  const nowGmin = clock.gameMinuteAbs(nowMs);
  const start = Math.max(nowGmin, busyUntil(db, userId));
  const end = start + cfg.work.shiftGameHours * GMIN_PER_HOUR;

  const day = dayOfGmin(start);
  const sameDay = db.prepare(`SELECT COUNT(*) c FROM shifts
    WHERE user_id = ? AND status IN ('scheduled','working','done')
      AND CAST(start_gmin / ${GMIN_PER_DAY} AS INTEGER) + 1 = ?`).get(userId, day) as { c: number };
  if (sameDay.c >= cfg.work.shiftsPerDay) {
    throw new AppError('SHIFT_CAP', 429, `shift cap per day reached (${cfg.work.shiftsPerDay})`);
  }

  const r = db.prepare(`INSERT INTO shifts(user_id, job_id, start_gmin, end_gmin, status)
    VALUES (?,?,?,?,'scheduled')`).run(userId, jobId, start, end);
  return Number(r.lastInsertRowid);
}

/** 取消：仅 scheduled 且 gmin < start_gmin；已开始 → 409。 */
export function cancelShift(db: DB, clock: GameClock, nowMs: number, userId: number, shiftId: number): void {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as ShiftRow | undefined;
  if (s === undefined || s.user_id !== userId) throw new AppError('SHIFT_NOT_FOUND', 404, 'shift not found');
  if (s.status !== 'scheduled') throw new AppError('SHIFT_NOT_CANCELLABLE', 409, 'shift not cancellable');
  if (clock.gameMinuteAbs(nowMs) >= s.start_gmin) {
    throw new AppError('SHIFT_STARTED', 409, 'shift already started');
  }
  db.prepare("UPDATE shifts SET status = 'cancelled' WHERE id = ?").run(shiftId);
}

export function listShifts(db: DB, userId: number, limit = 50): ShiftRow[] {
  return db.prepare(`SELECT * FROM shifts WHERE user_id = ? ORDER BY id DESC LIMIT ?`)
    .all(userId, limit) as ShiftRow[];
}

// ---------- 课程 ----------

/** Lv n→n+1 费用：config 定值表（n=0..9）。 */
export function courseCostOf(cfg: Config, level: number): Cents {
  const price = cfg.work.coursePrices[level];
  if (price === undefined) throw new AppError('COURSE_MAX', 409, 'max level reached');
  return price;
}

/**
 * 报名：level<maxLevel → 扣费 user→EMPLOYER（kind COURSE_FEE）→
 * start = max(now, busyUntil)、end = start + (level+1)×courseHoursPerLevel×60 → 写 enrollments。
 *
 * ⚠️ 必须查 `enrollments` 判"该能力是否已在读"，**不能只信 `abilities.level`**：
 * `abilities.level` 只在**结业**时才 +1，所以结业前连点 N 次会读到同一个 level、
 * 收同一份学费、堆 N 个 active 报名，结业时各自把 level 从同一 from_level 抬到 +1 ——
 * 玩家用一份钱刷满等级（曾经的 bug，见 work.test.ts 的三条 ⚠️ 断言）。
 * `from_level` 也用**最大未完成级别**推导，保证并发报名不可能重复同一级。
 */
export function enrollCourse(db: DB, cfg: Config, clock: GameClock, nowMs: number,
    userId: number, ability: AbilityKind): number {
  // 该能力所有未结业的报名占用的级别（active 的 from_level）。
  const pending = db.prepare(`SELECT from_level lv FROM enrollments
    WHERE user_id = ? AND kind = ? AND status = 'active'`).all(userId, ability) as { lv: number }[];
  if (pending.length > 0) {
    throw new AppError('COURSE_IN_PROGRESS', 409, `${ability} course already in progress`);
  }

  const levels = abilityLevels(db, userId);
  const level = levels[ability] ?? 0;
  if (level >= cfg.work.maxLevel) throw new AppError('COURSE_MAX', 409, 'max level reached');

  const cost = courseCostOf(cfg, level);
  const avail = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(userId) as
    { a: number }).a;
  if (avail < cost) throw new AppError('INSUFFICIENT_CASH', 400, `need ${cost} available`);

  const start = Math.max(clock.gameMinuteAbs(nowMs), busyUntil(db, userId));
  const end = start + (level + 1) * cfg.work.courseHoursPerLevel * GMIN_PER_HOUR;

  let id = 0;
  db.transaction(() => {
    // 事务内复查（双重检查）：两个并发请求可能都通过了上面的窗口期检查。
    const again = db.prepare(`SELECT COUNT(*) c FROM enrollments
      WHERE user_id = ? AND kind = ? AND status = 'active'`).get(userId, ability) as { c: number };
    if (again.c > 0) throw new AppError('COURSE_IN_PROGRESS', 409, `${ability} course already in progress`);
    post(db, dayOfGmin(start), 0, 'course', 0, [
      { account: userId, bucket: 'A', amount: -cost, kind: 'COURSE_FEE' },
      { account: ACC.EMPLOYER, bucket: 'A', amount: cost, kind: 'COURSE_FEE' },
    ]);
    const r = db.prepare(`INSERT INTO enrollments(user_id, kind, from_level, start_gmin, end_gmin, cost, status)
      VALUES (?,?,?,?,?,?,'active')`).run(userId, ability, level, start, end, cost);
    id = Number(r.lastInsertRowid);
  })();
  return id;
}

// ---------- 结转 ----------

interface DueShift { id: number; user_id: number; job_id: number; start_gmin: number; end_gmin: number }

/**
 * 到点结转（幂等，API preHandler 调用）：
 *   ① 班次：gmin≥end → done + 发薪 EMPLOYER→user（kind WAGE）+ shiftCredit；
 *           gmin≥start 且 <end → working。
 *   ② 课程：gmin≥end → done + ability level+1。
 * 只对本用户生效；重复调用不重复发薪（status 已终态）。
 */
export function processDueForUser(db: DB, cfg: Config, clock: GameClock, nowMs: number, userId: number): void {
  const gmin = clock.gameMinuteAbs(nowMs);
  const day = dayOfGmin(gmin);

  const shifts = db.prepare(`SELECT id, user_id, job_id, start_gmin, end_gmin FROM shifts
    WHERE user_id = ? AND status IN ('scheduled','working') ORDER BY id`).all(userId) as DueShift[];
  for (const s of shifts) {
    if (gmin >= s.end_gmin) {
      const job = loadJob(db, s.job_id);
      const pay = wageOf(cfg, job, abilityLevels(db, userId));
      db.transaction(() => {
        post(db, day, 0, 'shift', s.id, [
          { account: ACC.EMPLOYER, bucket: 'A', amount: -pay, kind: 'WAGE' },
          { account: userId, bucket: 'A', amount: pay, kind: 'WAGE' },
        ]);
        db.prepare("UPDATE shifts SET status = 'done', pay = ? WHERE id = ?").run(pay, s.id);
        shiftCredit(db, cfg, userId, day);
      })();
    } else if (gmin >= s.start_gmin) {
      db.prepare("UPDATE shifts SET status = 'working' WHERE id = ?").run(s.id);
    }
  }

  const enrolls = db.prepare(`SELECT id, user_id, kind, from_level, end_gmin FROM enrollments
    WHERE user_id = ? AND status = 'active' ORDER BY id`).all(userId) as
    { id: number; user_id: number; kind: AbilityKind; from_level: number; end_gmin: number }[];
  for (const e of enrolls) {
    if (gmin >= e.end_gmin) {
      db.transaction(() => {
        db.prepare(`UPDATE abilities SET level = ? WHERE user_id = ? AND kind = ?`)
          .run(e.from_level + 1, userId, e.kind);
        db.prepare("UPDATE enrollments SET status = 'done' WHERE id = ?").run(e.id);
      })();
    }
  }
}

// ---------- 视图 ----------

export interface WorkStatus { busyUntil: number; shift: ShiftRow | null; course: unknown | null }

export function workStatus(db: DB, cfg: Config, clock: GameClock, nowMs: number, userId: number): WorkStatus {
  void cfg;
  const gmin = clock.gameMinuteAbs(nowMs);
  const shift = db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status IN ('scheduled','working')
    ORDER BY start_gmin LIMIT 1`).get(userId) as ShiftRow | undefined;
  const course = db.prepare(`SELECT * FROM enrollments WHERE user_id = ? AND status = 'active'
    ORDER BY start_gmin LIMIT 1`).get(userId) as Record<string, unknown> | undefined;
  // 正在进行的（start ≤ gmin < end）优先展示
  const working = db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'working'
    AND start_gmin <= ? AND end_gmin > ? ORDER BY start_gmin LIMIT 1`).get(userId, gmin, gmin) as
    ShiftRow | undefined;
  return { busyUntil: busyUntil(db, userId), shift: working ?? shift ?? null, course: course ?? null };
}

// ---------- 结算钩子 ----------

export interface WorkHookDeps { db: DB; cfg: Config; clock: GameClock;
  /** 结算时刻（毫秒）。默认由 ctx.globalTick 反推（游戏时间轴）；仅测试需要覆盖时才注入。 */
  now?: () => number }

/**
 * 结算钩子：对全体存在未完成班次/课程的用户执行 processDueForUser。
 *
 * ⚠️ 时间基必须与引擎 tick 对齐，**不能**用真实墙钟：引擎的 `catchUpTo` 会以远超实时的
 * 速度补跑（测试里 1 次调用可推进数日），若取 `Date.now()`，则游戏 genesis 之后累积的
 * 真实时间会把 gmin 推到极远的未来，导致所有排队中的班次/课程在第一次结算时被判定为
 * "已到点"而瞬间全部发薪/结业（曾出现 ledger.day≈5740 的越界记录）。
 * 因此这里从 `ctx.globalTick` 反推该 tick 的墙钟毫秒：`genesisMs + globalTick * TICK_MS`。
 * 注入 `now` 仅用于单测构造不经过引擎的确定性场景。
 */
export class WorkSettlementHook implements SettlementHook {
  private readonly db: DB;
  private readonly cfg: Config;
  private readonly clock: GameClock;
  private readonly now: (() => number) | null;

  constructor(deps: WorkHookDeps) {
    this.db = deps.db;
    this.cfg = deps.cfg;
    this.clock = deps.clock;
    this.now = deps.now ?? null;
  }

  onSettlement(ctx: TickCtx): void {
    const users = this.db.prepare(`SELECT DISTINCT user_id u FROM shifts
      WHERE status IN ('scheduled','working')
      UNION SELECT DISTINCT user_id FROM enrollments WHERE status = 'active'`).all() as { u: number }[];
    const nowMs = this.now !== null ? this.now()
      : this.clock.genesisMs + ctx.globalTick * TICK_MS;
    for (const r of users) processDueForUser(this.db, this.cfg, this.clock, nowMs, r.u);
  }
}
