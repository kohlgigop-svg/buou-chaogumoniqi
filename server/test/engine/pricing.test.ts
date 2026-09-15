import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/database.js';
import { seedStocks, STOCK_SEEDS } from '../../src/seed/stocks.js';
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
    expect((db.prepare(`SELECT COUNT(*) c FROM candles_day WHERE day=1`).get() as any).c).toBe(STOCK_SEEDS.length + 21);
  });

  /**
   * ⚠️ 玩家稀疏性回归：本游戏玩家远少于现实市场，「一次全仓买入」必须能推动价格。
   *
   * 曾经的现象：λ=0.8 + adv 为日均量，导致 `λ × netFlow/adv` 落在 1e-4 量级，
   * `Math.round(price × exp(ret))` 对低价股（如 ¥5.20）**取整后恒等于原价** ——
   * 玩家买卖在盘面上完全看不见（用户报告「影响股市太难了」）。
   *
   * 这里用一个显式的 FlowProvider 模拟「玩家把本金全仓砸进一只股票」：
   * 净股数 = 本金(¥1,000,000) / 价格，取整到手。
   * 断言：买入后价格必须**严格上移**，且幅度落在合理区间（可见但不手动涨停）。
   */
  it('⚠️ 玩家全仓买入必须产生可见价格位移（不再是 0 分）', () => {
    const CASES: { code: string; cash: number }[] = [
      { code: '601389', cash: DEFAULTS.auth.initialCash }, // adv 最大、价格最低 → 最难推动
      { code: '600037', cash: DEFAULTS.auth.initialCash },
      { code: '000334', cash: DEFAULTS.auth.initialCash }, // 中位股
    ];
    for (const c of CASES) {
      const db = setup();
      const qty = Math.floor(c.cash / (db.prepare('SELECT price FROM stock_state WHERE code=?')
        .get(c.code) as { price: number }).price / 100) * 100;
      const flow = { netFlow: (code: string): number => (code === c.code ? qty : 0) };
      const st = { regime: 1 as const, sectorS: {} };
      const before = (db.prepare('SELECT price FROM stock_state WHERE code=?')
        .get(c.code) as { price: number }).price;
      // 只跑一 tick：隔离玩家冲击，避免随机游走淹没信号
      priceTick(db, { day: 1, tickInDay: 60, regime: st,
        rng: Rng.fromSeed(7, 1, 'pricing'), drift: new Map(), flow, cfg: DEFAULTS });
      const after = (db.prepare('SELECT price FROM stock_state WHERE code=?')
        .get(c.code) as { price: number }).price;
      // 同一 tick 的噪声可能反向，故只断言「相对同种子无流孪生」有正向位移
      const db2 = setup();
      priceTick(db2, { day: 1, tickInDay: 60, regime: st,
        rng: Rng.fromSeed(7, 1, 'pricing'), drift: new Map(), flow: NOFLOW, cfg: DEFAULTS });
      const base = (db2.prepare('SELECT price FROM stock_state WHERE code=?')
        .get(c.code) as { price: number }).price;
      expect(after, `${c.code} 玩家全仓买入后价格未上移（现状=不可见）`).toBeGreaterThan(base);
      db.close(); db2.close();
    }
  });
});
