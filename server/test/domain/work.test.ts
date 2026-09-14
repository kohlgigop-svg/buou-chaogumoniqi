// test/domain/work.test.ts —— Task 9：打工与能力（职业资格 / 工资公式 / 班次排队与日上限 /
// 课程费用表与结业 / 惰性结转与结算钩子等价且幂等）。
// 时间基：gmin = clock.gameMinuteAbs(nowMs)；测试注入 nowMs 精确控制时间线。
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS, type Config } from '../../src/config/defaults.js';
import { GameClock } from '../../src/core/clock.js';
import { post, auditGlobal } from '../../src/core/ledger.js';
import {
  listJobs, busyUntil, scheduleShift, cancelShift, enrollCourse, listShifts,
  processDueForUser, WorkSettlementHook, wageOf, courseCostOf, listAbilities,
  workStatus, abilityLevels,
} from '../../src/domain/work.js';

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const cfg: Config = DEFAULTS;

let db: DB;
let clock: GameClock;
let uid: number;

/** gmin（游戏分钟）→ nowMs（墙钟毫秒）。1 游戏分 = 2.5s。 */
function msAtGmin(gmin: number): number {
  return GENESIS + gmin * 2500;
}

function newUser(name: string, cash = DEFAULTS.auth.initialCash): number {
  const r = db.prepare(`INSERT INTO users(username, pwd_hash, created_day, created_at)
    VALUES (?, 'x', 1, 0)`).run(name);
  const id = Number(r.lastInsertRowid);
  post(db, 1, 0, 'genesis', id, [
    { account: ACC.MARKET, bucket: 'A', amount: -cash, kind: 'GENESIS' },
    { account: id, bucket: 'A', amount: cash, kind: 'GENESIS' },
  ]);
  for (const kind of ['EDU', 'CODE', 'FIN', 'FIT', 'COMM', 'DESIGN']) {
    db.prepare('INSERT INTO abilities(user_id, kind, level) VALUES (?,?,0)').run(id, kind);
  }
  return id;
}

function setAbility(id: number, kind: string, level: number): void {
  db.prepare('UPDATE abilities SET level = ? WHERE user_id = ? AND kind = ?').run(level, id, kind);
}
function creditOf(id: number): number {
  return (db.prepare('SELECT credit c FROM users WHERE id = ?').get(id) as { c: number }).c;
}

function setAbilityOn(db: DB, id: number, kind: string, level: number): void {
  db.prepare('UPDATE abilities SET level = ? WHERE user_id = ? AND kind = ?').run(level, id, kind);
}

function newUserOn(db: DB, name: string, cash = DEFAULTS.auth.initialCash): number {
  const r = db.prepare(`INSERT INTO users(username, pwd_hash, created_day, created_at)
    VALUES (?, 'x', 1, 0)`).run(name);
  const id = Number(r.lastInsertRowid);
  post(db, 1, 0, 'genesis', id, [
    { account: ACC.MARKET, bucket: 'A', amount: -cash, kind: 'GENESIS' },
    { account: id, bucket: 'A', amount: cash, kind: 'GENESIS' },
  ]);
  for (const kind of ['EDU', 'CODE', 'FIN', 'FIT', 'COMM', 'DESIGN']) {
    db.prepare('INSERT INTO abilities(user_id, kind, level) VALUES (?,?,0)').run(id, kind);
  }
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  clock = new GameClock(GENESIS);
  uid = newUser('worker');
});

// ---------- 工资公式 ----------

describe('wageOf：工资公式 基础×（1+0.05×超出点数）', () => {
  it('外卖骑手 FIT4（reqs FIT2）→ 1500×1.1 = 1650 元 = 165_000 分', () => {
    setAbility(uid, 'FIT', 4);
    const rider = listJobs(db, cfg, uid).find(j => j.id === 2)!;
    expect(wageOf(cfg, rider, abilityLevels(db, uid))).toBe(165_000);
  });

  it('基金经理满级（FIN10/EDU8，reqs FIN9+EDU7）→ 15000×(1+0.05×(1+1)) = 16500 元 = 1_650_000 分', () => {
    setAbility(uid, 'FIN', 10);
    setAbility(uid, 'EDU', 8);
    const mgr = listJobs(db, cfg, uid).find(j => j.id === 10)!;
    expect(wageOf(cfg, mgr, abilityLevels(db, uid))).toBe(1_650_000);
  });

  it('恰好满足要求（无超出）→ 基础工资原值', () => {
    setAbility(uid, 'FIT', 2);
    const rider = listJobs(db, cfg, uid).find(j => j.id === 2)!;
    expect(wageOf(cfg, rider, abilityLevels(db, uid))).toBe(150_000);
  });
});

// ---------- 职业资格 ----------

describe('listJobs：资格布尔与信誉门槛', () => {
  it('无能力时只有"传单派发员"可做，其余 eligible=false', () => {
    const jobs = listJobs(db, cfg, uid);
    expect(jobs).toHaveLength(10);
    expect(jobs.find(j => j.id === 1)!.eligible).toBe(true);
    expect(jobs.find(j => j.id === 2)!.eligible).toBe(false);
    expect(jobs.find(j => j.id === 10)!.eligible).toBe(false);
  });

  it('能力达标但信誉不足 → 基金经理仍不可做（min_credit 700）', () => {
    setAbility(uid, 'FIN', 9); setAbility(uid, 'EDU', 7);
    db.prepare('UPDATE users SET credit = 650 WHERE id = ?').run(uid);
    expect(listJobs(db, cfg, uid).find(j => j.id === 10)!.eligible).toBe(false);
    db.prepare('UPDATE users SET credit = 700 WHERE id = ?').run(uid);
    expect(listJobs(db, cfg, uid).find(j => j.id === 10)!.eligible).toBe(true);
  });

  it('scheduleShift 资格不足 → 403 JOB_REQUIREMENT', () => {
    expect(() => scheduleShift(db, cfg, clock, msAtGmin(0), uid, 2))
      .toThrowError(/requirements not met|JOB_REQUIREMENT/i);
  });
});

// ---------- 班次 ----------

describe('scheduleShift：时长、排队衔接、日上限', () => {
  it('一班 = 8 游戏小时 = 480 gmin；start=max(now, busyUntil)；end=start+480', () => {
    const t0 = msAtGmin(0);
    const id = scheduleShift(db, cfg, clock, t0, uid, 1);
    const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id) as
      { start_gmin: number; end_gmin: number; status: string };
    expect(s.start_gmin).toBe(0);
    expect(s.end_gmin).toBe(480);
    expect(s.status).toBe('scheduled');
  });

  it('排队衔接：第二班 start = 第一班 end（busyUntil 链）', () => {
    const id1 = scheduleShift(db, cfg, clock, msAtGmin(0), uid, 1);
    const id2 = scheduleShift(db, cfg, clock, msAtGmin(10), uid, 1);
    const s1 = db.prepare('SELECT start_gmin a, end_gmin b FROM shifts WHERE id = ?').get(id1) as
      { a: number; b: number };
    const s2 = db.prepare('SELECT start_gmin a, end_gmin b FROM shifts WHERE id = ?').get(id2) as
      { a: number; b: number };
    expect(s2.a).toBe(s1.b);
    expect(busyUntil(db, uid)).toBe(s2.b);
  });

  it('每游戏日最多开始 2 班：第 3 班 429 SHIFT_CAP；次日游戏日可再排', () => {
    // day1: 0..480、480..960 两班；第三班落在 day1（960..1440）应被拒
    scheduleShift(db, cfg, clock, msAtGmin(0), uid, 1);
    scheduleShift(db, cfg, clock, msAtGmin(0), uid, 1);
    try {
      scheduleShift(db, cfg, clock, msAtGmin(0), uid, 1);
      throw new Error('expected SHIFT_CAP');
    } catch (e) {
      expect(String(e)).toMatch(/SHIFT_CAP|shift cap/i);
    }
    // 次日（1440 起）可再排
    const id = scheduleShift(db, cfg, clock, msAtGmin(1440), uid, 1);
    const s = db.prepare('SELECT start_gmin a FROM shifts WHERE id = ?').get(id) as { a: number };
    expect(s.a).toBe(1440);
  });
});

describe('cancelShift：仅 scheduled 且未开始', () => {
  it('未开始可取消；已开始（gmin≥start）→ 409 SHIFT_STARTED', () => {
    // 排两班衔接：班1 [0,480) 立即开始；班2 [480,960) 尚未开始 → 可取消。
    scheduleShift(db, cfg, clock, msAtGmin(0), uid, 1);
    const id2 = scheduleShift(db, cfg, clock, msAtGmin(0), uid, 1);
    cancelShift(db, clock, msAtGmin(0), uid, id2);
    expect((db.prepare('SELECT status FROM shifts WHERE id = ?').get(id2) as { status: string }).status)
      .toBe('cancelled');
    // 班1 已开始（start=0）：即使 gmin=0 也不可取消
    const id1 = (db.prepare('SELECT id FROM shifts WHERE user_id = ? ORDER BY id LIMIT 1')
      .get(uid) as { id: number }).id;
    expect(() => cancelShift(db, clock, msAtGmin(0), uid, id1))
      .toThrowError(/already started|SHIFT_STARTED/i);
  });
});

// ---------- 课程 ----------

describe('courseCostOf：费用表精确 10 值与总和', () => {
  it('逐级费用等于 DEFAULTS.work.coursePrices，总和 90_792_635 分（约 ¥90.8 万）', () => {
    const costs: number[] = [];
    for (let n = 0; n < 10; n++) costs.push(courseCostOf(cfg, n));
    expect(costs).toEqual(cfg.work.coursePrices);
    const sum = costs.reduce((a, b) => a + b, 0);
    expect(sum).toBe(90_792_635);
  });

  it('报名扣费 user→EMPLOYER，写 kind COURSE_FEE，时长 (level+1)×8 游戏小时', () => {
    const before = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as { a: number }).a;
    const id = enrollCourse(db, cfg, clock, msAtGmin(0), uid, 'FIN');
    const cost = courseCostOf(cfg, 0);
    const after = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as { a: number }).a;
    expect(after).toBe(before - cost);
    const e = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(id) as
      { kind: string; from_level: number; start_gmin: number; end_gmin: number; cost: number; status: string };
    expect(e).toMatchObject({ kind: 'FIN', from_level: 0, start_gmin: 0, end_gmin: 480, cost, status: 'active' });
    const leg = db.prepare(`SELECT COUNT(*) c FROM ledger WHERE user_id = ? AND kind = 'COURSE_FEE'`)
      .get(uid) as { c: number };
    expect(leg.c).toBe(1);
  });

  it('上课期间不可再报课/打工（busyUntil 生效）', () => {
    enrollCourse(db, cfg, clock, msAtGmin(0), uid, 'FIN');
    expect(busyUntil(db, uid)).toBe(480);
    const id = scheduleShift(db, cfg, clock, msAtGmin(0), uid, 1);
    expect((db.prepare('SELECT start_gmin a FROM shifts WHERE id = ?').get(id) as { a: number }).a).toBe(480);
  });

  it('已满级 → 409 COURSE_MAX', () => {
    setAbility(uid, 'FIN', cfg.work.maxLevel);
    expect(() => enrollCourse(db, cfg, clock, msAtGmin(0), uid, 'FIN'))
      .toThrowError(/max level|COURSE_MAX/i);
  });

  // ⚠️ 曾经的 bug：abilities.level 只在课程**结业**时才 +1，而 enrollCourse 用
  // abilities.level 判级。于是结业前连点 N 次 → 每次都读到同一 level、收同一份钱、
  // 堆 N 个 concurrency 的 active 报名，结业时各自把 level 从同一 from_level 抬到 +1。
  // 玩家只用一份学费就刷满了等级。以下三条把该行为钉死。
  it('⚠️ 同一能力已有在读课程 → 再次报名必须被拒（409 COURSE_IN_PROGRESS）', () => {
    enrollCourse(db, cfg, clock, msAtGmin(0), uid, 'FIN');
    expect(() => enrollCourse(db, cfg, clock, msAtGmin(0), uid, 'FIN'))
      .toThrowError(/in progress|COURSE_IN_PROGRESS/i);
  });

  it('⚠️ 连点 5 次只扣 1 次费用，且只留 1 条 active 报名', () => {
    const before = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as
      { a: number }).a;
    let ok = 0;
    for (let i = 0; i < 5; i++) {
      try { enrollCourse(db, cfg, clock, msAtGmin(0), uid, 'FIN'); ok++; } catch { /* 预期被拒 */ }
    }
    expect(ok).toBe(1);
    const cost = courseCostOf(cfg, 0);
    const after = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as
      { a: number }).a;
    expect(after).toBe(before - cost);   // 不是 before - cost*5
    const act = (db.prepare(`SELECT COUNT(*) c FROM enrollments
      WHERE user_id = ? AND kind = 'FIN' AND status = 'active'`).get(uid) as { c: number }).c;
    expect(act).toBe(1);
  });

  it('⚠️ 结业后等级只 +1（不会因重复报名一次跳多级）', () => {
    for (let i = 0; i < 3; i++) {
      try { enrollCourse(db, cfg, clock, msAtGmin(0), uid, 'FIN'); } catch { /* ignore */ }
    }
    processDueForUser(db, cfg, clock, msAtGmin(500), uid);
    expect(abilityLevels(db, uid)['FIN']).toBe(1);
  });

  it('⚠️ 不同能力可并行报名（限制只针对同一 kind）', () => {
    // 同一时刻只能做一件事由 busyUntil 保证，但"已在读"的判定不应误伤别的能力。
    // 这里只断言：FIN 在读时，报 CODE 不会因"有课在读"被拒（会排在 FIN 之后）。
    enrollCourse(db, cfg, clock, msAtGmin(0), uid, 'FIN');
    const id = enrollCourse(db, cfg, clock, msAtGmin(0), uid, 'CODE');
    const e = db.prepare('SELECT kind, start_gmin FROM enrollments WHERE id = ?').get(id) as
      { kind: string; start_gmin: number };
    expect(e.kind).toBe('CODE');
    expect(e.start_gmin).toBe(480);   // 排在 FIN 之后，不是拒绝
  });
});

// ---------- 惰性结转与结算钩子 ----------

describe('processDueForUser 与 WorkSettlementHook 等价且幂等', () => {
  it('班次到点发薪：EMPLOYER→user、写 WAGE 流水、信誉 +1', () => {
    setAbility(uid, 'FIT', 4); // 外卖骑手 165_000
    const id = scheduleShift(db, cfg, clock, msAtGmin(0), uid, 2);
    const before = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as { a: number }).a;
    const creditBefore = creditOf(uid);
    processDueForUser(db, cfg, clock, msAtGmin(480), uid);
    const s = db.prepare('SELECT status, pay FROM shifts WHERE id = ?').get(id) as { status: string; pay: number };
    expect(s).toMatchObject({ status: 'done', pay: 165_000 });
    const after = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as { a: number }).a;
    expect(after).toBe(before + 165_000);
    expect(creditOf(uid)).toBe(Math.min(cfg.credit.max, creditBefore + cfg.credit.shiftPoint));
    const leg = db.prepare(`SELECT COUNT(*) c FROM ledger WHERE user_id = ? AND kind = 'WAGE'`).get(uid) as { c: number };
    expect(leg.c).toBe(1);
    auditGlobal(db);
  });

  it('幂等：同一时刻重复调用不双发工资', () => {
    setAbility(uid, 'FIT', 4);
    scheduleShift(db, cfg, clock, msAtGmin(0), uid, 2);
    processDueForUser(db, cfg, clock, msAtGmin(480), uid);
    const cash1 = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as { a: number }).a;
    processDueForUser(db, cfg, clock, msAtGmin(600), uid);
    processDueForUser(db, cfg, clock, msAtGmin(600), uid);
    const cash2 = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as { a: number }).a;
    expect(cash2).toBe(cash1);
  });

  it('课程到点结业：abilities level+1，状态 done', () => {
    const id = enrollCourse(db, cfg, clock, msAtGmin(0), uid, 'FIN');
    processDueForUser(db, cfg, clock, msAtGmin(480), uid);
    const e = db.prepare('SELECT status FROM enrollments WHERE id = ?').get(id) as { status: string };
    expect(e.status).toBe('done');
    expect(abilityLevels(db, uid)['FIN']).toBe(1);
  });

  it('中间态：gmin≥start 且 <end → status working', () => {
    const id = scheduleShift(db, cfg, clock, msAtGmin(0), uid, 1);
    processDueForUser(db, cfg, clock, msAtGmin(100), uid);
    expect((db.prepare('SELECT status FROM shifts WHERE id = ?').get(id) as { status: string }).status)
      .toBe('working');
  });

  it('惰性结转与结算钩子在相同时刻结果一致（两条独立时间线）', () => {
    // 时间线 A：惰性 processDueForUser
    const uidA = uid;
    setAbility(uidA, 'FIT', 4);
    scheduleShift(db, cfg, clock, msAtGmin(0), uidA, 2);
    processDueForUser(db, cfg, clock, msAtGmin(480), uidA);
    const cashA = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uidA) as { a: number }).a;

    // 时间线 B：结算钩子（用独立引擎，结算 tick 时 now=结算时刻）
    const dbB = openDb(':memory:');
    const clockB = new GameClock(GENESIS);
    const uidB = newUserOn(dbB, 'workerB');
    setAbilityOn(dbB, uidB, 'FIT', 4);
    let hookNow = msAtGmin(0);
    const hook = new WorkSettlementHook({ db: dbB, cfg, clock: clockB, now: () => hookNow });
    scheduleShift(dbB, cfg, clockB, msAtGmin(0), uidB, 2);
    hookNow = msAtGmin(480);
    hook.onSettlement({ day: 1, tickInDay: 1180, globalTick: 1180, phase: 'settlement',
      db: dbB, rng: null as never, cfg, quotes: new Map() });
    const cashB = (dbB.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uidB) as { a: number }).a;
    expect(cashB).toBe(cashA);
    dbB.close();
  });
});

// ---------- 视图 ----------

describe('视图：workStatus / listAbilities / listShifts', () => {
  it('workStatus 汇总 busyUntil、当前班次与课程', () => {
    setAbility(uid, 'FIT', 2);
    const sid = scheduleShift(db, cfg, clock, msAtGmin(0), uid, 2);
    processDueForUser(db, cfg, clock, msAtGmin(100), uid); // → working
    const st = workStatus(db, cfg, clock, msAtGmin(100), uid);
    expect(st.busyUntil).toBe(480);
    expect(st.shift).toMatchObject({ id: sid, status: 'working' });
    expect(st.course).toBe(null);
  });

  it('listAbilities 返回 6 项等级；listShifts 倒序分页', () => {
    expect(Object.keys(listAbilities(db, uid)).sort()).toEqual(
      ['CODE', 'COMM', 'DESIGN', 'EDU', 'FIN', 'FIT']);
    scheduleShift(db, cfg, clock, msAtGmin(0), uid, 1);
    scheduleShift(db, cfg, clock, msAtGmin(0), uid, 1);
    const rows = listShifts(db, uid, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBeGreaterThan(rows[1]!.id);
  });
});
