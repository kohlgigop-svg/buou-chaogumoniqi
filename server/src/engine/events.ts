// engine/events.ts —— 事件生成与冲击释放队列
import type { DB } from '../db/database.js';
import type { Rng } from '../core/rng.js';
import type { Config } from '../config/defaults.js';
import { EVENT_TYPES, type EventType } from '../seed/events.js';

export interface DriftItem { perTick: number; remainTicks: number; dayDecayLeft: number; dailyBase: number; }

const SCOPES = ['MKT', 'SEC', 'STK'] as const;
type Scope = (typeof SCOPES)[number];

// 日初调用。RNG 消耗顺序固定（确定性回放依赖）：按 MKT→SEC→STK，每 scope 先 poisson 抽事件数，
// 每事件依次抽：类型 → 目标(MKT 跳过) → tick → 冲击强度。
export function generateDayEvents(db: DB, day: number, rng: Rng, cfg: Config): void {
  // 目标候选（固定序，抽签前一次性取出）
  const sortedSectors = (db.prepare(
    `SELECT DISTINCT sector FROM stocks WHERE status != 'delisted' ORDER BY sector`,
  ).all() as { sector: string }[]).map(r => r.sector);
  const stockRows = db.prepare(
    `SELECT code, name FROM stocks WHERE status != 'delisted' ORDER BY code`,
  ).all() as { code: string; name: string }[];
  const sortedCodes = stockRows.map(r => r.code);
  const nameByCode = new Map(stockRows.map(r => [r.code, r.name]));
  const ins = db.prepare(`INSERT INTO news(day,tick,scope,target,type_id,title,impact_e6,drift_days)
    VALUES (?,?,?,?,?,?,?,?)`);

  for (const scope of SCOPES) {
    const typesOfScope = EVENT_TYPES.filter(t => t.scope === scope);
    const n = rng.poisson(cfg.eventsPerDay[scope]);
    for (let i = 0; i < n; i++) {
      const type: EventType = rng.pick(typesOfScope); // weight 均为 1 → 均匀抽取
      let target: string | null = null;
      let name = '';
      if (scope === 'SEC') { target = rng.pick(sortedSectors); name = target; }
      else if (scope === 'STK') { target = rng.pick(sortedCodes); name = nameByCode.get(target) ?? target; }
      const tick = 60 + rng.int(1100); // 60..1159 均匀
      const x = type.lo + rng.next() * (type.hi - type.lo); // 对数收益，保留符号
      const title = scope === 'MKT' ? type.title : type.title.replace('{name}', name);
      ins.run(day, tick, scope, target, type.id, title, Math.round(x * 1e6), type.driftDays);
    }
  }
}

// 每 tick 调用（不消耗 RNG）：注入本 tick 到达新闻 → 消耗各股 drift 队列，返回 Map<code, r_event>。
export function applyEventImpacts(
  db: DB, ctx: { day: number; tickInDay: number }, drift: Map<string, DriftItem[]>, cfg: Config,
): Map<string, number> {
  const out = new Map<string, number>();
  const add = (code: string, v: number): void => { out.set(code, (out.get(code) ?? 0) + v); };
  const { instantFrac, spreadTicks, driftDecay } = cfg.eventRelease;

  // (a) 本 tick 到达的新闻 → 展开为受影响个股贡献，instant 部分即时入 map，剩余入 drift 队列
  const arrivals = db.prepare(`SELECT scope, target, impact_e6, drift_days FROM news
    WHERE day = ? AND tick = ? ORDER BY id`).all(ctx.day, ctx.tickInDay) as
    { scope: Scope; target: string | null; impact_e6: number; drift_days: number }[];
  for (const nw of arrivals) {
    const x = nw.impact_e6 / 1e6;
    let affected: { code: string; xc: number }[];
    if (nw.scope === 'STK') {
      affected = [{ code: nw.target as string, xc: x }];
    } else if (nw.scope === 'SEC') {
      const rows = db.prepare(`SELECT code FROM stocks WHERE status != 'delisted' AND sector = ?
        ORDER BY code`).all(nw.target) as { code: string }[];
      affected = rows.map(r => ({ code: r.code, xc: x }));
    } else { // MKT：按个股 beta 加权
      const rows = db.prepare(`SELECT code, beta FROM stocks WHERE status != 'delisted'
        ORDER BY code`).all() as { code: string; beta: number }[];
      affected = rows.map(r => ({ code: r.code, xc: x * r.beta }));
    }
    for (const { code, xc } of affected) {
      add(code, xc * instantFrac);
      const q = drift.get(code) ?? [];
      q.push({ perTick: (xc * (1 - instantFrac)) / spreadTicks, remainTicks: spreadTicks,
        dayDecayLeft: nw.drift_days, dailyBase: xc * driftDecay });
      drift.set(code, q);
    }
  }

  // (b) 消耗 drift 队列
  for (const [code, queue] of drift) {
    for (const item of queue) {
      if (item.remainTicks > 0) { add(code, item.perTick); item.remainTicks--; }
    }
  }

  for (const [code, v] of out) { if (v === 0) out.delete(code); } // 0 贡献省略
  return out;
}

// 日终（不消耗 RNG）：dayDecayLeft>0 的项转为次日整日摊释（dailyBase 按 driftDecay 递减），其余丢弃。
export function rolloverDriftDaily(drift: Map<string, DriftItem[]>, cfg: Config): void {
  for (const [code, queue] of drift) {
    const next: DriftItem[] = [];
    for (const item of queue) {
      if (item.dayDecayLeft > 0) {
        next.push({ perTick: item.dailyBase / 1100, remainTicks: 1100,
          dayDecayLeft: item.dayDecayLeft - 1, dailyBase: item.dailyBase * cfg.eventRelease.driftDecay });
      } // else：日终关闭摊释窗口，直接丢弃
    }
    if (next.length > 0) drift.set(code, next); else drift.delete(code);
  }
}

// 引擎快照用：按 code 排序序列化，restore 为其逆
export function serializeDrift(drift: Map<string, DriftItem[]>): string {
  return JSON.stringify([...drift.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
export function restoreDrift(s: string): Map<string, DriftItem[]> {
  return new Map(JSON.parse(s) as [string, DriftItem[]][]);
}
