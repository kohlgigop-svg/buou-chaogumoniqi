// test/api/config-isolation.test.ts —— 两个既有缺陷的回归防线（2026-09-14 补）。
//
// 这两个问题都**不会**在单次运行中稳定暴露，历史上分别被误判为「flaky」和「没发生」：
//
// 1. `PUT /api/admin/config` 原位改写调用方传入的 cfg 对象。若调用方传的是模块级单例
//    （如 `DEFAULTS`），改动会**永久留在单例上**，污染同一进程内后续所有用例/实例。
//    当前恰好没有用例排在其后，所以一直没被咬到 —— 属"侥幸活着"。
//
// 2. `scheduleShift` 用 `start = max(nowGmin, busyUntil)` 排下一班。一班 8 游戏小时，
//    第 1 班跨午夜时第 2 班落进**下一个游戏日**，日上限查询按 `start_gmin` 算天，
//    于是查到新的一天（0 班）→ 不触发 `SHIFT_CAP`。
//    用真实时钟时，游戏日内分钟在 [960, 1440)（约 1/3 的真实时段）就会失败。
//
// 本文件把两条都钉死，避免回归。

import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { buildApp } from '../../src/api/app.js';

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const PASS = 'p@ssw0rd!9';

let app: FastifyInstance | undefined;
let db: DB | undefined;

afterEach(async () => {
  if (app !== undefined) await app.close();
  if (db !== undefined) db.close();
  app = undefined; db = undefined;
});

async function makeApp(nowMs: number): Promise<{ app: FastifyInstance; db: DB }> {
  const d = openDb(':memory:');
  const engine = new Engine({ db: d, cfg: DEFAULTS, masterSeed: 5, genesisMs: GENESIS });
  const a = await buildApp({ db: d, cfg: DEFAULTS, engine, now: () => nowMs });
  db = d; app = a;
  return { app: a, db: d };
}

async function adminSidOf(a: FastifyInstance, d: DB): Promise<string> {
  const reg = await a.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username: 'root', password: PASS }, remoteAddress: '9.9.9.9' });
  const id = reg.json().user.id as number;
  d.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
  const login = await a.inject({ method: 'POST', url: '/api/auth/login',
    payload: { username: 'root', password: PASS } });
  return login.cookies.find(c => c.name === 'sid')!.value;
}

describe('config 热更新不得污染调用方的 cfg（DEFAULTS 单例）', () => {
  it('PUT /api/admin/config 之后，DEFAULTS 保持原值', async () => {
    const before = DEFAULTS.work.shiftsPerDay;
    expect(before).toBe(2); // 前置断言：确保单例进来时是干净的

    const { app: a, db: d } = await makeApp(GENESIS);
    const sid = await adminSidOf(a, d);

    const ok = await a.inject({ method: 'PUT', url: '/api/admin/config', cookies: { sid },
      payload: { key: 'work.shiftsPerDay', value: 1 } });
    expect(ok.statusCode).toBe(200);

    // 核心断言：进程级单例**不得**被改写
    expect(DEFAULTS.work.shiftsPerDay).toBe(before);
  });

  it('改动对本实例生效，但对之后新建的实例不生效', async () => {
    const { app: a1, db: d1 } = await makeApp(GENESIS);
    const sid1 = await adminSidOf(a1, d1);
    await a1.inject({ method: 'PUT', url: '/api/admin/config', cookies: { sid: sid1 },
      payload: { key: 'work.shiftsPerDay', value: 1 } });
    await a1.close(); d1.close(); app = undefined; db = undefined;

    // 新实例读到的应是 DEFAULTS 的原始值 2，而不是上一个实例改过的 1
    const { app: a2, db: d2 } = await makeApp(GENESIS);
    const sid2 = await adminSidOf(a2, d2);
    const cfgRes = await a2.inject({ method: 'GET', url: '/api/admin/config', cookies: { sid: sid2 } });
    expect(cfgRes.statusCode).toBe(200);
    expect((cfgRes.json().config as { work: { shiftsPerDay: number } }).work.shiftsPerDay).toBe(2);
  });
});

describe('排班日上限的口径：按「班次开始日」算（跨午夜不等于超限）', () => {
  // 语义裁定（2026-09-14，经需求方确认）：日上限按 **start_gmin 所属游戏日** 计算。
  // 场景：游戏日 10 的 22:00 排第 1 班（22:00–次日 06:00），第 2 班从 06:00 起 ——
  // 它属于**游戏日 11**，故游戏日 10 只排了 1 班，不超限，应**允许**。
  // `shiftsPerDay=1` 时连续两次排班在特定时刻被拒，只是因为两班恰好同日，不是恒定行为。
  const LATE_NIGHT = GENESIS + 55 * 60_000; // gameMinuteAbs = 1320（22:00）

  it('第 1 班跨午夜时，第 2 班属次日，不应被 SHIFT_CAP 拦下', async () => {
    const { app: a, db: d } = await makeApp(LATE_NIGHT);
    const sid = await adminSidOf(a, d);
    await a.inject({ method: 'PUT', url: '/api/admin/config', cookies: { sid },
      payload: { key: 'work.shiftsPerDay', value: 1 } });

    const reg = await a.inject({ method: 'POST', url: '/api/auth/register',
      payload: { username: 'alice', password: PASS }, remoteAddress: '1.1.1.1' });
    const aliceSid = reg.cookies.find(c => c.name === 'sid')!.value;

    const s1 = await a.inject({ method: 'POST', url: '/api/shifts', cookies: { sid: aliceSid },
      payload: { jobId: 1 } });
    expect(s1.statusCode).toBe(200);

    const s2 = await a.inject({ method: 'POST', url: '/api/shifts', cookies: { sid: aliceSid },
      payload: { jobId: 1 } });
    expect(s2.statusCode).toBe(200);

    // 且两班确实落在相邻的两个游戏日 —— 这才是「不超限」的真实原因
    const rows = d.prepare('SELECT start_gmin FROM shifts ORDER BY id').all() as { start_gmin: number }[];
    const dayOf = (g: number): number => Math.floor(g / 1440) + 1;
    expect(dayOf(rows[0]!.start_gmin)).toBe(dayOf(1320));      // 第 1 班在 22:00 所在日
    expect(dayOf(rows[1]!.start_gmin)).toBe(dayOf(1320) + 1);  // 第 2 班已跨到次日
  });

  it('同日内连排第 2 班（不跨午夜）必须被 SHIFT_CAP 拦下', async () => {
    // 对照组：00:00 起排，两班 00:00–08:00 / 08:00–16:00 都在同一游戏日内。
    const { app: a, db: d } = await makeApp(GENESIS);
    const sid = await adminSidOf(a, d);
    await a.inject({ method: 'PUT', url: '/api/admin/config', cookies: { sid },
      payload: { key: 'work.shiftsPerDay', value: 1 } });

    const reg = await a.inject({ method: 'POST', url: '/api/auth/register',
      payload: { username: 'alice', password: PASS }, remoteAddress: '1.1.1.1' });
    const aliceSid = reg.cookies.find(c => c.name === 'sid')!.value;

    const s1 = await a.inject({ method: 'POST', url: '/api/shifts', cookies: { sid: aliceSid },
      payload: { jobId: 1 } });
    expect(s1.statusCode).toBe(200);
    const s2 = await a.inject({ method: 'POST', url: '/api/shifts', cookies: { sid: aliceSid },
      payload: { jobId: 1 } });
    expect(s2.statusCode).toBe(429);
    expect(s2.json().code).toBe('SHIFT_CAP');
  });
});
