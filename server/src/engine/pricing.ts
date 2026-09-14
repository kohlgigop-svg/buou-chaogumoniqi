// engine/pricing.ts —— 连续竞价每 tick 定价（涨跌停钉板）+ 指数即时值落 tick
// RNG 消耗顺序固定（确定性回放依赖）：applyEventImpacts(0 抽) → rMkt(1 normal) →
// 板块（排序去重，各 1 normal）→ 按 code 序逐股：t4(4 uniform) → normal(2 uniform)，封板与否不改变消耗。
import type { DB } from '../db/database.js';
import type { Rng } from '../core/rng.js';
import type { Config } from '../config/defaults.js';
import type { Cents } from '../core/money.js';
import type { FlowProvider } from './types.js';
import { marketTickReturn, sectorTickReturn, type RegimeState } from './regime.js';
import { anchorPullPerTick } from './anchor.js';
import { applyEventImpacts, type DriftItem } from './events.js';
import { indexLevel } from './candles.js';
import { STOCK_SEEDS } from '../seed/stocks.js';

const SEED_PRICE0 = new Map(STOCK_SEEDS.map(s => [s.code, s.price0]));

interface UniverseRow {
  code: string; board: 'SH' | 'SZ' | 'CY'; sector: string; vt: 'L' | 'M' | 'H'; beta: number;
  ipo: number | null; price: number; pc: number; open: number | null; high: number | null;
  low: number | null; up: number; dn: number; eps_e6: number; pe: number; equity_e6: number; adv: number;
}

export function priceTick(db: DB, deps: { day: number; tickInDay: number; regime: RegimeState;
  rng: Rng; drift: Map<string, DriftItem[]>; flow: FlowProvider; cfg: Config }): Map<string, { price: Cents; vol: number }> {
  const { day, tickInDay, regime, rng, drift, flow, cfg } = deps;
  const out = new Map<string, { price: Cents; vol: number }>();
  db.transaction(() => {
    // (0) 事件注入/摊释——最先调用（本 tick 到达的新闻必须入队），不消耗 RNG，位置安全
    const eventMap = applyEventImpacts(db, { day, tickInDay }, drift, cfg);
    // 宇宙：未退市且已上市，固定按 code 排序
    const rows = db.prepare(`SELECT s.code, s.board, s.sector, s.vol_tier vt, s.beta, s.ipo_price ipo,
        t.price, t.prev_close pc, t.open, t.high, t.low, t.limit_up up, t.limit_down dn,
        t.eps_e6, t.pe, t.equity_e6, t.adv
      FROM stocks s JOIN stock_state t ON t.code = s.code
      WHERE s.status != 'delisted' AND s.listed_day <= ? ORDER BY s.code`).all(day) as UniverseRow[];
    // (1) 大盘收益
    const rMkt = marketTickReturn(regime, rng, cfg);
    // (2) 板块收益：排序去重后依序各抽 1 次
    const sectors = [...new Set(rows.map(r => r.sector))].sort();
    const rSec = new Map<string, number>();
    for (const sec of sectors) rSec.set(sec, sectorTickReturn(regime, sec, rng, cfg));
    // (3) 逐股：先抽满 RNG（t4 → normal）再分支
    const upd = db.prepare(`UPDATE stock_state SET price = ?, open = ?, high = ?, low = ?,
      volume = volume + ?, turnover = turnover + ? WHERE code = ?`);
    const insT = db.prepare('INSERT INTO ticks(code,day,tick,price,volume) VALUES (?,?,?,?,?)');
    for (const r of rows) {
      const eps = rng.studentT4();
      const volNoise = rng.normal();
      const sigmaTick = cfg.volSigmaDay[r.vt] * (r.board === 'CY' ? cfg.volSigmaDay.cyMult : 1)
        * cfg.regime.volMult[regime.regime] / Math.sqrt(1100);
      // 价值锚 price0：IPO 股用发行价；种子股查 STOCK_SEEDS；兜底 prev_close
      const price0 = r.ipo ?? SEED_PRICE0.get(r.code) ?? r.pc;
      const pull = anchorPullPerTick(r.price, r.eps_e6, r.pe, r.equity_e6, price0, cfg);
      // 玩家净流入冲击：λ 需补偿「玩家数量远少于现实市场」这一稀疏性（见 defaults.ts）。
      // 上限从配置读（playerImpactCap），原硬编码 3% 会把中等市值股的位移一起压平。
      const cap = cfg.playerImpactCap;
      const rPlayer = Math.max(-cap, Math.min(cap,
        cfg.playerImpactLambda * (flow.netFlow(r.code) / Math.max(1, r.adv))));
      const ret = r.beta * rMkt + 0.65 * (rSec.get(r.sector) ?? 0) + eps * sigmaTick
        + (eventMap.get(r.code) ?? 0) + pull + rPlayer;
      const newPrice = Math.min(r.up, Math.max(r.dn, Math.max(1, Math.round(r.price * Math.exp(ret)))));
      let vol = Math.round((r.adv / 1100) * Math.exp(volNoise * 0.8));
      if (newPrice === r.up || newPrice === r.dn) vol = Math.round(vol * 0.3); // 封板缩量
      const open = r.open ?? newPrice; // 首个连续竞价 tick 补 open
      const high = Math.max(r.high ?? 0, newPrice);
      const low = (r.low === null || r.low === 0) ? newPrice : Math.min(r.low, newPrice);
      upd.run(newPrice, open, high, low, vol, vol * newPrice, r.code);
      insT.run(r.code, day, tickInDay, newPrice, vol);
      out.set(r.code, { price: newPrice, vol });
    }
    // 指数即时值：COMP 落 tick（价 = 指数点 ×100），不消耗 RNG
    insT.run('IDX:COMP', day, tickInDay, Math.round(indexLevel(db, 'COMP') * 100), 0);
  })();
  return out;
}
