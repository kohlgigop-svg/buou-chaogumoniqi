import { describe, it, expect } from 'vitest';
import { STOCK_SEEDS, SPARE_NAMES, seedStocks } from '../../src/seed/stocks.js';
import { EVENT_TYPES } from '../../src/seed/events.js';
import { openDb } from '../../src/db/database.js';

describe('seeds', () => {
  it('48 只、创业板 6 只、板块 20 个、代码唯一', () => {
    expect(STOCK_SEEDS).toHaveLength(48);
    expect(STOCK_SEEDS.filter(s => s.board === 'CY')).toHaveLength(6);
    expect(new Set(STOCK_SEEDS.map(s => s.sector)).size).toBe(20);
    expect(new Set(STOCK_SEEDS.map(s => s.code)).size).toBe(48);
    for (const s of STOCK_SEEDS) {
      if (s.board === 'SH') expect(s.code[0]).toBe('6');
      if (s.board === 'SZ') expect(s.code[0]).toBe('0');
      if (s.board === 'CY') expect(s.code.startsWith('30')).toBe(true);
    }
  });
  it('黔台酒业按附录A逐字段正确（抽查行）', () => {
    const m = STOCK_SEEDS.find(s => s.name === '黔台酒业')!;
    expect(m).toMatchObject({ code: '600619', board: 'SH', sector: '白酒饮料',
      price0: 158_000, sharesE8: 12.5, volTier: 'L', beta: 0.7, payout: 'H' });
  });
  it('每板块备用名≥2', () => {
    for (const sec of new Set(STOCK_SEEDS.map(s => s.sector)))
      expect(SPARE_NAMES[sec]!.length).toBeGreaterThanOrEqual(2);
  });
  it('事件库 30 条：6 MKT + 8 SEC + 16 STK，区间合法', () => {
    expect(EVENT_TYPES).toHaveLength(30);
    expect(EVENT_TYPES.filter(e => e.scope === 'MKT')).toHaveLength(6);
    expect(EVENT_TYPES.filter(e => e.scope === 'SEC')).toHaveLength(8);
    expect(EVENT_TYPES.filter(e => e.scope === 'STK')).toHaveLength(16);
    for (const e of EVENT_TYPES) { expect(e.lo).toBeLessThanOrEqual(e.hi); expect(Math.sign(e.lo)).toBe(Math.sign(e.hi)); }
  });
  it('seedStocks 落库自洽', () => {
    const db = openDb(':memory:');
    seedStocks(db, 1);
    expect((db.prepare('SELECT COUNT(*) c FROM stocks').get() as any).c).toBe(48);
    const st = db.prepare(`SELECT * FROM stock_state WHERE code='600619'`).get() as any;
    expect(st.price).toBe(158_000);
    expect(st.limit_up).toBe(173_800); // 1580×1.1=1738.00 元
    expect(st.eps_e6).toBe(Math.round(1580 / 18 * 1e6));
  });
});
