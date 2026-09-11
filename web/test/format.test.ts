import { describe, it, expect } from 'vitest';
import { fmtMoney, fmtPct, fmtBp, fmtSigned, fmtTime, fmtQty, fmtRate, fmtSignedMoney,
  fmtCompactMoney, fmtIndex } from '../src/format.js';

// 金额全链路为整数「分」。这些格式化函数是前端唯一的口径出口，
// 边界（0 / 负数 / 半分进位 / 千分位）必须与后端 roundHalfUpDiv 语义一致。
describe('fmtMoney', () => {
  it('正整数分 → ¥ 千分位 + 两位小数', () => {
    expect(fmtMoney(1234567)).toBe('¥12,345.67');
  });

  it('零 → ¥0.00', () => {
    expect(fmtMoney(0)).toBe('¥0.00');
  });

  it('小于一元 → 保留两位小数，不进千分位', () => {
    expect(fmtMoney(5)).toBe('¥0.05');
    expect(fmtMoney(100)).toBe('¥1.00');
  });

  it('负数 → 负号在货币符号之前', () => {
    expect(fmtMoney(-123)).toBe('-¥1.23');
    expect(fmtMoney(-1)).toBe('-¥0.01');
  });
});

describe('fmtSignedMoney', () => {
  it('正数带 + 号', () => {
    expect(fmtSignedMoney(1234567)).toBe('+¥12,345.67');
  });

  it('负数保持 - 号', () => {
    expect(fmtSignedMoney(-123)).toBe('-¥1.23');
  });

  it('零 → ¥0.00（不显示 ±）', () => {
    expect(fmtSignedMoney(0)).toBe('¥0.00');
  });
});

describe('fmtCompactMoney', () => {
  // 入参是「分」，注意换算：100 分 = 1 元。
  it('万级 → 万（123,450,000 分 = 1,234,500 元 = 123.5万）', () => {
    expect(fmtCompactMoney(123_450_000)).toBe('123.5万');
  });

  it('万位以下不进位（99,999,999 分 = 999,999.99 元 → 100.0万）', () => {
    expect(fmtCompactMoney(99_999_999)).toBe('100.0万');
  });

  it('亿级 → 亿（12,345,678,900 分 = 123,456,789 元 = 1.23亿）', () => {
    expect(fmtCompactMoney(12_345_678_900)).toBe('1.23亿');
  });

  it('负数保留负号', () => {
    expect(fmtCompactMoney(-12_345_678_900)).toBe('-1.23亿');
  });

  it('小额原样走 fmtMoney', () => {
    expect(fmtCompactMoney(12345)).toBe('¥123.45');
  });
});

describe('fmtPct', () => {
  it('小数比例 → 百分比带符号两位', () => {
    expect(fmtPct(0.0123)).toBe('+1.23%');
    expect(fmtPct(-0.0045)).toBe('-0.45%');
  });

  it('零 → 0.00%（无符号）', () => {
    expect(fmtPct(0)).toBe('0.00%');
  });

  it('超过 1 的比例正常显示', () => {
    expect(fmtPct(1.5)).toBe('+150.00%');
  });
});

describe('fmtBp', () => {
  it('基点转百分比，10000 为平盘', () => {
    expect(fmtBp(10123)).toBe('+1.23%');
    expect(fmtBp(9955)).toBe('-0.45%');
    expect(fmtBp(10000)).toBe('0.00%');
  });

  it('极端涨跌（涨跌停 ±10% → ±1000bp）', () => {
    expect(fmtBp(11000)).toBe('+10.00%');
    expect(fmtBp(9000)).toBe('-10.00%');
  });
});

describe('fmtSigned', () => {
  it('整数分带符号、无货币符号、带千分位', () => {
    expect(fmtSigned(1234567)).toBe('+12,345.67');
    expect(fmtSigned(-123)).toBe('-1.23');
    expect(fmtSigned(0)).toBe('0.00');
  });
});

describe('fmtQty', () => {
  it('千分位、无小数', () => {
    expect(fmtQty(1234567)).toBe('1,234,567');
    expect(fmtQty(100)).toBe('100');
    expect(fmtQty(0)).toBe('0');
  });
});

describe('fmtTime', () => {
  it('游戏分钟 → HH:MM（1 游戏日 = 1440 游戏分）', () => {
    expect(fmtTime(0)).toBe('00:00');
    expect(fmtTime(570)).toBe('09:30');
    expect(fmtTime(900)).toBe('15:00');
    expect(fmtTime(1439)).toBe('23:59');
  });

  it('跨日取模（负数与超出一日）', () => {
    expect(fmtTime(1440)).toBe('00:00');
    expect(fmtTime(1440 + 570)).toBe('09:30');
    expect(fmtTime(-1)).toBe('23:59');
  });
});

describe('fmtRate', () => {
  it('rateE6 为「日息 e6」：300 → 0.03%/日（非年化）', () => {
    expect(fmtRate(300)).toBe('0.030%/日');
    expect(fmtRate(600)).toBe('0.060%/日');
  });

  it('不足 0.01%/日 也保留三位有效小数', () => {
    expect(fmtRate(100)).toBe('0.010%/日');
  });
});

describe('fmtIndex', () => {
  it('输入已是「点」：不再除 100（这是最容易犯的错）', () => {
    // 服务端已做过 level/100，若这里再用 fmtMoney 会变成 ¥31.23
    expect(fmtIndex(3123.45)).toBe('3,123.45');
  });

  it('保留两位小数并千分位', () => {
    expect(fmtIndex(30000)).toBe('30,000.00');
    expect(fmtIndex(987.6)).toBe('987.60');
  });

  it('零与负数', () => {
    expect(fmtIndex(0)).toBe('0.00');
    expect(fmtIndex(-12.5)).toBe('-12.50');
  });

  it('小数进位到整数时正确（不出现 .100 这种）', () => {
    expect(fmtIndex(1234.999)).toBe('1,235.00');
  });

  it('不带 ¥ 符号（指数不是金额）', () => {
    expect(fmtIndex(3123.45)).not.toContain('¥');
  });
});
