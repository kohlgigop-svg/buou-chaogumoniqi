import { describe, it, expect } from 'vitest';
import {
  roundHalfUpDiv, commission, stampTax, transferFee,
  buyCost, sellProceeds, buyFreeze, maxBuyQty,
} from '../src/lib/fees.js';

// 本文件的向量全部与服务端 core/money.ts 逐分比对。
// 服务端实现：roundHalfUpDiv(n,d) = floor(n/d) 后余数 r*2>=d 则进位；
// 契约要求 n >= 0 且 d > 0（负数抛错），前端同样约束，避免行为分叉。

describe('roundHalfUpDiv', () => {
  it('整除直接返回', () => {
    expect(roundHalfUpDiv(100, 10)).toBe(10);
    expect(roundHalfUpDiv(0, 7)).toBe(0);
  });

  it('余数过半进位、不足舍去（四舍五入而非银行家舍入）', () => {
    // 5/2 = 2.5 → 进位 3
    expect(roundHalfUpDiv(5, 2)).toBe(3);
    // 4/2 = 2 整除
    expect(roundHalfUpDiv(4, 2)).toBe(2);
    // 7/3 = 2.33 → 2
    expect(roundHalfUpDiv(7, 3)).toBe(2);
    // 8/3 = 2.66 → 3
    expect(roundHalfUpDiv(8, 3)).toBe(3);
  });

  it('恰好 .5 时进位（r*2 === d 的边界）', () => {
    expect(roundHalfUpDiv(1, 2)).toBe(1);      // 0.5 → 1
    expect(roundHalfUpDiv(3, 2)).toBe(2);      // 1.5 → 2
    expect(roundHalfUpDiv(25, 2)).toBe(13);    // 12.5 → 13
  });

  it('负数被拒（服务端同样抛错，不能静默取绝对值）', () => {
    expect(() => roundHalfUpDiv(-1, 2)).toThrow();
  });

  it('除数 <= 0 被拒', () => {
    expect(() => roundHalfUpDiv(1, 0)).toThrow();
    expect(() => roundHalfUpDiv(1, -2)).toThrow();
  });

  it('非安全整数被拒', () => {
    expect(() => roundHalfUpDiv(1.5, 2)).toThrow();
  });
});

describe('commission（万2.5，最低 500 分）', () => {
  it('服务端实证向量：15,800,000 → 3950', () => {
    expect(commission(15_800_000)).toBe(3950);
  });

  it('服务端实证向量：52,000 → 500（最低佣金生效）', () => {
    // 万2.5 算出 13 分，被 MIN_COMMISSION=500 抬起
    expect(commission(52_000)).toBe(500);
  });

  it('最低佣金边界：刚好超过 500 分时按实际算', () => {
    // 找临界点：amount*25/100000 >= 500 → amount >= 2,000,000
    expect(commission(2_000_000)).toBe(500);   // 恰好 500
    expect(commission(2_000_001)).toBe(500);   // 500.00025 → 舍入后 500
    expect(commission(2_002_000)).toBe(501);   // 500.5 → 进位 501
  });

  it('零金额也返回最低佣金（服务端同样如此，不特判 0）', () => {
    expect(commission(0)).toBe(500);
  });

  it('负数抛错', () => {
    expect(() => commission(-1)).toThrow();
  });
});

describe('stampTax（0.05%，仅卖出）', () => {
  it('服务端实证向量：15,800,000 → 7900', () => {
    expect(stampTax(15_800_000)).toBe(7900);
  });

  it('服务端实证向量：52,000 → 26', () => {
    expect(stampTax(52_000)).toBe(26);
  });

  it('零金额为零（与最低佣金不同，无下限）', () => {
    expect(stampTax(0)).toBe(0);
  });

  it('负数抛错', () => {
    expect(() => stampTax(-1)).toThrow();
  });
});

describe('transferFee（万0.1）', () => {
  it('服务端实证向量：15,800,000 → 158', () => {
    expect(transferFee(15_800_000)).toBe(158);
  });

  it('服务端实证向量：52,000 → 1', () => {
    expect(transferFee(52_000)).toBe(1);
  });

  it('极小金额舍入为 0', () => {
    expect(transferFee(4_999)).toBe(0);   // 0.04999 → 0
    expect(transferFee(5_000)).toBe(0);   // 0.05 → r*2=10000 vs d=100000 → 不舍入
    expect(transferFee(50_000)).toBe(1);  // 0.5 → 进位 1
  });

  it('负数抛错', () => {
    expect(() => transferFee(-1)).toThrow();
  });
});

describe('buyFreeze（买入冻结 = 名义 + 佣金 + 过户费；买入无印花税）', () => {
  it('与服务端一致：15,800,000 名义 → 冻结 15,800,000+3950+158', () => {
    expect(buyFreeze(15_800_000)).toBe(15_800_000 + 3950 + 158);
  });

  it('含最低佣金的情形', () => {
    expect(buyFreeze(52_000)).toBe(52_000 + 500 + 1);
  });

  it('零名义只冻结两份最低费', () => {
    expect(buyFreeze(0)).toBe(0 + 500 + 0);
  });
});

describe('buyCost / sellProceeds（净额口径）', () => {
  it('买入总成本 = 名义 + 佣金 + 过户费（无印花税）', () => {
    expect(buyCost(15_800_000)).toBe(15_800_000 + 3950 + 158);
  });

  it('卖出净收入 = 名义 − 佣金 − 印花税 − 过户费', () => {
    expect(sellProceeds(15_800_000)).toBe(15_800_000 - 3950 - 7900 - 158);
  });

  it('卖出净额不得为负（极小金额时费用可能超过名义）', () => {
    // 100 分名义：佣金 500 + 过户 0 + 印花 0 = 500 > 100
    expect(sellProceeds(100)).toBe(0);
    expect(sellProceeds(0)).toBe(0);
  });
});

describe('maxBuyQty（可买量 = floor(可用资金 / 每股含费成本 / 100) * 100）', () => {
  it('按每股含费成本取整到 100 股整数倍', () => {
    // 现价 1200 分/股，可用 1,200,000 分
    // 每股成本 ≈ 1200 + 佣金摊薄 + 过户；直接用整笔试算更稳
    const q = maxBuyQty(1_200_000, 1200);
    expect(q % 100).toBe(0);
    expect(q).toBeGreaterThan(0);
  });

  it('资金不足一手时返回 0', () => {
    // 现价 180000 分/股（贵州茅台），一手要 18,000,000+；只有 1,000,000
    expect(maxBuyQty(1_000_000, 180_000)).toBe(0);
  });

  it('资金刚好够一手（含费）时返回 100', () => {
    // 现价 1000 分 → 名义 100,000；佣金 500（最低）、过户 1 → 总 100,501
    expect(buyCost(1000 * 100)).toBe(100_000 + 500 + 1);
    expect(maxBuyQty(100_501, 1000)).toBe(100);
  });

  it('差 1 分买不起一手', () => {
    expect(maxBuyQty(100_500, 1000)).toBe(0);
  });

  it('资金为 0 或负数返回 0', () => {
    expect(maxBuyQty(0, 1000)).toBe(0);
    expect(maxBuyQty(-5, 1000)).toBe(0);
  });

  it('价格 <= 0 返回 0（不除零）', () => {
    expect(maxBuyQty(1_000_000, 0)).toBe(0);
    expect(maxBuyQty(1_000_000, -100)).toBe(0);
  });

  it('结果必须真的买得起（回代验证不越界）', () => {
    const cash = 1_000_000, price = 3333;
    const q = maxBuyQty(cash, price);
    expect(buyCost(price * q)).toBeLessThanOrEqual(cash);
    // 再多买一手就买不起了（紧致性）
    if (q > 0) expect(buyCost(price * (q + 100))).toBeGreaterThan(cash);
  });

  it('大额资金下仍然紧致（覆盖佣金非最低档）', () => {
    const cash = 500_000_000, price = 12_345;
    const q = maxBuyQty(cash, price);
    expect(buyCost(price * q)).toBeLessThanOrEqual(cash);
    expect(buyCost(price * (q + 100))).toBeGreaterThan(cash);
  });
});
