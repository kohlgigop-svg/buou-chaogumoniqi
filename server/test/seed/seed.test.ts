import { describe, it, expect } from 'vitest';
import { STOCK_SEEDS, SPARE_NAMES, seedStocks, insertSeed } from '../../src/seed/stocks.js';
import { ensureStockSeeds } from '../../src/seed/topup.js';
import { indexLevel, mcapOf } from '../../src/engine/candles.js';
import { EVENT_TYPES } from '../../src/seed/events.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { openDb, type DB } from '../../src/db/database.js';

describe('seeds', () => {
  it('110 只、创业板 14 只、板块 20 个、代码唯一', () => {
    expect(STOCK_SEEDS).toHaveLength(110);
    expect(STOCK_SEEDS.filter(s => s.board === 'CY')).toHaveLength(14);
    expect(new Set(STOCK_SEEDS.map(s => s.sector)).size).toBe(20);
    expect(new Set(STOCK_SEEDS.map(s => s.code)).size).toBe(110);
    for (const s of STOCK_SEEDS) {
      if (s.board === 'SH') expect(s.code[0]).toBe('6');
      if (s.board === 'SZ') expect(s.code[0]).toBe('0');
      if (s.board === 'CY') expect(s.code.startsWith('30')).toBe(true);
    }
  });

  it('每板块至少 5 只（扩容后分布均匀）', () => {
    const bySector = new Map<string, number>();
    for (const s of STOCK_SEEDS) bySector.set(s.sector, (bySector.get(s.sector) ?? 0) + 1);
    expect(bySector.size).toBe(20);
    for (const [sec, n] of bySector) expect(n, sec).toBeGreaterThanOrEqual(5);
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

  it('⚠️ 备用名不得与种子名重名（stocks.name 有 UNIQUE，重名会让 IPO 建股直接抛错）', () => {
    const seedNames = new Set(STOCK_SEEDS.map(s => s.name));
    for (const [sec, names] of Object.entries(SPARE_NAMES)) {
      for (const n of names) expect(seedNames.has(n), `${sec} 的备用名「${n}」与种子重名`).toBe(false);
    }
    const all = Object.values(SPARE_NAMES).flat();
    expect(new Set(all).size, '备用名自身也不得重复').toBe(all.length);
  });

  it('种子名本身唯一', () => {
    const names = STOCK_SEEDS.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('⚠️ poolTarget 必须等于种子表规模', () => {
    // 小于 → scheduleIpoIfNeeded 的 deficit 恒为负，IPO 补位永久停摆；
    // 大于 → 一启动就凭空排一堆 IPO 把池子填满。两者都是静默故障。
    expect(DEFAULTS.poolTarget).toBe(STOCK_SEEDS.length);
    expect(DEFAULTS.poolMax).toBeGreaterThan(DEFAULTS.poolTarget);
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
    expect((db.prepare('SELECT COUNT(*) c FROM stocks').get() as { c: number }).c).toBe(110);
    const st = db.prepare(`SELECT * FROM stock_state WHERE code='600619'`).get() as
      { price: number; limit_up: number; eps_e6: number };
    expect(st.price).toBe(158_000);
    expect(st.limit_up).toBe(173_800); // 1580×1.1=1738.00 元
    expect(st.eps_e6).toBe(Math.round(1580 / 18 * 1e6));
  });
});

/** 只插入前 n 只，模拟「线上老库只有一部分种子」的状态。 */
function legacyDb(n: number): DB {
  const db = openDb(':memory:');
  db.transaction(() => { for (const s of STOCK_SEEDS.slice(0, n)) insertSeed(db, s, 1); })();
  return db;
}

describe('ensureStockSeeds —— 老库扩容', () => {
  it('把缺的种子补齐，且第二次调用是 no-op（幂等）', () => {
    const db = legacyDb(48);
    expect((db.prepare('SELECT COUNT(*) c FROM stocks').get() as { c: number }).c).toBe(48);

    const r = ensureStockSeeds(db, 5);
    expect(r.added).toBe(62);
    expect(r.codes).toHaveLength(62);
    expect((db.prepare('SELECT COUNT(*) c FROM stocks').get() as { c: number }).c).toBe(110);
    // stock_state 也要跟着建（否则行情接口 JOIN 不到，页面直接少一半股票）
    expect((db.prepare('SELECT COUNT(*) c FROM stock_state').get() as { c: number }).c).toBe(110);

    expect(ensureStockSeeds(db, 5)).toEqual({ added: 0, codes: [] });
    db.close();
  });

  it('已满的库调用不报错也不重复插', () => {
    const db = openDb(':memory:');
    seedStocks(db, 1);
    expect(ensureStockSeeds(db, 9).added).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM stocks').get() as { c: number }).c).toBe(110);
    db.close();
  });

  it('⚠️⚠️ 扩容不得改变指数点位（除数必须同步修正）', () => {
    const db = legacyDb(48);
    // 先建除数：此刻只有 48 只，indexLevel 会把除数设成「市值/3000」，点位恰为 3000
    const lvl0 = indexLevel(db, 'COMP');
    const sec0 = indexLevel(db, 'S:白酒饮料');
    expect(lvl0).toBeCloseTo(3000, 6);
    expect(sec0).toBeCloseTo(1000, 6);

    ensureStockSeeds(db, 5);

    // 不做除数修正的话这里会变成约 3 倍（市值凭空多出 62 只股）
    expect(indexLevel(db, 'COMP')).toBeCloseTo(lvl0, 6);
    expect(indexLevel(db, 'S:白酒饮料')).toBeCloseTo(sec0, 6);
    db.close();
  });

  it('扩容后的新股可直接交易：listed_day=1（不会误判成 IPO 首日 ±44%）', () => {
    const db = legacyDb(48);
    ensureStockSeeds(db, 5);
    const s = db.prepare("SELECT listed_day ld, status FROM stocks WHERE code='600030'").get() as
      { ld: number; status: string };
    expect(s.ld).toBe(1);
    expect(s.status).toBe('normal');
    // 涨跌停是常规 ±10%（不是 IPO 档 44%/36%）
    const st = db.prepare("SELECT price, limit_up u, limit_down d FROM stock_state WHERE code='600030'")
      .get() as { price: number; u: number; d: number };
    expect(st.u).toBe(Math.round(st.price * 1.1));
    expect(st.d).toBe(Math.round(st.price * 0.9));
    db.close();
  });

  it('扩容会让 COMP 市值显著变大 —— 这正是必须修除数的原因', () => {
    const db = legacyDb(48);
    const before = mcapOf(db, 'COMP');
    ensureStockSeeds(db, 5);
    const after = mcapOf(db, 'COMP');
    // 只证明「市值确实变了」，至于点位连续性由上一条测试保证
    expect(after).toBeGreaterThan(before * 1.5);
    db.close();
  });
});
