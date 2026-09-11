// format.ts —— 展示层格式化（纯函数，无副作用）。
//
// 口径纪律：金额全链路为整数「分」，本文件是前端唯一的「分 → 可读文本」出口。
// 不要在组件里手写 toFixed / 除 100，否则会与后端 roundHalfUpDiv 的进位语义分叉。
//
// 单位备忘（勿臆造）：
//   · 金额 = 分（1 元 = 100 分）
//   · 比例 = 小数（0.0123 = 1.23%）
//   · chgBp = 基点（10000 = 平盘，来自 WS tick）
//   · rateE6 = **日息** e6（300 = 0.03%/日），非年化
//   · gmin = 游戏分钟（1 游戏日 = 1440 分钟）

/** 千分位整数（不做小数处理）。 */
function groupInt(n: number): string {
  return Math.trunc(n).toLocaleString('en-US');
}

/** 分 → 「元.角分」两段字符串，始终两位小数。 */
function centsToParts(cents: number): { sign: string; yuan: string; frac: string } {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const yuan = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return { sign: neg ? '-' : '', yuan: groupInt(yuan), frac };
}

/** `1234567` → `¥12,345.67`；负数 `-¥1.23`。 */
export function fmtMoney(cents: number): string {
  const p = centsToParts(cents);
  return `${p.sign}¥${p.yuan}.${p.frac}`;
}

/** 带正负号的金额：`+¥12,345.67` / `-¥1.23` / 零为 `¥0.00`。 */
export function fmtSignedMoney(cents: number): string {
  if (cents === 0) return fmtMoney(0);
  return `${cents > 0 ? '+' : ''}${fmtMoney(cents)}`;
}

/**
 * 指数点位：**输入已是「点」不是「分」**，故不带 ¥ 也不除 100。
 * 服务端 `GET /market/overview` 的 `index.level` 已做过 `level / 100`
 * （DB 里 IDX:COMP 存的是「指数点 ×100」），前端**再除一次就会少两位**。
 * `3123.45` → `3,123.45`。
 */
export function fmtIndex(level: number): string {
  const neg = level < 0;
  const abs = Math.abs(level);
  const int = Math.floor(abs);
  const frac = Math.round((abs - int) * 100);
  // 四舍五入到 100 时进位（如 3123.999 → 3124.00）
  const carry = frac === 100;
  return `${neg ? '-' : ''}${groupInt(carry ? int + 1 : int)}.${String(carry ? 0 : frac).padStart(2, '0')}`;
}

/**
 * 金额紧凑显示：≥1 亿 → `x.xx亿`；≥1 万 → `xxxx.x万`；否则走 fmtMoney。
 * 用于概览卡片等空间受限处，不用于流水明细（明细必须是分毫不差的 fmtMoney）。
 */
export function fmtCompactMoney(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const yuan = abs / 100;
  let out: string;
  if (yuan >= 1_0000_0000) out = `${(yuan / 1_0000_0000).toFixed(2)}亿`;
  else if (yuan >= 1_0000) out = `${(yuan / 1_0000).toFixed(1)}万`;
  else return fmtMoney(cents);
  return `${neg ? '-' : ''}${out}`;
}

/** 比例（小数）→ 带符号百分比：`0.0123` → `+1.23%`；零不带符号。 */
export function fmtPct(x: number): string {
  if (x === 0) return '0.00%';
  const v = (x * 100).toFixed(2);
  return `${x > 0 ? '+' : ''}${v}%`;
}

/** 基点 → 百分比：`10123` → `+1.23%`（10000 为平盘）。 */
export function fmtBp(bp: number): string {
  if (bp === 10000) return '0.00%';
  const pct = (bp - 10000) / 100;
  const v = pct.toFixed(2);
  return `${pct > 0 ? '+' : ''}${v}%`;
}

/** 分 → 带符号的两段数值（无货币符号、带千分位）：`+12,345.67`。 */
export function fmtSigned(cents: number): string {
  const p = centsToParts(cents);
  return `${p.sign === '-' ? '-' : cents > 0 ? '+' : ''}${p.yuan}.${p.frac}`;
}

/** 数量千分位：`1234567` → `1,234,567`。 */
export function fmtQty(n: number): string {
  return Math.trunc(n).toLocaleString('en-US');
}

/** 游戏分钟 → `HH:MM`，跨日取模（负数按前一日）。 */
export function fmtTime(gmin: number): string {
  const day = 1440;
  const m = ((Math.trunc(gmin) % day) + day) % day;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 日息 e6 → `0.030%/日`。
 * ⚠️ `rateE6` 是**日息**（后端 accrue = outstanding × rateE6 / 1e6，逐日计提），
 * 不要标注为「年化」，否则会误导用户对借贷成本的判断。
 */
export function fmtRate(rateE6: number): string {
  return `${(rateE6 / 1e6 * 100).toFixed(3)}%/日`;
}
