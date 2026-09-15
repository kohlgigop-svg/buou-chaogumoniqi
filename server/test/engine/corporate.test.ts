import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/database.js';
import { seedStocks, STOCK_SEEDS } from '../../src/seed/stocks.js';
import { publishReport, reportDueCodes } from '../../src/engine/reports.js';
import { applyStTransitions, declareDividends, applyExDividend, scheduleIpoIfNeeded, processDelistings } from '../../src/engine/corporate.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Rng } from '../../src/core/rng.js';

function setup() { const db = openDb(':memory:'); seedStocks(db, 1); return db; }
describe('corporate lifecycle', () => {
  it('60 日周期内每股恰好披露一次', () => {
    const db = setup(); const seen = new Map<string, number>();
    for (let d = 1; d <= 60; d++) for (const c of reportDueCodes(db, d, DEFAULTS))
      seen.set(c, (seen.get(c) ?? 0) + 1);
    expect(seen.size).toBe(STOCK_SEEDS.length);
    for (const v of seen.values()) expect(v).toBe(1);
  });
  it('连亏2期→ST，再亏1期→delisting，20日后摘牌', () => {
    const db = setup();
    db.prepare(`UPDATE stock_state SET eps_e6=-5_000_000 WHERE code='600619'`).run();
    db.prepare(`UPDATE stock_state SET loss_streak=1 WHERE code='600619'`).run(); // 已亏1期
    publishReport(db, '600619', 61, Rng.fromSeed(1, 61, 'reports'), DEFAULTS);   // 第2期亏
    expect(applyStTransitions(db, '600619', 61, DEFAULTS)).toBe('st');
    publishReport(db, '600619', 121, Rng.fromSeed(1, 121, 'reports'), DEFAULTS); // ST后再亏
    expect(applyStTransitions(db, '600619', 121, DEFAULTS)).toBe('delisting');
    const dd = (db.prepare(`SELECT delist_at_day d FROM stocks WHERE code='600619'`).get() as any).d;
    expect(dd).toBe(141);
    expect(processDelistings(db, 141, DEFAULTS)).toContain('600619');
    expect((db.prepare(`SELECT status s FROM stocks WHERE code='600619'`).get() as any).s).toBe('delisted');
  });
  it('分红除权：昨收与现价同步下调并重算涨跌停', () => {
    const db = setup();
    db.prepare(`INSERT INTO dividends(code,announced_day,ex_day,per_share_e6) VALUES('600619',1,4,2_000_000)`).run(); // 每股2元
    const before = db.prepare(`SELECT prev_close p, price q FROM stock_state WHERE code='600619'`).get() as any;
    applyExDividend(db, 4, DEFAULTS);
    const after = db.prepare(`SELECT prev_close p, limit_up u, price q FROM stock_state WHERE code='600619'`).get() as any;
    expect(after.p).toBe(before.p - 200);
    expect(after.q).toBe(before.p - 200); // R9②：现价同步除权（seed 时 price=prev_close），分红不是白送钱
    expect(after.u).toBe(Math.round((before.p - 200) * 1.1));
  });
  it('摘牌后触发补位 IPO，池子回到 poolTarget', () => {
    const db = setup();
    db.prepare(`UPDATE stocks SET status='delisted' WHERE code='600619'`).run();
    scheduleIpoIfNeeded(db, 150, Rng.fromSeed(2, 150, 'ipo'), DEFAULTS); // 记入 pending（实现里用 config 表存 pending json）
    let listed = 0;
    for (let d = 151; d <= 160; d++) { scheduleIpoIfNeeded(db, d, Rng.fromSeed(2, d, 'ipo'), DEFAULTS);
      listed = (db.prepare(`SELECT COUNT(*) c FROM stocks WHERE status!='delisted'`).get() as any).c; if (listed === DEFAULTS.poolTarget) break; }
    expect(listed).toBe(DEFAULTS.poolTarget);
    const neu = db.prepare(`SELECT code,sector FROM stocks WHERE listed_day>1`).get() as any;
    expect(neu.sector).toBe('白酒饮料');
  });
});
