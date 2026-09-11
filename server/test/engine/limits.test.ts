import { describe, it, expect } from 'vitest';
import { limitPrices } from '../../src/engine/limits.js';
import { DEFAULTS } from '../../src/config/defaults.js';

describe('limits（规格 §5 取整示例）', () => {
  it('主板 5.67 → 6.24 / 5.10', () => {
    expect(limitPrices(567, 'SH', DEFAULTS)).toEqual({ up: 624, down: 510 });
  });
  it('ST 5.67 → 5.95 / 5.39', () => {
    expect(limitPrices(567, 'ST', DEFAULTS)).toEqual({ up: 595, down: 539 });
  });
  it('创业板 10.00 → 12.00 / 8.00', () => {
    expect(limitPrices(1000, 'CY', DEFAULTS)).toEqual({ up: 1200, down: 800 });
  });
  it('IPO 首日 10.00 → 14.40 / 6.40', () => {
    expect(limitPrices(1000, 'IPO1', DEFAULTS)).toEqual({ up: 1440, down: 640 });
  });
});
