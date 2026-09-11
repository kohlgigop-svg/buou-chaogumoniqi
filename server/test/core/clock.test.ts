import { describe, it, expect } from 'vitest';
import { GameClock, phaseOfTick, TICK_MS, TICKS_PER_DAY } from '../../src/core/clock.js';

const G = 1_700_000_000_000;
const c = new GameClock(G);
describe('clock', () => {
  it('创世时刻是第1日 tick0 开盘竞价', () => {
    expect(c.globalTick(G)).toBe(0);
    expect(c.dayOfTick(0)).toBe(1);
    expect(c.tickInDay(0)).toBe(0);
    expect(phaseOfTick(0)).toBe('auction_open');
  });
  it('相位边界', () => {
    expect(phaseOfTick(59)).toBe('auction_open');
    expect(phaseOfTick(60)).toBe('continuous');
    expect(phaseOfTick(1159)).toBe('continuous');
    expect(phaseOfTick(1160)).toBe('auction_close');
    expect(phaseOfTick(1180)).toBe('settlement');
    expect(phaseOfTick(1199)).toBe('settlement');
  });
  it('一小时后进入第2日', () => {
    const t = c.globalTick(G + 3_600_000);
    expect(t).toBe(TICKS_PER_DAY);
    expect(c.dayOfTick(t)).toBe(2);
    expect(c.tickInDay(t)).toBe(0);
  });
  it('tick 不足不进位', () => { expect(c.globalTick(G + TICK_MS - 1)).toBe(0); });
  it('游戏分钟换算 1现实分=24游戏分', () => {
    expect(c.gameMinuteAbs(G + 60_000) - c.gameMinuteAbs(G)).toBe(24);
  });
});
