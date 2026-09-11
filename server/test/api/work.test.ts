// test/api/work.test.ts —— Task 9 API 层：/api/jobs、/shifts（排/取消/列）、/work/status、
// /abilities、/courses/enroll，以及 /api/me 的 work 字段接通与 requireAuth 惰性结转。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { GameClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/app.js';

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const PASS = 'p@ssw0rd!9';

let db: DB;
let app: FastifyInstance;
let sid: string;
let uid: number;
let nowMs: number;

function msAtGmin(gmin: number): number { return GENESIS + gmin * 2500; }
function setAbility(kind: string, level: number): void {
  db.prepare('UPDATE abilities SET level = ? WHERE user_id = ? AND kind = ?').run(level, uid, kind);
}

beforeEach(async () => {
  db = openDb(':memory:');
  nowMs = msAtGmin(0);
  const clock = new GameClock(GENESIS);
  const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 1, genesisMs: GENESIS });
  app = await buildApp({ db, cfg: DEFAULTS, engine, clock, now: () => nowMs });
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username: 'worker', password: PASS }, remoteAddress: '1.1.1.1' });
  expect(reg.statusCode).toBe(200);
  uid = reg.json().user.id as number;
  sid = reg.cookies.find(c => c.name === 'sid')!.value;
});

afterEach(async () => { await app.close(); db.close(); });

describe('GET /api/jobs', () => {
  it('未登录 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(res.statusCode).toBe(401);
  });

  it('返回 10 个职业，含 eligible 与 wage', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs', cookies: { sid } });
    expect(res.statusCode).toBe(200);
    const jobs = res.json().jobs as { id: number; name: string; eligible: boolean; wage: number }[];
    expect(jobs).toHaveLength(10);
    expect(jobs.find(j => j.id === 1)).toMatchObject({ name: '传单派发员', eligible: true, wage: 80_000 });
    expect(jobs.find(j => j.id === 2)!.eligible).toBe(false);
  });
});

describe('POST /api/shifts + DELETE', () => {
  it('happy path：排班返回 shiftId 与列表；一班 480 gmin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid },
      payload: { jobId: 1 } });
    expect(res.statusCode).toBe(200);
    const id = res.json().shiftId as number;
    const s = db.prepare('SELECT start_gmin a, end_gmin b, status FROM shifts WHERE id = ?').get(id) as
      { a: number; b: number; status: string };
    expect(s).toMatchObject({ a: 0, b: 480, status: 'scheduled' });
  });

  it('每日 2 班上限：第 3 班 429 SHIFT_CAP', async () => {
    await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid }, payload: { jobId: 1 } });
    await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid }, payload: { jobId: 1 } });
    const res = await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid }, payload: { jobId: 1 } });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('SHIFT_CAP');
  });

  it('资格不足 → 403 JOB_REQUIREMENT', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid },
      payload: { jobId: 2 } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('JOB_REQUIREMENT');
  });

  it('取消未开始班次 → 204；已开始 → 409（working 或 SHIFT_STARTED）', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid }, payload: { jobId: 1 } });
    const id1 = r1.json().shiftId as number;
    const r2 = await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid }, payload: { jobId: 1 } });
    const id2 = r2.json().shiftId as number;
    const del = await app.inject({ method: 'DELETE', url: `/api/shifts/${id2}`, cookies: { sid } });
    expect(del.statusCode).toBe(204);
    // 班1 start=0：requireAuth 的惰性结转已将其置为 working → 不可取消（409）。
    const bad = await app.inject({ method: 'DELETE', url: `/api/shifts/${id1}`, cookies: { sid } });
    expect(bad.statusCode).toBe(409);
    expect(['SHIFT_STARTED', 'SHIFT_NOT_CANCELLABLE']).toContain(bad.json().code);
  });
});

describe('POST /api/courses/enroll', () => {
  it('报名扣费、返回 abilities；满级 409 COURSE_MAX', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/courses/enroll', cookies: { sid },
      payload: { ability: 'FIN' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().enrollmentId).toBeGreaterThan(0);
    const cash = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as { a: number }).a;
    expect(cash).toBe(DEFAULTS.auth.initialCash - DEFAULTS.work.coursePrices[0]!);
    setAbility('FIN', DEFAULTS.work.maxLevel);
    const res2 = await app.inject({ method: 'POST', url: '/api/courses/enroll', cookies: { sid },
      payload: { ability: 'FIN' } });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().code).toBe('COURSE_MAX');
  });

  it('非法能力枚举 → 400 VALIDATION', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/courses/enroll', cookies: { sid },
      payload: { ability: 'HACK' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION');
  });
});

describe('GET /api/work/status 与 /api/abilities', () => {
  it('workStatus 反映进行中的班次；abilities 含六维与下一级学费', async () => {
    await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid }, payload: { jobId: 1 } });
    nowMs = msAtGmin(100); // 进入班次 → working（经 requireAuth 惰性结转）
    const st = await app.inject({ method: 'GET', url: '/api/work/status', cookies: { sid } });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ busyUntil: 480 });
    expect(st.json().shift).toMatchObject({ status: 'working' });

    const ab = await app.inject({ method: 'GET', url: '/api/abilities', cookies: { sid } });
    expect(ab.statusCode).toBe(200);
    expect(ab.json().abilities).toMatchObject({ FIN: 0, FIT: 0 });
    expect(ab.json().nextCourseCost.FIN).toBe(DEFAULTS.work.coursePrices[0]);
  });
});

describe('/api/me 的 work 字段与惰性结转', () => {
  it('到点后首次请求即结转发薪，me.work 反映最新状态', async () => {
    setAbility('FIT', 4);
    await app.inject({ method: 'POST', url: '/api/shifts', cookies: { sid }, payload: { jobId: 2 } });
    const cashBefore = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as { a: number }).a;
    nowMs = msAtGmin(480); // 班次到点
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { sid } });
    expect(me.statusCode).toBe(200);
    expect(me.json().work.busyUntil).toBe(0); // 已结清
    const cashAfter = (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(uid) as { a: number }).a;
    expect(cashAfter).toBe(cashBefore + 165_000); // 外卖骑手 FIT4
    const shift = db.prepare('SELECT status, pay FROM shifts WHERE user_id = ?').get(uid) as
      { status: string; pay: number };
    expect(shift).toMatchObject({ status: 'done', pay: 165_000 });
  });
});
