export const TICK_MS = 3000;
export const TICKS_PER_DAY = 1200;
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
