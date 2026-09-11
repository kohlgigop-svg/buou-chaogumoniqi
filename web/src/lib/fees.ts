// lib/fees.ts —— 交易费用与可买/可卖量计算。
//
// ⚠️ 本文件是服务端 `server/src/core/money.ts` 的**逐分镜像**：
// 任何一处与后端不一致，用户看到的预估费用就会与实际冻结/扣款不同，
// 属于「看起来能用但会误导」的 bug。改动前先比对服务端实现与测试向量。
//
// 服务端契约（务必保持）：
//   commission(a) = max(500, roundHalfUpDiv(a*25, 100_000))     // 万2.5，最低 500 分
//   stampTax(a)   = roundHalfUpDiv(a*5, 10_000)                 // 0.05%（仅卖出）
//   transferFee(a)= roundHalfUpDiv(a, 100_000)                  // 万0.1（双向）
//   买入冻结 = 名义 + commission + transferFee                  // **买入无印花税**
//
// 已实证的服务端向量（见 test/fees.test.ts，勿改期望值）：
//   amount 15,800,000 → commission 3950 / stampTax 7900 / transferFee 158
//   amount     52,000 → commission  500（最低生效）/ stampTax 26 / transferFee 1

/** 最低佣金（分）。与服务端 `MIN_COMMISSION` 对齐。 */
export const MIN_COMMISSION = 500;

/** 一手股数（买入必须为其整数倍）。 */
export const LOT_SIZE = 100;

/**
 * 四舍五入整除：`floor(n/d)` 后余数 `r*2 >= d` 则进位。
 * **契约：`n` 必须是安全整数且 ≥ 0，`d` > 0**（与服务端同款约束，
 * 违规抛错而非静默纠正，避免前后端行为分叉）。
 */
export function roundHalfUpDiv(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad dividend: ${n}`);
  if (d <= 0) throw new Error('bad divisor');
  const q = Math.floor(n / d);
  const r = n - q * d;
  return r * 2 >= d ? q + 1 : q;
}

function assertNonNegative(amount: number): void {
  if (!Number.isSafeInteger(amount)) throw new Error(`not integer cents: ${amount}`);
  if (amount < 0) throw new Error(`negative amount: ${amount}`);
}

/** 佣金：万 2.5，最低 500 分。 */
export function commission(amount: number): number {
  assertNonNegative(amount);
  return Math.max(MIN_COMMISSION, roundHalfUpDiv(amount * 25, 100_000));
}

/** 印花税：0.05%，**仅卖出**收取（买入不计）。 */
export function stampTax(amount: number): number {
  assertNonNegative(amount);
  return roundHalfUpDiv(amount * 5, 10_000);
}

/** 过户费：万 0.1，双向收取。 */
export function transferFee(amount: number): number {
  assertNonNegative(amount);
  return roundHalfUpDiv(amount, 100_000);
}

/** 买入总成本（名义 + 佣金 + 过户费；**不含**印花税）。 */
export function buyCost(amount: number): number {
  return amount + commission(amount) + transferFee(amount);
}

/**
 * 卖出净收入（名义 − 佣金 − 印花税 − 过户费）。
 * 下限夹到 0：极小金额时费用可能超过名义，负数收入无意义。
 */
export function sellProceeds(amount: number): number {
  const net = amount - commission(amount) - stampTax(amount) - transferFee(amount);
  return net > 0 ? net : 0;
}

/**
 * 买单冻结额 = 名义 + 佣金 + 过户费。
 * 与服务端 `orders.ts` 的 `freeze = base + commission(base) + transferFee(base)` 一致。
 * 注意：市价单的 `base` 由调用方按「现价 ×(1+2% 缓冲) 逐股向上取整」算好后传入
 * （见服务端 `cfg.trading.marketBufferPct`），本函数不负责缓冲。
 */
export function buyFreeze(amount: number): number {
  return amount + commission(amount) + transferFee(amount);
}

/**
 * 可买股数：不超过现金的最大 **100 股整数倍**。
 *
 * 因为佣金有 500 分下限且按整笔名义计费，费用随股数**非线性**变化，
 * 不能简单地 `cash / (price + perShareFee)`。这里用「先按无费估算上界，
 * 再向下收敛到买得起为止」的方式，保证结果**紧致**（再多买一手就超预算）。
 */
export function maxBuyQty(cash: number, price: number): number {
  if (!Number.isSafeInteger(cash) || !Number.isSafeInteger(price)) return 0;
  if (cash <= 0 || price <= 0) return 0;

  // 上界：忽略费用时的股数，再取 100 整数倍。费用只会让上界变小。
  let qty = Math.floor(cash / price / LOT_SIZE) * LOT_SIZE;
  // 向下收敛（通常 0~2 次即可，佣金下限导致最多多估一手左右）
  while (qty > 0 && buyCost(price * qty) > cash) qty -= LOT_SIZE;
  return qty > 0 ? qty : 0;
}
