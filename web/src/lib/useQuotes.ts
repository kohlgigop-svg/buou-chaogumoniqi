// lib/useQuotes.ts —— 订阅一组代码并持有最新报价。
//
// ⚠️⚠️ **`chgBp` 在两种行里语义不同，这是本项目最容易踩的坑**（已由端到端探针实证）：
//
//   · **指数行 `IDX:COMP`**：`chgBp` 是「相对平盘的**偏离**」，
//     平盘 = `0`，涨 1.23% = `+123`；该行 `price = 10000 + chgBp`。
//     展示用 `fmtIndexChgBp()`。
//   · **个股行**：`chgBp` 是**基点值本身**，平盘 = `0`，涨 1.23% = `+123`；
//     展示用 `fmtStockChgBp()`。
//
//   两者数值口径其实一致（都是「基点偏离量，平盘=0」），但**历史包袱**是：
//   `web/src/format.ts` 原有的 `fmtBp(bp)` 用的是「10000 = 平盘」的旧口径
//   （`(bp - 10000) / 100`），**那是错的**，会把平盘的个股显示成 `-100.00%`。
//   本文件因此**不使用 `fmtBp`**，改提供下面两个语义明确的函数。
//
//   另注：服务端在 `prevClose === 0`（首日盘前还没有昨收）时也发 `0`，
//   与「平盘」不可区分 —— 这是服务端的口径，前端无法分辨，展示时按平盘处理。
import { useEffect, useMemo, useState } from 'react';
import type { QuoteRow } from './ws.js';
import { INDEX_CODE } from './ws.js';

export { INDEX_CODE };

/** 一条报价。 */
export interface Quote {
  code: string;
  /** 价格（分）。⚠️ 指数行此字段是 `10000 + chgBp`，不是分。 */
  price: number;
  /**
   * 涨跌，单位基点，**平盘 = 0**。
   * ⚠️ 不是「10000 = 平盘」。见文件头说明。
   */
  chgBp: number;
  /** 成交量（股）。 */
  volume: number;
}

/**
 * 基点偏离量 → 带符号百分比。**平盘 = 0**（个股行的口径）。
 * `0` → `0.00%`；`123` → `+1.23%`；`-250` → `-2.50%`。
 */
export function fmtStockChgBp(chgBp: number): string {
  if (chgBp === 0) return '0.00%';
  const pct = chgBp / 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/**
 * 指数行涨跌 → 带符号百分比。
 *
 * 指数行的 `chgBp` 是「相对平盘的偏离」，所以与个股用同一个换算
 * （`bp / 100`）。单独开一个函数是为了在调用点留下语义标记，
 * 避免后人以为两处可以互换常量。
 */
export function fmtIndexChgBp(chgBp: number): string {
  return fmtStockChgBp(chgBp);
}

/** 涨跌方向（供 CSS 上色）。平盘 = 0。 */
export function chgTone(chgBp: number): 'up' | 'down' | 'flat' {
  if (chgBp === 0) return 'flat';
  return chgBp > 0 ? 'up' : 'down';
}

/**
 * 校验并转换一行行情。脏帧返回 `null` 而不是抛出——
 * 一行坏数据不该让整个行情表崩掉或静默写入 NaN。
 */
export function quoteFromRow(row: unknown): Quote | null {
  if (!Array.isArray(row) || row.length < 4) return null;
  const [code, price, chgBp, volume] = row as unknown[];
  if (typeof code !== 'string') return null;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  if (typeof chgBp !== 'number' || !Number.isFinite(chgBp)) return null;
  if (typeof volume !== 'number' || !Number.isFinite(volume)) return null;
  return { code, price, chgBp, volume };
}

/** 把一组行情行并入现有表（新值覆盖旧值，缺失的代码保留旧值）。 */
export function mergeQuotes(prev: Map<string, Quote>, rows: unknown[]): Map<string, Quote> {
  const next = new Map(prev);
  for (const row of rows) {
    const q = quoteFromRow(row);
    if (q !== null) next.set(q.code, q);
  }
  return next;
}

/** 提取行情行里的代码列表（用于订阅：服务端只推你订阅的，指数恒推不必订阅）。 */
export function codesFromRows(rows: unknown[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const q = quoteFromRow(row);
    if (q !== null && q.code !== INDEX_CODE) out.push(q.code);
  }
  return out;
}

/** `useQuotes` 需要的 socket 能力（只取用到的部分，便于测试注入替身）。 */
export interface QuoteSource {
  on: (type: 'tick', cb: (m: { quotes: QuoteRow[] }) => void) => () => void;
  sub: (codes: string[]) => void;
}

/**
 * 订阅 `codes` 并返回最新报价表。
 *
 * 订阅在 `codes` 变化时**替换式**重发；卸载时退订（发空数组），
 * 避免离开个股页后仍持续接收无关行情。
 */
export function useQuotes(source: QuoteSource | null, codes: string[]): Map<string, Quote> {
  const [quotes, setQuotes] = useState<Map<string, Quote>>(() => new Map());

  // codes 是数组字面量时每次渲染都是新引用，用内容做依赖键避免死循环。
  const key = useMemo(() => [...codes].sort().join(','), [codes]);

  // 订阅：**只在 codes 变化时替换**，不在卸载时也顺带发一次空订阅。
  //
  // 为什么把"替换订阅"与"卸载退订"拆成两个 effect：若合在一个 effect 里，
  // 依赖变化时 React 会先跑 cleanup（发 `sub([])`）再跑新 effect（发 `sub(newCodes)`），
  // 服务端就会收到一次「清空 → 重订」的闪烁；更糟的是这两个 effect 的 relative 顺序
  // 在测试里可见，导致断言拿到空数组——而生产里表现为切股瞬间丢一帧行情。
  useEffect(() => {
    if (source === null) return;
    const list = key === '' ? [] : key.split(',');
    source.sub(list);
  }, [source, key]);

  // 事件订阅与退订：生命周期只跟 `source` 走，与 codes 无关。
  useEffect(() => {
    if (source === null) return;
    const off = source.on('tick', (m) => { setQuotes(prev => mergeQuotes(prev, m.quotes)); });
    return () => {
      off();
      source.sub([]);   // 真正卸载时才退订
    };
  }, [source]);

  return quotes;
}
