// pages/marketLogic.ts —— Task 4 纯逻辑：热力图色阶 / 涨跌家数条 / 搜索过滤 / 分页去重。
// 全部为纯函数，便于独立测试（组件只负责取数与渲染）。
import type { MoverView, NewsRow, StockRow } from '../api.js';

/** 涨跌方向。`flat` 包含 |chg| 极小（浮点噪声）的情况。 */
export type HeatTone = 'up' | 'down' | 'flat';

/** 判定阈值：小于此值视为平盘，避免 1e-12 级别的浮点噪声被画成红/绿。 */
const FLAT_EPS = 1e-9;

/** 热度饱和阈值：|chg| 达到此值即记满强度。取 5% 是因为涨跌停通常 ±10%，
 *  5% 已属「很热」，再深颜色也难分辨。 */
const SATURATION = 0.05;

export function heatTone(chgPct: number): HeatTone {
  if (Math.abs(chgPct) < FLAT_EPS) return 'flat';
  return chgPct > 0 ? 'up' : 'down';
}

/**
 * 色阶强度 0..1（只看绝对值，涨跌同幅度颜色深浅一致）。
 * 客户端不做「相对全市场归一化」——那会让同一涨跌幅在不同日子显示不同颜色，
 * 反而失去可比性。固定阈值更稳定。
 */
export function heatIntensity(chgPct: number): number {
  const a = Math.abs(chgPct);
  if (a === 0) return 0;
  const v = a / SATURATION;
  return v > 1 ? 1 : v;
}

/**
 * 上涨家数占比 0..1，用于涨跌家数条的宽度。
 * 双方都是 0（休市 / 全平）时返回 0.5，不除零也不谎称「全部上涨」。
 */
export function advancerRatio(advancers: number, decliners: number): number {
  const total = advancers + decliners;
  if (total <= 0) return 0.5;
  return advancers / total;
}

/**
 * 本地搜索：代码前缀 + 名称/板块包含，大小写与首尾空白不敏感。
 * 不新增后端端点——全市场列表本就在内存里（`GET /stocks` 返回全量）。
 */
export function filterStocks(stocks: StockRow[], query: string): StockRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return stocks;
  return stocks.filter(s =>
    s.code.toLowerCase().startsWith(q)
    || s.name.toLowerCase().includes(q)
    || s.sector.toLowerCase().includes(q),
  );
}

/**
 * 新闻分页合并：按 id 去重后保持倒序。
 * 触底加载时相邻两页在边界上**必然重叠**（服务端用 `id < before`，nextBefore 是末条 id），
 * 故去重是必需项而非优化。
 */
export function mergeNews(prev: NewsRow[], next: NewsRow[]): NewsRow[] {
  const seen = new Set<number>();
  const out: NewsRow[] = [];
  for (const n of [...prev, ...next]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  out.sort((a, b) => b.id - a.id);
  return out;
}

/** 涨跌幅榜行：补上从 1 开始的序号，其余字段原样透传。 */
export interface MoverRow extends MoverView { rank: number }

export function moverRows(movers: MoverView[]): MoverRow[] {
  return movers.map((m, i) => ({ ...m, rank: i + 1 }));
}
