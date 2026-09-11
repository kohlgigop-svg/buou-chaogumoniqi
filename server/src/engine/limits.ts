import { roundHalfUpDiv, type Cents } from '../core/money.js';
import type { Config } from '../config/defaults.js';

// 某股在 forDay 适用的涨跌停档位：上市首日 IPO1 > ST/退市整理 > 创业板 > 主板
export function limitKindOf(status: string, board: 'SH' | 'SZ' | 'CY', listedDay: number, forDay: number): 'SH' | 'SZ' | 'CY' | 'ST' | 'IPO1' {
  if (forDay === listedDay) return 'IPO1';
  if (status === 'st' || status === 'delisting') return 'ST';
  if (board === 'CY') return 'CY';
  return board;
}

export function limitPrices(prevClose: Cents, kind: 'SH' | 'SZ' | 'CY' | 'ST' | 'IPO1', cfg: Config): { up: Cents; down: Cents } {
  const pct = kind === 'IPO1' ? null : kind === 'ST' ? cfg.limits.ST : cfg.limits[kind];
  const upPct = kind === 'IPO1' ? cfg.limits.ipoUp : pct!;
  const dnPct = kind === 'IPO1' ? cfg.limits.ipoDown : pct!;
  return {
    up: roundHalfUpDiv(prevClose * Math.round((1 + upPct) * 1000), 1000),
    down: roundHalfUpDiv(prevClose * Math.round((1 - dnPct) * 1000), 1000),
  };
}
