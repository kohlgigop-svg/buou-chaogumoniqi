// pages/homeLogic.ts —— 首页的纯计算逻辑（与渲染分离，便于单测）。
//
// 这些函数是「容易算错且算错会崩/误导」的地方，故抽出来单独测。

/** 信誉分档位：<500 危险、500–699 警示、≥700 良好。 */
export type CreditTier = 'danger' | 'warning' | 'good';

export function creditTier(score: number): CreditTier {
  if (score < 500) return 'danger';
  if (score < 700) return 'warning';
  return 'good';
}

/**
 * 进度百分比（0–100 整数）。
 * 区间长度 ≤0 时返回 100（视为已完成），**避免除零得到 NaN/Infinity**。
 */
export function shiftProgress(startGmin: number, endGmin: number, nowGmin: number): number {
  const span = endGmin - startGmin;
  if (span <= 0) return 100;
  const done = ((nowGmin - startGmin) / span) * 100;
  return Math.round(Math.min(100, Math.max(0, done)));
}

/**
 * 剩余时间文案。`remain` 单位为**游戏分钟**（1 游戏日 = 1440 游戏分）。
 * 分级：<1 小时报分钟；<1 日报小时；≥1 日报天。
 */
export function fmtRemaining(remain: number): string {
  if (remain <= 0) return '已结束';
  const m = Math.floor(remain);
  if (m < 60) return `剩余 ${m} 分钟`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest === 0 ? `剩余 ${h} 小时` : `剩余 ${h} 小时 ${rest} 分`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return h === 0 ? `剩余 ${d} 天` : `剩余 ${d} 天 ${h} 小时`;
}

/** 盈亏色调：>0 涨（红）、<0 跌（绿）、=0 平。用于「今日盈亏」的着色。 */
export type PnlTone = 'up' | 'down' | 'flat';

export function pnlTone(amount: number): PnlTone {
  if (amount > 0) return 'up';
  if (amount < 0) return 'down';
  return 'flat';
}

/**
 * 「今日盈亏」的副标题文案。
 *
 * 当日盈亏 = 持仓浮盈 + 现金净流，两者**符号常常相反**（例如买入成交后现金减少、
 * 但持仓增加），只看总数会让人疑惑「钱去哪了」。故把拆解写进文案：
 * - 两部分都非 0：`持仓 +¥12.30 · 现金 −¥8.81`
 * - 只有一部分非 0：只显示非 0 的那部分
 * - 都为 0：`今日暂无变动`
 *
 * 金额单位为**分**；`fmt` 注入 `fmtSignedMoney` 以便与全局金额格式完全一致
 * （避免这里再写一份格式化逻辑，两处迟早会不一致）。
 */
export function pnlBreakdown(
  positionPnl: number,
  cashFlow: number,
  fmt: (cents: number) => string,
): string {
  const parts: string[] = [];
  if (positionPnl !== 0) parts.push(`持仓 ${fmt(positionPnl)}`);
  if (cashFlow !== 0) parts.push(`现金 ${fmt(cashFlow)}`);
  return parts.length === 0 ? '今日暂无变动' : parts.join(' · ');
}

