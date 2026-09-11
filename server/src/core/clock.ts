export const TICK_MS = 3000;
export const TICKS_PER_DAY = 1200;

/**
 * 引擎当前游戏日。`day = floor((last_tick + 1) / 1200) + 1`。
 *
 * 放在 `core/` 而不是 `api/app.ts`：此前它定义在 `app.ts`，而 `app.ts` 又要 import
 * 各个 route 模块，导致 `me.ts` / `auth.ts` / `market.ts` / `domain/loans.ts` 全部
 * 与 `app.ts` 形成循环导入。函数声明能提升所以运行时没炸，但这是靠巧合活着 ——
 * 挪到不依赖任何 route 的 `core/` 彻底断开。
 *
 * **必须用 `last_tick + 1`**（已完成 tick 数），不是 `last_tick`：第 0 个 tick 尚未
 * 完成时 last_tick = -1，此时应算第 1 日。
 */
export function engineDay(db: { prepare: (sql: string) => { get: () => unknown } }): number {
  const row = db.prepare('SELECT last_tick lt FROM engine_state WHERE id = 1').get() as { lt: number };
  return Math.floor((row.lt + 1) / TICKS_PER_DAY) + 1;
}

export type Phase = 'auction_open'|'continuous'|'auction_close'|'settlement';
export function phaseOfTick(tickInDay: number): Phase {
  if (tickInDay < 0 || tickInDay >= TICKS_PER_DAY) throw new Error(`bad tick ${tickInDay}`);
  if (tickInDay < 60) return 'auction_open';
  if (tickInDay < 1160) return 'continuous';
  if (tickInDay < 1180) return 'auction_close';
  return 'settlement';
}
export class GameClock {
  constructor(readonly genesisMs: number) {}
  globalTick(nowMs: number): number {
    if (nowMs < this.genesisMs) throw new Error('before genesis');
    return Math.floor((nowMs - this.genesisMs) / TICK_MS);
  }
  dayOfTick(t: number): number { return Math.floor(t / TICKS_PER_DAY) + 1; }
  tickInDay(t: number): number { return t % TICKS_PER_DAY; }
  gameMinuteAbs(nowMs: number): number {
    return Math.floor((nowMs - this.genesisMs) / 60_000) * 24
      + Math.floor(((nowMs - this.genesisMs) % 60_000) / 2500); // 2.5s=1游戏分
  }
}
