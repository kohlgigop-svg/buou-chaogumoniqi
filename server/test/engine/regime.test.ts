import { describe, it, expect } from 'vitest';
import { transitionRegime, marketTickReturn, sectorTickReturn, type RegimeState } from '../../src/engine/regime.js';
import { anchorPullPerTick } from '../../src/engine/anchor.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Rng } from '../../src/core/rng.js';

const SECS = ['银行', '白酒饮料'];
describe('regime', () => {
  it('同种子转移确定', () => {
    const s0: RegimeState = { regime: 0, sectorS: { 银行: 0, 白酒饮料: 0 } };
    const a = transitionRegime(s0, SECS, Rng.fromSeed(5, 2, 'regime'), DEFAULTS);
    const b = transitionRegime(s0, SECS, Rng.fromSeed(5, 2, 'regime'), DEFAULTS);
    expect(a).toEqual(b);
  });
  it('长期驻留分布覆盖三态', () => {
    let s: RegimeState = { regime: 1, sectorS: {} }; const seen = new Set<number>();
    for (let d = 1; d <= 3000; d++) { s = transitionRegime(s, [], Rng.fromSeed(7, d, 'regime'), DEFAULTS); seen.add(s.regime); }
    expect(seen.size).toBe(3);
  });
  it('牛市日漂移为正（1100 tick 汇总，去噪取均值）', () => {
    const s: RegimeState = { regime: 0, sectorS: {} }; let sum = 0; const R = Rng.fromSeed(1, 1, 'm');
    for (let i = 0; i < 1100 * 200; i++) sum += marketTickReturn(s, R, DEFAULTS);
    expect(sum / 200).toBeGreaterThan(0.001); // ≈ +0.0035/日
  });
  it('板块 AR 有界', () => {
    const s: RegimeState = { regime: 1, sectorS: { 银行: 0 } }; const R = Rng.fromSeed(2, 1, 's');
    for (let i = 0; i < 5000; i++) expect(Math.abs(sectorTickReturn(s, '银行', R, DEFAULTS))).toBeLessThan(0.01);
  });
  it('价格高于锚 → 拉力为负；EPS≤0 用净资产地板', () => {
    expect(anchorPullPerTick(200_00, 5_000_000, 20, 40_000_000, 100_00, DEFAULTS)).toBeLessThan(0);
    const pull = anchorPullPerTick(100_00, -1_000_000, 20, 8_000_000, 100_00, DEFAULTS);
    expect(Number.isFinite(pull)).toBe(true);
  });
});
