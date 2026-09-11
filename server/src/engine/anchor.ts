// engine/anchor.ts —— EPS/PE 内在价值锚 + 净资产地板
import type { DB } from '../db/database.js';
import type { Rng } from '../core/rng.js';
import type { Config } from '../config/defaults.js';

// 日初：eps/pe 随机游走（写 stock_state）。
// RNG 消耗固定（每股 3 次，先抽后用）：n1=normal()（eps 步），u1=next()（景气冲击判定），n2=normal()（pe 步）。
export function evolveAnchorDaily(db: DB, code: string, rng: Rng, cfg: Config): void {
  const n1 = rng.normal();
  const u1 = rng.next();
  const n2 = rng.normal();
  const row = db.prepare('SELECT eps_e6, pe, equity_e6 FROM stock_state WHERE code = ?').get(code) as
    { eps_e6: number; pe: number; equity_e6: number } | undefined;
  if (!row) throw new Error(`stock_state missing for ${code}`);
  let eps_e6 = row.eps_e6;
  if (eps_e6 > 0) eps_e6 = Math.round(eps_e6 * Math.exp(n1 * cfg.anchor.epsSigma));
  else eps_e6 = Math.round(eps_e6 + Math.abs(row.equity_e6) * 0.01 * n1); // 亏损公司修复/恶化随机
  if (u1 < 0.05) eps_e6 = Math.round(eps_e6 * Math.exp(u1 < 0.025 ? 0.1 : -0.1)); // 景气冲击 ±0.1
  const pe = Math.min(90, Math.max(8, row.pe * Math.exp(n2 * cfg.anchor.peSigma)));
  db.prepare('UPDATE stock_state SET eps_e6 = ?, pe = ? WHERE code = ?').run(eps_e6, pe, code);
}

// V元 = eps>0 ? (eps_e6/1e6)*pe : max(0.3*price0元, equity_e6/1e6/8)；
// pull = kappaDaily*(ln V − ln price元)/1100，夹在 ±0.001/tick。
export function anchorPullPerTick(priceCents: number, eps_e6: number, pe: number, equity_e6: number, price0Cents: number, cfg: Config): number {
  const priceYuan = priceCents / 100;
  let V = eps_e6 > 0 ? (eps_e6 / 1e6) * pe : Math.max(0.3 * (price0Cents / 100), (equity_e6 / 1e6) / 8);
  if (V <= 0) V = 0.3 * (price0Cents / 100);
  const pull = cfg.anchor.kappaDaily * (Math.log(V) - Math.log(priceYuan)) / 1100;
  return Math.min(0.001, Math.max(-0.001, pull));
}
