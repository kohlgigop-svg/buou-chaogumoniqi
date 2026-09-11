import { describe, it, expect } from 'vitest';
import { commission, stampTax, transferFee, dividendTax, roundHalfUpDiv, assertCents } from '../../src/core/money.js';

describe('money', () => {
  it('roundHalfUpDiv 四舍五入到分', () => {
    expect(roundHalfUpDiv(1035, 10)).toBe(104);  // 103.5 → 104
    expect(roundHalfUpDiv(1034, 10)).toBe(103);
    expect(roundHalfUpDiv(0, 10)).toBe(0);
  });
  it('佣金 万2.5 最低5元', () => {
    expect(commission(1_000_000)).toBe(500);      // 1万元成交 → 触底 5 元
    expect(commission(10_000_000)).toBe(2500);    // 10万元 → 25 元
    expect(commission(1_234_567)).toBe(500);      // 308.6 分 → 仍触底
    expect(commission(20_000_001)).toBe(5000);    // 5000.00025 → 5000
  });
  it('印花税 卖出 0.05%', () => {
    expect(stampTax(10_000_000)).toBe(5000);      // 10万 → 50 元
    expect(stampTax(999)).toBe(0);                // 0.4995 分 → 0
  });
  it('过户费 万0.1', () => { expect(transferFee(10_000_000)).toBe(100); });
  it('红利税 10%', () => { expect(dividendTax(12345)).toBe(1235); }); // 1234.5→1235
  it('assertCents 拒绝小数', () => { expect(() => assertCents(1.5)).toThrow(); });
  it('roundHalfUpDiv 拒绝非整数 n', () => { expect(() => roundHalfUpDiv(1.5, 10)).toThrow(); });
  it('roundHalfUpDiv 拒绝负数 n', () => { expect(() => roundHalfUpDiv(-10, 10)).toThrow(); });
  it('费用函数拒绝负金额', () => {
    expect(() => commission(-100)).toThrow(/negative amount/);
    expect(() => stampTax(-1)).toThrow(/negative amount/);
  });
  it('assertCents 保持符号中立（负整数分不抛）', () => { expect(() => assertCents(-500)).not.toThrow(); });
});
