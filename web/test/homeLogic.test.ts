import { describe, it, expect } from 'vitest';
import { creditTier, shiftProgress, fmtRemaining, pnlTone, pnlBreakdown } from '../src/pages/homeLogic.js';

// 首页的几个纯计算：信誉分档位取色、班次进度、剩余时间文案。
// 这些必须有测试 —— 进度条算错或除零会让首页直接崩。

describe('creditTier', () => {
  it('<500 → 红档（危险）', () => {
    expect(creditTier(0)).toBe('danger');
    expect(creditTier(499)).toBe('danger');
  });

  it('500–699 → 黄档（警示）', () => {
    expect(creditTier(500)).toBe('warning');
    expect(creditTier(699)).toBe('warning');
  });

  it('≥700 → 绿档（良好）', () => {
    expect(creditTier(700)).toBe('good');
    expect(creditTier(1000)).toBe('good');
  });

  it('边界值恰好落在分档起点', () => {
    // 这三个数是对外承诺的分档线，改动必须伴随测试更新
    expect(creditTier(499)).toBe('danger');
    expect(creditTier(500)).toBe('warning');
    expect(creditTier(700)).toBe('good');
  });
});

describe('shiftProgress', () => {
  it('进行中 → 按已过时间比例', () => {
    expect(shiftProgress(100, 200, 150)).toBe(50);
    expect(shiftProgress(0, 100, 25)).toBe(25);
  });

  it('未开始 → 0；已结束 → 100', () => {
    expect(shiftProgress(100, 200, 50)).toBe(0);
    expect(shiftProgress(100, 200, 250)).toBe(100);
  });

  it('零长度区间 → 不除零，返回 100（视为已完成）', () => {
    expect(shiftProgress(100, 100, 100)).toBe(100);
    expect(Number.isFinite(shiftProgress(100, 100, 100))).toBe(true);
  });

  it('结果始终夹在 [0,100]', () => {
    expect(shiftProgress(0, 10, -999)).toBe(0);
    expect(shiftProgress(0, 10, 999)).toBe(100);
  });
});

describe('fmtRemaining', () => {
  // gmin 是「游戏分钟」，1 游戏日 = 1440 游戏分。
  it('剩余 0 或负 → 已结束', () => {
    expect(fmtRemaining(0)).toBe('已结束');
    expect(fmtRemaining(-5)).toBe('已结束');
  });

  it('<60 游戏分 → 仅显示分钟', () => {
    expect(fmtRemaining(1)).toBe('剩余 1 分钟');
    expect(fmtRemaining(59)).toBe('剩余 59 分钟');
  });

  it('≥60 游戏分 → 小时+分钟', () => {
    expect(fmtRemaining(60)).toBe('剩余 1 小时');
    expect(fmtRemaining(90)).toBe('剩余 1 小时 30 分');
    expect(fmtRemaining(480)).toBe('剩余 8 小时');
  });

  it('≥1440 游戏分 → 天+小时', () => {
    expect(fmtRemaining(1440)).toBe('剩余 1 天');
    expect(fmtRemaining(1440 + 360)).toBe('剩余 1 天 6 小时');
    expect(fmtRemaining(2880)).toBe('剩余 2 天');
  });
});

describe('pnlTone', () => {
  it('涨红跌绿平灰（A 股惯例）', () => {
    expect(pnlTone(1)).toBe('up');
    expect(pnlTone(-1)).toBe('down');
    expect(pnlTone(0)).toBe('flat');
  });

  it('零与极小值都算平', () => {
    expect(pnlTone(0)).toBe('flat');
    expect(pnlTone(-0)).toBe('flat');
  });
});

describe('pnlBreakdown', () => {
  // 用真实的 fmtSignedMoney 语义注入，避免测试里再造一套格式化。
  const fmt = (c: number): string => {
    if (c === 0) return '¥0.00';
    const abs = Math.abs(c) / 100;
    const s = abs.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${c > 0 ? '+' : '-'}¥${s}`;
  };

  it('两部分都非 0 → 都要显示（符号常常相反，必须让人看懂钱去哪了）', () => {
    expect(pnlBreakdown(1230, -881, fmt)).toBe('持仓 +¥12.30 · 现金 -¥8.81');
  });

  it('只有持仓变动 → 不显示现金那截', () => {
    expect(pnlBreakdown(1230, 0, fmt)).toBe('持仓 +¥12.30');
  });

  it('只有现金变动 → 不显示持仓那截', () => {
    expect(pnlBreakdown(0, -881, fmt)).toBe('现金 -¥8.81');
  });

  it('都为 0 → 「今日暂无变动」而不是空串', () => {
    // 空串会让副标题整行塌掉，看起来像页面坏了
    expect(pnlBreakdown(0, 0, fmt)).toBe('今日暂无变动');
  });

  it('⚠️ 不把「持仓 +0」当变动（避免出现无意义的 +¥0.00 片段）', () => {
    expect(pnlBreakdown(0, 100, fmt)).not.toContain('持仓');
    expect(pnlBreakdown(100, 0, fmt)).not.toContain('现金');
  });
});
