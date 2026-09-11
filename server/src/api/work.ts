// api/work.ts —— 打工与能力：职业列表、排班/取消、课程报名、状态与能力查询（均 requireAuth）。
//
// 时间基：所有时间相关的域调用都以 nowMs = now() 表达；clock 由 buildApp 注入。
// 惰性结转：由 app.ts 的全局 preHandler（processDueForUser）在每次登录态请求前完成，
// 因此本文件的读接口天然反映最新状态。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ShiftSchema, EnrollSchema } from '@pt/shared';
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { GameClock } from '../core/clock.js';
import { listJobs, scheduleShift, cancelShift, listShifts, enrollCourse,
  workStatus, listAbilities, ABILITY_KINDS } from '../domain/work.js';

export interface WorkDeps { db: DB; cfg: Config; clock: GameClock; now: () => number }

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });
const LimitSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });

export async function registerWorkRoutes(app: FastifyInstance, deps: WorkDeps): Promise<void> {
  const { db, cfg, clock, now } = deps;

  /** 职业列表：含资格布尔与当前能力下的实发工资。 */
  app.get('/api/jobs', { preHandler: app.requireAuth }, async (req) =>
    ({ jobs: listJobs(db, cfg, req.user.id) }));

  /** 我的排班（倒序分页）。 */
  app.get('/api/shifts', { preHandler: app.requireAuth }, async (req) => {
    const { limit } = LimitSchema.parse(req.query);
    return { shifts: listShifts(db, req.user.id, limit ?? 50) };
  });

  /** 排班：资格/日上限校验 → 插入 scheduled 班次。 */
  app.post('/api/shifts', { preHandler: app.requireAuth }, async (req) => {
    const { jobId } = ShiftSchema.parse(req.body);
    const id = scheduleShift(db, cfg, clock, now(), req.user.id, jobId);
    return { shiftId: id, shifts: listShifts(db, req.user.id, 50) };
  });

  /** 取消班次：仅 scheduled 且未开始。 */
  app.delete('/api/shifts/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = IdParamSchema.parse(req.params);
    cancelShift(db, clock, now(), req.user.id, id);
    return reply.status(204).send();
  });

  /** 忙碌状态：busyUntil、当前班次、当前课程。 */
  app.get('/api/work/status', { preHandler: app.requireAuth }, async (req) =>
    workStatus(db, cfg, clock, now(), req.user.id));

  /** 六维能力等级。 */
  app.get('/api/abilities', { preHandler: app.requireAuth }, async (req) => {
    const levels = listAbilities(db, req.user.id);
    return { abilities: levels,
      kinds: ABILITY_KINDS,
      nextCourseCost: abilityCosts(cfg, levels) };
  });

  /** 报名课程：扣费并占用时间线。 */
  app.post('/api/courses/enroll', { preHandler: app.requireAuth }, async (req) => {
    const { ability } = EnrollSchema.parse(req.body);
    const id = enrollCourse(db, cfg, clock, now(), req.user.id, ability);
    return { enrollmentId: id, abilities: listAbilities(db, req.user.id) };
  });
}

/** 六维各自下一级课程费用（已满级为 null）。 */
function abilityCosts(cfg: Config, levels: Record<string, number>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of ABILITY_KINDS) {
    const lv = levels[k] ?? 0;
    out[k] = lv >= cfg.work.maxLevel ? null : cfg.work.coursePrices[lv] ?? null;
  }
  return out;
}
