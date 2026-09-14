// lib/liveQuote.ts —— 把 WebSocket 实时报价**叠加**到 REST 快照上的纯函数层。
//
// 为什么需要这一层（而不是在页面里直接 `if (live) q.price = live.price`）：
//
// 1. **两个数据源的字段口径不同**。REST 快照（`GET /stocks`、`GET /stocks/:code`）
//    给的是 `chgPct`（比例，`0.0123` = +1.23%）与 `volume`/`turnover`；WS tick 给的是
//    `chgBp`（**基点，平盘 = 0**，`123` = +1.23%）与 `volume`。直接混用会把
//    平盘个股显示成 `-100.00%`（`fmtBp` 的旧口径残留，见 `format.ts` 的警告）。
//    这里统一换算成快照的 `chgPct` 口径，让渲染层只有一套字段。
//
// 2. **WS 不推所有字段**。`name` / `sector` / `board` / `prevClose` / `limitUp` / `limitDown`
//    只在 REST 里，必须保留快照值。所以是"叠加"不是"替换"。
//
// 3. **实时价是易失的**。新连接、切股、重连期间可能拿不到某个 code 的实时价，
//    此时必须**优雅回落到快照**，而不是把价格显示成 0 或 NaN。
//
// 4. **指数行要特殊对待**。`IDX:COMP` 行的 `chgBp` 口径与个股一致（平盘 = 0），
//    但它的 `price` 不是"分"而是 `10000 + chgBp`，**不能**当价格用（见 ws.ts 的注释）。
//    故指数只取 `chgBp` 换算出的 `chgPct`，价格仍用 REST 的 `level`。
import type { Quote } from './useQuotes.js';
import { INDEX_CODE } from './ws.js';
import type { MoverView, QuoteView, StockRow } from '../api.js';

/**
 * 基点（平盘 = 0）→ **比例**：`123` → `0.0123`。
 *
 * ⚠️ 除以 10000 而不是 100。这里的目标口径是快照的 `chgPct`（**比例**，
 * `0.0123` = +1.23%），而 1 基点 = 0.01%，故 `bp / 10000`。
 * 除 100 得到的是「百分数」（`1.23` = 1.23%），那是 `fmtPct` 的输入而不是
 * `chgPct` 的输入，混用会让 +1.23% 显示成 +123.00%。
 * （展示层的换算由 `fmtStockChgBp` 负责，那是另一件事。）
 */
export function bpToPct(chgBp: number): number {
  return chgBp / 10_000;
}

/**
 * 个股快照 + 实时报价 → 叠加后的快照。
 *
 * 实时报价缺失（未订阅/未收到）时**原样返回快照**，调用方可放心无条件调用。
 * 实时报价的 `volume` 是累计量，与快照同口径，可直接覆盖；`turnover` WS 不给，保留快照。
 */
export function applyLiveQuote(snap: QuoteView, live: Quote | undefined): QuoteView {
  if (live === undefined) return snap;
  return { ...snap, price: live.price, chgPct: bpToPct(live.chgBp), volume: live.volume };
}

/** 列表行（`StockRow`）版本的叠加。 */
export function applyLiveRow(snap: StockRow, live: Quote | undefined): StockRow {
  if (live === undefined) return snap;
  return { ...snap, price: live.price, chgPct: bpToPct(live.chgBp), volume: live.volume };
}

/** 涨跌榜行（`MoverView`）版本的叠加。 */
export function applyLiveMover(snap: MoverView, live: Quote | undefined): MoverView {
  if (live === undefined) return snap;
  return { ...snap, price: live.price, chgPct: bpToPct(live.chgBp) };
}

/**
 * 指数：只把 `chgBp` 转成 `chgPct`，**不用实时行的 `price`**
 * （那是 `10000 + chgBp`，不是点位；见 ws.ts 与 useQuotes.ts 的警告）。
 * `level` 仍取快照 —— 指数点位由 `level / 100` 得出，WS 那一行不携带它。
 */
export function applyLiveIndex<T extends { chgPct: number }>(snap: T, live: Quote | undefined): T {
  if (live === undefined) return snap;
  return { ...snap, chgPct: bpToPct(live.chgBp) };
}

/**
 * 从行情表里取一个报价。指数行不参与个股查询（同名函数语义更明确）。
 */
export function liveOf(quotes: Map<string, Quote>, code: string): Quote | undefined {
  if (code === INDEX_CODE) return undefined;
  return quotes.get(code);
}

/** 取一组股票代码，用于订阅（排除指数 —— 服务端恒推它，订阅它无意义）。 */
export function subCodesOf(rows: readonly { code: string }[]): string[] {
  return rows.map(r => r.code).filter(c => c !== INDEX_CODE);
}
