// test/marketLogic.test.ts —— Task 4 纯逻辑：热力图色阶 / 涨跌家数条 / 搜索过滤 / 分页去重。
import { describe, it, expect } from 'vitest';
import {
  heatTone, heatIntensity, advancerRatio,
  filterStocks, mergeNews, moverRows,
} from '../src/pages/marketLogic.js';
import type { MoverView, NewsRow, StockRow } from '../src/api.js';

// —— 热力图色阶 ——

describe('heatTone', () => {
  it('涨为 up、跌为 down、恰为 0 为 flat', () => {
    expect(heatTone(0.012)).toBe('up');
    expect(heatTone(-0.012)).toBe('down');
    expect(heatTone(0)).toBe('flat');
  });

  it('浮点误差下的极小平盘仍判稳（1e-12 视为 0）', () => {
    expect(heatTone(1e-12)).toBe('flat');
    expect(heatTone(-1e-12)).toBe('flat');
  });
});

describe('heatIntensity', () => {
  it('返回 0..1，且绝对值越大越深', () => {
    expect(heatIntensity(0)).toBe(0);
    const small = heatIntensity(0.01);
    const big = heatIntensity(0.05);
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThanOrEqual(1);
  });

  it('正负同幅度强度相同（只看绝对值）', () => {
    expect(heatIntensity(0.03)).toBe(heatIntensity(-0.03));
  });

  it('超过饱和阈值后夹在 1', () => {
    expect(heatIntensity(10)).toBe(1);
  });

  it('阈值边界：恰好 5% 记满分', () => {
    expect(heatIntensity(0.05)).toBe(1);
  });
});

// —— 涨跌家数条 ——

describe('advancerRatio', () => {
  it('给出上涨占比 0..1', () => {
    expect(advancerRatio(6, 4)).toBeCloseTo(0.6, 10);
    expect(advancerRatio(0, 10)).toBe(0);
    expect(advancerRatio(10, 0)).toBe(1);
  });

  it('双方都是 0 时返回 0.5（不除零，也不谎称全涨）', () => {
    expect(advancerRatio(0, 0)).toBe(0.5);
  });
});

// —— 搜索过滤 ——

const stocks: StockRow[] = [
  { code: '000001', name: '平安银行', sector: '银行', board: 'SZ', status: 'normal', st: false, price: 1200, chgPct: 0.01, volume: 1, turnover: 1 },
  { code: '600519', name: '贵州茅台', sector: '白酒', board: 'SH', status: 'normal', st: false, price: 180000, chgPct: -0.02, volume: 1, turnover: 1 },
  { code: '300750', name: '宁德时代', sector: '电池', board: 'SZ', status: 'normal', st: false, price: 20000, chgPct: 0, volume: 1, turnover: 1 },
];

describe('filterStocks', () => {
  it('空查询返回原列表（不复制语义变化）', () => {
    expect(filterStocks(stocks, '').length).toBe(3);
    expect(filterStocks(stocks, '   ').length).toBe(3);
  });

  it('按代码前缀命中', () => {
    const r = filterStocks(stocks, '0000');
    expect(r.map(s => s.code)).toEqual(['000001']);
  });

  it('按名称包含命中（非前缀也应命中）', () => {
    const r = filterStocks(stocks, '时代');
    expect(r.map(s => s.code)).toEqual(['300750']);
  });

  it('按板块也能命中', () => {
    const r = filterStocks(stocks, '白酒');
    expect(r.map(s => s.code)).toEqual(['600519']);
  });

  it('大小写与前后的空白被忽略', () => {
    expect(filterStocks(stocks, '  0000 ').length).toBe(1);
  });

  it('无结果返回空数组（交由调用方渲染空态）', () => {
    expect(filterStocks(stocks, 'zzz不存在')).toEqual([]);
  });
});

// —— 新闻分页合并 ——

const newsRow = (id: number): NewsRow => ({ id, day: 1, scope: 'MKT', title: `t${id}` });

describe('mergeNews', () => {
  it('追加去重，保持倒序（按 id 降序）', () => {
    const a = [newsRow(5), newsRow(4)];
    const b = [newsRow(3), newsRow(2)];
    expect(mergeNews(a, b).map(n => n.id)).toEqual([5, 4, 3, 2]);
  });

  it('重叠的 id 不会重复出现（翻页边界重复加载是常态）', () => {
    const a = [newsRow(5), newsRow(4), newsRow(3)];
    const b = [newsRow(3), newsRow(2), newsRow(1)];
    const merged = mergeNews(a, b);
    expect(merged.map(n => n.id)).toEqual([5, 4, 3, 2, 1]);
  });

  it('空批次不影响原列表', () => {
    expect(mergeNews([newsRow(2)], []).map(n => n.id)).toEqual([2]);
  });

  it('原列表为空时直接返回新批次（首屏）', () => {
    expect(mergeNews([], [newsRow(2), newsRow(1)]).map(n => n.id)).toEqual([2, 1]);
  });
});

// —— 涨跌幅榜行 ——

describe('moverRows', () => {
  const g: MoverView[] = [
    { code: '000001', name: 'A', chgPct: 0.095, price: 1000 },
    { code: '000002', name: 'B', chgPct: 0.02, price: 2000 },
  ];

  it('给每一行补上序号', () => {
    expect(moverRows(g).map(r => r.rank)).toEqual([1, 2]);
  });

  it('序号从 1 开始且连续', () => {
    const rows = moverRows(g);
    expect(rows[0]?.rank).toBe(1);
    expect(rows[1]?.rank).toBe(2);
  });

  it('保留原字段不丢', () => {
    const r = moverRows(g)[0];
    expect(r?.code).toBe('000001');
    expect(r?.name).toBe('A');
    expect(r?.chgPct).toBe(0.095);
    expect(r?.price).toBe(1000);
  });

  it('空输入返回空数组', () => {
    expect(moverRows([])).toEqual([]);
  });
});
