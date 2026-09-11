// test/useQuotes.test.ts —— Task 8：行情表合并 / 订阅语义 / 退订。
import { describe, it, expect, vi } from 'vitest';
import {
  quoteFromRow,
  mergeQuotes,
  codesFromRows,
  useQuotes,
  fmtStockChgBp,
  fmtIndexChgBp,
  chgTone,
  INDEX_CODE,
  type Quote,
  type QuoteSource,
} from '../src/lib/useQuotes.js';
import { renderHook, act } from '@testing-library/react';
import type { QuoteRow } from '../src/lib/ws.js';

describe('mergeQuotes：新行覆盖旧值，未出现的代码保留', () => {
  it('同一代码被新行覆盖', () => {
    const prev = new Map<string, Quote>([
      ['600619', { code: '600619', price: 84600, chgBp: 100, volume: 10 }],
    ]);
    const next = mergeQuotes(prev, [['600619', 85000, 200, 20]]);
    expect(next.get('600619')).toEqual({ code: '600619', price: 85000, chgBp: 200, volume: 20 });
  });

  it('未出现的代码保留旧值（部分推送不清空全表）', () => {
    const prev = new Map<string, Quote>([
      ['600619', { code: '600619', price: 1, chgBp: 0, volume: 0 }],
      ['600859', { code: '600859', price: 2, chgBp: 0, volume: 0 }],
    ]);
    const next = mergeQuotes(prev, [['600619', 9, 0, 0]]);
    expect(next.get('600859')?.price).toBe(2);
    expect(next.get('600619')?.price).toBe(9);
  });

  it('脏行被忽略，不会写入 NaN 或半条记录', () => {
    const next = mergeQuotes(new Map(), [
      ['good', 1, 0, 0],
      ['bad', 'x', 0, 0],
      null,
      ['short'],
    ]);
    expect([...next.keys()]).toEqual(['good']);
  });

  it('不修改入参（纯函数）', () => {
    const prev = new Map<string, Quote>();
    mergeQuotes(prev, [['a', 1, 0, 0]]);
    expect(prev.size).toBe(0);
  });

  it('指数行可正常并入（其 price 是基点，非分）', () => {
    const next = mergeQuotes(new Map(), [[INDEX_CODE, 10050, 50, 1]]);
    expect(next.get(INDEX_CODE)?.price).toBe(10050);
  });
});

describe('codesFromRows：提取订阅代码，排除恒推的指数', () => {
  it('过滤掉 IDX:COMP（服务端恒推，订阅它无意义）', () => {
    expect(codesFromRows([[INDEX_CODE, 10000, 0, 0], ['600619', 1, 0, 0]])).toEqual(['600619']);
  });

  it('空数组 → 空数组', () => {
    expect(codesFromRows([])).toEqual([]);
  });

  it('脏行跳过', () => {
    expect(codesFromRows([null, ['ok', 1, 0, 0], 42])).toEqual(['ok']);
  });
});

/** 可手动派发 tick 的 source 替身。 */
function fakeSource(): QuoteSource & { emit: (rows: QuoteRow[]) => void; subs: string[][] } {
  const handlers = new Set<(m: { quotes: QuoteRow[] }) => void>();
  const subs: string[][] = [];
  return {
    subs,
    emit(rows) { for (const h of handlers) h({ quotes: rows }); },
    on(_type, cb) { handlers.add(cb); return () => handlers.delete(cb); },
    sub(codes) { subs.push(codes); },
  } as QuoteSource & { emit: (rows: QuoteRow[]) => void; subs: string[][] };
}

describe('useQuotes：订阅与退订', () => {
  it('挂载时按内容排序订阅（顺序不影响订阅集，避免无谓重发）', () => {
    const src = fakeSource();
    renderHook(() => useQuotes(src, ['600859', '600619']));
    expect(src.subs[0]).toEqual(['600619', '600859']);
  });

  it('codes 内容不变时不重复订阅（数组新引用不算变化）', () => {
    const src = fakeSource();
    const { rerender } = renderHook(({ codes }) => useQuotes(src, codes), {
      initialProps: { codes: ['600619'] },
    });
    rerender({ codes: ['600619'] }); // 新数组、同内容
    expect(src.subs).toHaveLength(1);
  });

  it('codes 内容变化 → 替换式重订', () => {
    const src = fakeSource();
    const { rerender } = renderHook(({ codes }) => useQuotes(src, codes), {
      initialProps: { codes: ['600619'] },
    });
    rerender({ codes: ['002331'] });
    expect(src.subs[1]).toEqual(['002331']);
  });

  it('卸载时退订（发空数组）', () => {
    const src = fakeSource();
    const { unmount } = renderHook(() => useQuotes(src, ['600619']));
    unmount();
    expect(src.subs[src.subs.length - 1]).toEqual([]);
  });

  it('收到 tick 后表被合并更新', () => {
    const src = fakeSource();
    const { result } = renderHook(() => useQuotes(src, ['600619']));
    act(() => { src.emit([['600619', 85000, 200, 20]]); });
    expect(result.current.get('600619')).toEqual({ code: '600619', price: 85000, chgBp: 200, volume: 20 });
  });

  it('source 为 null 时不订阅也不崩（未连接状态）', () => {
    const { result } = renderHook(() => useQuotes(null, ['600619']));
    expect(result.current.size).toBe(0);
  });

  it('空 codes 数组 → 订阅空集', () => {
    const src = fakeSource();
    renderHook(() => useQuotes(src, []));
    expect(src.subs[0]).toEqual([]);
  });
});

describe('⚠️ chgBp 语义（端到端探针实证的坑）', () => {
  // 真实服务端实测：盘前 prevClose=0 时发 chgBp=0；平盘也是 0。
  // 用「10000 = 平盘」的旧口径会把平盘个股显示成 -100.00%。
  it('个股：平盘 0 → 0.00%（不是 -100.00%）', () => {
    expect(fmtStockChgBp(0)).toBe('0.00%');
  });

  it('个股：+123 bp → +1.23%', () => {
    expect(fmtStockChgBp(123)).toBe('+1.23%');
  });

  it('个股：-250 bp → -2.50%', () => {
    expect(fmtStockChgBp(-250)).toBe('-2.50%');
  });

  it('指数：与个股同口径（都是平盘=0 的偏离量）', () => {
    expect(fmtIndexChgBp(0)).toBe('0.00%');
    expect(fmtIndexChgBp(123)).toBe('+1.23%');
    expect(fmtIndexChgBp(-50)).toBe('-0.50%');
  });

  it('指数行的 price 与 chgBp 自洽：price = 10000 + chgBp', () => {
    const q = quoteFromRow([INDEX_CODE, 10123, 123, 5000]);
    expect(q!.price).toBe(10000 + q!.chgBp);
  });

  it('chgTone：0 是 flat，不是 up', () => {
    expect(chgTone(0)).toBe('flat');
    expect(chgTone(1)).toBe('up');
    expect(chgTone(-1)).toBe('down');
  });

  it('真实服务端抓到的帧可正确换算（回归锚点）', () => {
    // 实际抓包： {"t":"tick","quotes":[["IDX:COMP",10000,0,0],["600619",158000,0,0]]}
    const idx = quoteFromRow(['IDX:COMP', 10000, 0, 0])!;
    const stock = quoteFromRow(['600619', 158000, 0, 0])!;
    expect(fmtIndexChgBp(idx.chgBp)).toBe('0.00%');
    expect(fmtStockChgBp(stock.chgBp)).toBe('0.00%');
  });
});

/** 静默 vitest 的未使用告警（vi 在本文件仅用于将来扩展）。 */
void vi;
