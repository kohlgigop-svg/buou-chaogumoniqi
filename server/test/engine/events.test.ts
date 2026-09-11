import { describe, it, expect } from 'vitest';
import { generateDayEvents, applyEventImpacts, serializeDrift, restoreDrift } from '../../src/engine/events.js';
import { openDb } from '../../src/db/database.js';
import { seedStocks } from '../../src/seed/stocks.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Rng } from '../../src/core/rng.js';

describe('events', () => {
  function setup() { const db = openDb(':memory:'); seedStocks(db, 1); return db; }
  it('同种子生成完全一致', () => {
    const a = setup(), b = setup();
    generateDayEvents(a, 3, Rng.fromSeed(11, 3, 'events'), DEFAULTS);
    generateDayEvents(b, 3, Rng.fromSeed(11, 3, 'events'), DEFAULTS);
    expect(a.prepare('SELECT type_id,target,tick,impact_e6 FROM news ORDER BY id').all())
      .toEqual(b.prepare('SELECT type_id,target,tick,impact_e6 FROM news ORDER BY id').all());
  });
  it('1000 日事件量符合泊松参数（±15%）', () => {
    const db = setup(); let n = 0;
    for (let d = 1; d <= 1000; d++) { generateDayEvents(db, d, Rng.fromSeed(1, d, 'events'), DEFAULTS); }
    n = (db.prepare('SELECT COUNT(*) c FROM news').get() as any).c;
    const expDaily = 0.3 + 0.8 + 2.5;
    expect(n).toBeGreaterThan(expDaily * 1000 * 0.85);
    expect(n).toBeLessThan(expDaily * 1000 * 1.15);
  });
  it('冲击释放守恒：instant+spread ≈ X', () => {
    const db = setup();
    db.prepare(`INSERT INTO news(day,tick,scope,target,type_id,title,impact_e6,drift_days)
      VALUES(1,100,'STK','600619','T','t',50000,0)`).run(); // X=+5%
    const drift = new Map(); let total = 0;
    for (let t = 100; t < 1160; t++) {
      const m = applyEventImpacts(db, { day: 1, tickInDay: t }, drift, DEFAULTS);
      total += m.get('600619') ?? 0;
    }
    expect(total).toBeCloseTo(0.05, 3);
  });
  it('drift 序列化往返', () => {
    const drift = new Map([['600619', [{ perTick: 1e-4, remainTicks: 5, dayDecayLeft: 2, dailyBase: 0.01 }]]]);
    expect(restoreDrift(serializeDrift(drift))).toEqual(drift);
  });
});
