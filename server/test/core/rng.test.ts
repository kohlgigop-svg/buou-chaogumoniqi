import { describe, it, expect } from 'vitest';
import { Rng } from '../../src/core/rng.js';

describe('rng', () => {
  it('同参数完全同序列', () => {
    const a = Rng.fromSeed(42, 7, 'pricing'), b = Rng.fromSeed(42, 7, 'pricing');
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });
  it('不同流不同序列', () => {
    const a = Rng.fromSeed(42, 7, 'pricing'), b = Rng.fromSeed(42, 7, 'events');
    const same = Array.from({ length: 50 }, () => a.next() === b.next()).filter(Boolean).length;
    expect(same).toBeLessThan(3);
  });
  it('序列化恢复后续序列一致', () => {
    const a = Rng.fromSeed(1, 1, 's');
    for (let i = 0; i < 37; i++) a.next();
    const b = Rng.restore(a.serialize());
    for (let i = 0; i < 100; i++) expect(b.next()).toBe(a.next());
  });
  it('normal 大样本均值≈0 方差≈1', () => {
    const r = Rng.fromSeed(9, 1, 'n'); let s = 0, s2 = 0; const N = 20000;
    for (let i = 0; i < N; i++) { const x = r.normal(); s += x; s2 += x * x; }
    expect(Math.abs(s / N)).toBeLessThan(0.03);
    expect(Math.abs(s2 / N - 1)).toBeLessThan(0.05);
  });
  it('studentT4 比正态肥尾（|x|>3 频率更高）', () => {
    const r = Rng.fromSeed(9, 1, 't'); let fat = 0; const N = 20000;
    for (let i = 0; i < N; i++) if (Math.abs(r.studentT4()) > 3) fat++;
    expect(fat / N).toBeGreaterThan(0.005); // 正态≈0.0027，t4≈0.0114
  });
  it('poisson(2) 均值≈2', () => {
    const r = Rng.fromSeed(3, 1, 'p'); let s = 0; const N = 10000;
    for (let i = 0; i < N; i++) s += r.poisson(2);
    expect(Math.abs(s / N - 2)).toBeLessThan(0.1);
  });
});
