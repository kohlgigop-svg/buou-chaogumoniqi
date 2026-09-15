import { describe, it, expect } from 'vitest';
import type { MarginState } from '../src/api.js';
import {
  ratioPct, statusLabel, statusTone, alertText, kindLabel, closeActionLabel,
  parseQty, maxQtyFromCents, capacityNote,
} from '../src/pages/marginLogic.js';

function state(over: Partial<MarginState> = {}): MarginState {
  return {
    open: true, minCredit: 650, eligible: true, credit: 700,
    debt: 0, interest: 0, owedTotal: 0, shortValue: 0, liability: 0,
    cash: 0, positionsValue: 0, collateral: 0,
    ratio: null, ratioE6: null, status: 'ok', canOpen: true,
    warnSinceDay: null, liquidatedCount: 0,
    creditCap: 0, debtRoom: 0, maxFinanceCents: 0, maxShortCents: 0,
    positions: [],
    ...over,
  };
}

describe('ratioPct：维持担保比例渲染', () => {
  it('⚠️ null（无负债）必须渲染成「—」，不是 0%、不是 Infinity%', () => {
    // 渲染成 0.00% 会被读成「马上爆仓」；Infinity 在 JSON 里会变成 null，
    // 两个语义完全不同的状态会撞在一起。
    expect(ratioPct(null)).toBe('—');
  });

  it('e6 → 百分比，保留两位', () => {
    expect(ratioPct(1_500_000)).toBe('150.00%');
    expect(ratioPct(2_000_000)).toBe('200.00%');
    expect(ratioPct(1_299_999)).toBe('130.00%');
    expect(ratioPct(0)).toBe('0.00%');
  });
});

describe('statusLabel / statusTone', () => {
  it('三态文案', () => {
    expect(statusLabel('ok')).toBe('正常');
    expect(statusLabel('warn')).toBe('低于警戒线');
    expect(statusLabel('call')).toBe('追保中');
  });

  it('⚠️ 色调是反向的：比例越高越安全（绿 = down）', () => {
    // 本项目涨跌色沿用 A 股习惯：up = 红、down = 绿。比例高是好事 ⇒ 绿。
    expect(statusTone('ok')).toBe('down');
    expect(statusTone('call')).toBe('up');
    expect(statusTone('warn')).toBe('flat');
  });
});

describe('alertText：只在需要时给横幅', () => {
  it('正常且无追保历史 → null（整段不渲染，不要留空横幅）', () => {
    expect(alertText(state(), 1_500_000, 1_300_000)).toBeNull();
  });

  it('跌破平仓线 → 提示 T+1 强平', () => {
    const t = alertText(state({ status: 'call', ratioE6: 1_200_000 }), 1_500_000, 1_300_000);
    expect(t).toContain('130%');
    expect(t).toContain('强制平仓');
  });

  it('低于警戒线 → 提示不能开新仓', () => {
    const t = alertText(state({ status: 'warn', ratioE6: 1_400_000 }), 1_500_000, 1_300_000);
    expect(t).toContain('150%');
    expect(t).toContain('不能开新仓');
  });

  it('已回补但仍有追保记录 → 说明历史，不吓人', () => {
    const t = alertText(state({ warnSinceDay: 3 }), 1_500_000, 1_300_000);
    expect(t).toContain('第 3 日');
  });

  it('未开通且信誉分不够 → 指向门槛', () => {
    const t = alertText(state({ open: false, eligible: false, credit: 600 }), 1_500_000, 1_300_000);
    expect(t).toContain('650');
  });
});

describe('parseQty：股数输入', () => {
  it('整数且为 100 的整数倍才通过', () => {
    expect(parseQty('100')).toEqual({ qty: 100 });
    expect(parseQty('1,000')).toEqual({ qty: 1000 });
    expect(parseQty(' 500 ')).toEqual({ qty: 500 });
  });

  it('空/非整数/非整手/非正 → 中文错误', () => {
    expect(parseQty('')).toHaveProperty('error');
    expect(parseQty('1.5')).toHaveProperty('error');
    expect(parseQty('abc')).toHaveProperty('error');
    expect(parseQty('0')).toHaveProperty('error');
    expect(parseQty('-100')).toHaveProperty('error');
    expect(parseQty('150')).toEqual({ error: '买入须为 100 股的整数倍' });
  });
});

describe('maxQtyFromCents：金额上限 → 整手股数', () => {
  it('向下取整到整手', () => {
    // 100 万分 ÷ 1000 分/股 = 1000 股
    expect(maxQtyFromCents(1_000_000, 1000)).toBe(1000);
    // 99.99 万分 ÷ 1000 = 999.9 → 900 股
    expect(maxQtyFromCents(999_900, 1000)).toBe(900);
  });

  it('非法输入一律 0（不要把 NaN 传到输入框里）', () => {
    expect(maxQtyFromCents(0, 1000)).toBe(0);
    expect(maxQtyFromCents(1_000_000, 0)).toBe(0);
    expect(maxQtyFromCents(Number.NaN, 1000)).toBe(0);
    expect(maxQtyFromCents(1_000_000, Number.NaN)).toBe(0);
  });

  it('给了现金时再夹一次（佣金有 500 分保底，纯除法会多算一手）', () => {
    // 现金刚好够买 100 股（10 万分）但不够付佣金 → 夹到 0
    expect(maxQtyFromCents(1_000_000, 1000, 100_000)).toBe(0);
    expect(maxQtyFromCents(1_000_000, 1000, 101_000)).toBe(100);
  });
});

describe('kindLabel / closeActionLabel', () => {
  it('方向与了结动作一一对应', () => {
    expect(kindLabel('long')).toBe('融资买入');
    expect(kindLabel('short')).toBe('融券卖出');
    expect(closeActionLabel('long')).toBe('卖券还款');
    expect(closeActionLabel('short')).toBe('买券还券');
  });
});

describe('capacityNote：解释「为什么开不了仓」', () => {
  it('未开通 → null（由开通引导卡负责，不在这里重复说）', () => {
    expect(capacityNote(state({ open: false }))).toBeNull();
  });

  it('比例不足 → 说比例', () => {
    expect(capacityNote(state({ status: 'warn', maxFinanceCents: 100 }))).toContain('维持担保比例');
  });

  it('额度用尽 → 指向「先还款」；现金不足 → 指向「先补充资金」', () => {
    expect(capacityNote(state({ debtRoom: 0 }))).toContain('还款');
    expect(capacityNote(state({ debtRoom: 1_000_000 }))).toContain('现金');
  });

  it('有额度 → null', () => {
    expect(capacityNote(state({ maxFinanceCents: 5_000_000 }))).toBeNull();
  });
});
