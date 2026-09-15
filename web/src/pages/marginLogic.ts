// pages/marginLogic.ts —— 融资融券页的纯逻辑：比例渲染 / 状态文案 / 输入解析 / 数量上限。
//
// 为什么单独成文件：这些都是**可单测的纯函数**，且有几条是「写错了不会崩、只会骗人」的
// 隐性错误（比例为 null 时渲染成 0%、上限算多了导致按钮点了必失败）。放这里能直接断言。
import { LOT_SIZE, maxBuyQty } from '../lib/fees.js';
import type { MarginState } from '../api.js';

/**
 * 维持担保比例 → 百分比文案。
 *
 * ⚠️ `ratioE6 === null` 表示**没有负债**（比例无意义），必须渲染成「—」。
 * 渲染成 `0.00%` 会被读成「马上就要爆仓」，渲染成 `Infinity%` 更糟。
 */
export function ratioPct(ratioE6: number | null): string {
  if (ratioE6 === null) return '—';
  return `${(ratioE6 / 10_000).toFixed(2)}%`;
}

/** 比例状态的短标签。 */
export function statusLabel(status: MarginState['status']): string {
  if (status === 'call') return '追保中';
  if (status === 'warn') return '低于警戒线';
  return '正常';
}

/**
 * 比例状态 → 色调类名。
 * 注意是**反向**的：比例越高越安全（绿），越低越危险（红）。
 */
export function statusTone(status: MarginState['status']): 'up' | 'down' | 'flat' {
  if (status === 'call') return 'up';     // 红：危险
  if (status === 'warn') return 'flat';   // 灰：警示
  return 'down';                          // 绿：安全
}

/** 顶部告警文案；正常时返回 null（**整段不渲染**，不要渲染空横幅）。 */
export function alertText(state: MarginState, warnRatioE6: number, liqRatioE6: number): string | null {
  if (state.status === 'call') {
    return `维持担保比例已跌破平仓线 ${pctOf(liqRatioE6)}，`
      + '若下一交易日收盘前仍未补足将被强制平仓。请尽快卖券还款或直接还款。';
  }
  if (state.status === 'warn') {
    return `维持担保比例低于警戒线 ${pctOf(warnRatioE6)}，暂不能开新仓。`;
  }
  if (state.warnSinceDay !== null) {
    return `已在第 ${state.warnSinceDay} 日进入追保，当前比例已回到警戒线之上。`;
  }
  if (!state.eligible) {
    return `信誉分需达到 ${state.minCredit} 才能开通信用账户。`;
  }
  return null;
}

/** e6 → 百分比文案（无正负号）。 */
function pctOf(e6: number): string {
  return `${(e6 / 10_000).toFixed(0)}%`;
}

/** 仓位方向的显示名。 */
export function kindLabel(kind: 'long' | 'short'): string {
  return kind === 'long' ? '融资买入' : '融券卖出';
}

/** 一个仓位当前可用的「了结」动作名。 */
export function closeActionLabel(kind: 'long' | 'short'): string {
  return kind === 'long' ? '卖券还款' : '买券还券';
}

/**
 * 解析股数输入（整数、> 0、买入须为 100 整数倍）。
 * 空串返回错误，由调用方决定用什么默认值兜底（通常是「最大可买」）。
 */
export function parseQty(text: string): { qty: number } | { error: string } {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return { error: '请填写数量' };
  if (!/^\d+$/.test(t)) return { error: '数量须为整数股' };
  const qty = Number(t);
  if (!Number.isSafeInteger(qty) || qty <= 0) return { error: '数量须为正整数' };
  if (qty % LOT_SIZE !== 0) return { error: `买入须为 ${LOT_SIZE} 股的整数倍` };
  return { qty };
}

/**
 * 由**金额上限**换算最大可买股数（向下取整到整手）。
 *
 * ⚠️ 上限一律用服务端下发的 `maxFinanceCents` / `maxShortCents`，**不要**在页面里
 * 自己按「现金 ÷ 价格 ÷ 2」重算 —— 那只是把服务端的公式抄到第二个地方，迟早漂移，
 * 而漂移的后果是「UI 说能买、点下去 403」。这里只做「金额 → 整手股数」的换算。
 *
 * ⚠️ 融资那一侧还要再夹一次 `maxBuyQty(cash, price)`：`maxFinanceCents` 虽然已含现金
 * 约束，但被负债上限压低后仍是「金额」口径；换成股数时纯除法会多算一手，
 * 因为佣金按整笔名义计费且有 500 分保底。
 */
export function maxQtyFromCents(cents: number, price: number, cashAvailable?: number): number {
  if (!Number.isFinite(cents) || !Number.isFinite(price) || cents <= 0 || price <= 0) return 0;
  const byAmount = Math.floor(cents / price / LOT_SIZE) * LOT_SIZE;
  if (cashAvailable === undefined) return byAmount;
  return Math.max(0, Math.min(byAmount, maxBuyQty(cashAvailable, price)));
}

/**
 * 页面上「我能开多少仓」的一句话解释。
 * 分开说清是**现金**卡住还是**负债上限**卡住 —— 否则玩家只知道「开不了」，
 * 不知道该去赚钱还是去还款。
 */
export function capacityNote(state: MarginState): string | null {
  if (!state.open) return null;
  if (state.status !== 'ok') return '维持担保比例不足，暂不能开新仓。';
  if (state.maxFinanceCents <= 0 && state.maxShortCents <= 0) {
    return state.debtRoom <= 0
      ? '融资负债已达上限（信誉分 × 每分额度），先还款才能继续加杠杆。'
      : '可用现金不足，先补充资金再开仓。';
  }
  return null;
}
