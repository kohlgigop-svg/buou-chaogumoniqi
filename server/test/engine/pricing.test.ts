import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/database.js';
import { seedStocks } from '../../src/seed/stocks.js';
import { priceTick } from '../../src/engine/pricing.js';
import { indexLevel, closeDay, openDay } from '../../src/engine/candles.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Rng } from '../../src/core/rng.js';

const NOFLOW = { netFlow: () => 0 };
function setup() { const db = openDb(':memory:'); seedStocks(db, 1); return db; }
describe('pricing', () => {
  it('确定性：同种子同轨迹', () => {
    const run = () => { const db = setup(); const drift = new Map();
      const st = { regime: 1 as const, sectorS: {} };
      for (let t = 60; t < 200; t++) priceTick(db, { day: 1, tickInDay: t, regime: st,
        rng: Rng.fromSeed(9, 1, 'pricing'), drift, flow: NOFLOW, cfg: DEFAULTS });
      return db.prepare(`SELECT price FROM stock_state ORDER BY code`).all(); };
    expect(run()).toEqual(run());
  });
  it('价格被涨跌停夹住', () => {
    const db = setup(); const drift = new Map([['600619', [{ perTick: 0.02, remainTicks: 999, dayDecayLeft: 0, dailyBase: 0 }]]]);
    const st = { regime: 1 as const, sectorS: {} };
    for (let t = 60; t < 400; t++) priceTick(db, { day: 1, tickInDay: t, regime: st,
      rng: Rng.fromSeed(3, 1, 'pricing'), drift, flow: NOFLOW, cfg: DEFAULTS });
    const s = db.prepare(`SELECT price, limit_up u FROM stock_state WHERE code='600619'`).get() as any;
    expect(s.price).toBe(s.u);
  });
  it('指数初值 3000，随成分价格移动', () => {
    const db = setup(); openDay(db, 1, DEFAULTS);
    expect(indexLevel(db, 'COMP')).toBeCloseTo(3000, 6);
    db.prepare(`UPDATE stock_state SET price=price*2 WHERE code='600619'`).run();
    expect(indexLevel(db, 'COMP')).toBeGreaterThan(3000);
  });
  it('收盘写日K与指数K', () => {
    const db = setup(); openDay(db, 1, DEFAULTS); closeDay(db, 1);
    expect((db.prepare(`SELECT COUNT(*) c FROM candles_day WHERE day=1`).get() as any).c).toBe(48 + 21);
  });
});
