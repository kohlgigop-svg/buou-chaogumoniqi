// engine/regime.ts —— 大盘 HMM 三态 + 板块 AR(1)
import type { Rng } from '../core/rng.js';
import type { Config } from '../config/defaults.js';

export type RegimeState = { regime: 0|1|2; sectorS: Record<string, number> }; // sectorS: 板块 AR(1) 当前值(日单位)

// 日初调用。RNG 消耗固定：先 1 次 next() 做转移轮盘，再按 sectors 数组顺序每板块 1 次 normal()。
export function transitionRegime(prev: RegimeState, sectors: string[], rng: Rng, cfg: Config): RegimeState {
  const row = cfg.regime.trans[prev.regime]!;
  const u = rng.next();
  let regime: 0|1|2 = 2;
  let acc = 0;
  for (let i = 0; i < 3; i++) {
    acc += row[i]!;
    if (u < acc) { regime = i as 0|1|2; break; }
  }
  const { phi, sigmaDay } = cfg.sectorAR;
  const innovScale = sigmaDay * Math.sqrt(1 - phi * phi); // 保持平稳方差
  const sectorS: Record<string, number> = {};
  for (const sec of sectors) {
    sectorS[sec] = phi * (prev.sectorS[sec] ?? 0) + rng.normal() * innovScale;
  }
  return { regime, sectorS };
}

// r_mkt per tick。RNG 消耗固定：1 次 normal()。
export function marketTickReturn(state: RegimeState, rng: Rng, cfg: Config): number {
  const r = state.regime;
  return cfg.regime.muDay[r] / 1100 + rng.normal() * cfg.regime.sigmaDay[r] / Math.sqrt(1100);
}

// 板块日值摊到 tick + 小噪声。RNG 消耗固定：1 次 normal()。缺失板块键按 0 处理。
export function sectorTickReturn(state: RegimeState, sector: string, rng: Rng, cfg: Config): number {
  return (state.sectorS[sector] ?? 0) / 1100 + rng.normal() * (cfg.sectorAR.sigmaDay * 0.5) / Math.sqrt(1100);
}
