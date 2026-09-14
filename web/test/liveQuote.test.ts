import { describe, it, expect } from 'vitest';
import type { QuoteView, StockRow, MoverView } from '../src/api.js';
import type { Quote } from '../src/lib/useQuotes.js';
import {
  bpToPct, applyLiveQuote, applyLiveRow, applyLiveMover, applyLiveIndex, liveOf, subCodesOf,
} from '../src/lib/liveQuote.js';

// liveQuote：把 WS 实时报价叠加到 REST 快照上的纯函数层。
//
// 这一层存在的**唯一理由**是两个数据源的字段口径不同，所以测试重点全在口径上：
//   · REST 快照 chgPct 是「比例」（0.0123 = +1.23%）
//   · WS tick chgBp 是「基点，平盘 = 0」（123 = +1.23%）
// 若换算写错，平盘个股会显示成 −1.23% 甚至 −100.00%（历史上真的踩过）。

function quote(over: Partial<Quote> = {}): Quote {
  return { code: '600519', price: 5200, chgBp: 123, volume: 999, ...over };
}

const snapQuote: QuoteView = {
  code: '600519', name: '贵州茅台', sector: '白酒', board: '主板', status: 'normal',
  price: 5000, prevClose: 4944, chgPct: 0.01132686084142395,
  volume: 1234500, turnover: 2097000_00, limitUp: 5438, limitDown: 4450,
};

const snapRow: StockRow = {
  code: '600519', name: '贵州茅台', sector: '白酒', board: '主板', status: 'normal',
  st: false, price: 5000, chgPct: 0.0113, volume: 1234500, turnover: 2097000_00,
};

const snapMover: MoverView = { code: '600519', name: '贵州茅台', chgPct: 0.0113, price: 5000 };

describe('bpToPct：基点（平盘 = 0）→ 比例', () => {
  it('平盘 0 → 0', () => { expect(bpToPct(0)).toBe(0); });
  it('123 → 0.0123（+1.23%）', () => { expect(bpToPct(123)).toBeCloseTo(0.0123, 10); });
  it('−250 → −0.025（−2.50%）', () => { expect(bpToPct(-250)).toBeCloseTo(-0.025, 10); });
});

describe('applyLiveQuote：个股快照 + 实时价', () => {
  it('覆盖 price / chgPct / volume，且 chgPct 换算成比例口径', () => {
    const out = applyLiveQuote(snapQuote, quote({ price: 5100, chgBp: 300, volume: 888 }));
    expect(out.price).toBe(5100);
    // chgBp=300 是基点 → 0.03 比例。若误当比例用会得到 30000%
    expect(out.chgPct).toBeCloseTo(0.03, 10);
    expect(out.volume).toBe(888);
  });

  it('保留 WS 不推的静态字段（name/sector/prevClose/limitUp/limitDown/turnover）', () => {
    const out = applyLiveQuote(snapQuote, quote());
    expect(out.name).toBe('贵州茅台');
    expect(out.sector).toBe('白酒');
    expect(out.prevClose).toBe(4944);
    expect(out.limitUp).toBe(5438);
    expect(out.limitDown).toBe(4450);
    expect(out.turnover).toBe(2097000_00);
  });

  it('实时价缺失时原样返回快照（未订阅/未收到 tick 时不崩、不显示 0）', () => {
    const out = applyLiveQuote(snapQuote, undefined);
    expect(out).toBe(snapQuote);          // 同一引用：调用方可以放心无条件调用
    expect(out.price).toBe(5000);
  });

  it('平盘（chgBp=0）→ chgPct 恰为 0，不是 −1% 也不是 −100%', () => {
    const out = applyLiveQuote(snapQuote, quote({ chgBp: 0 }));
    expect(out.chgPct).toBe(0);
  });

  it('不修改入参（快照是 React state，原地改写会导致引用不变而漏渲染）', () => {
    const before = { ...snapQuote };
    applyLiveQuote(snapQuote, quote({ price: 9999 }));
    expect(snapQuote).toEqual(before);
  });
});

describe('applyLiveRow / applyLiveMover：列表与榜单', () => {
  it('列表行同口径覆盖', () => {
    const out = applyLiveRow(snapRow, quote({ price: 5050, chgBp: -100, volume: 7 }));
    expect(out.price).toBe(5050);
    expect(out.chgPct).toBeCloseTo(-0.01, 10);
    expect(out.volume).toBe(7);
    expect(out.name).toBe('贵州茅台');     // 静态字段保留
    expect(out.turnover).toBe(2097000_00);
  });

  it('榜单行覆盖 price/chgPct（MoverView 无 volume）', () => {
    const out = applyLiveMover(snapMover, quote({ price: 5120, chgBp: 500 }));
    expect(out.price).toBe(5120);
    expect(out.chgPct).toBeCloseTo(0.05, 10);
    expect(out.name).toBe('贵州茅台');
  });

  it('缺失实时价时原样返回', () => {
    expect(applyLiveRow(snapRow, undefined)).toBe(snapRow);
    expect(applyLiveMover(snapMover, undefined)).toBe(snapMover);
  });
});

describe('applyLiveIndex：指数只叠涨跌，不碰点位', () => {
  const idx = { code: 'IDX:COMP', level: 3123.45, chgPct: 0.0123 };

  it('chgBp 换算为 chgPct', () => {
    const out = applyLiveIndex(idx, quote({ code: 'IDX:COMP', chgBp: 88 }));
    expect(out.chgPct).toBeCloseTo(0.0088, 10);
  });

  it('⚠️ level 必须保持快照值 —— WS 指数行的 price 是 10000+chgBp，不是点位', () => {
    // 若误把 live.price 当点位，这里会变成 10088 而不是 3123.45
    const out = applyLiveIndex(idx, quote({ code: 'IDX:COMP', price: 10_088, chgBp: 88 }));
    expect(out.level).toBe(3123.45);
  });

  it('缺失实时价时原样返回', () => {
    expect(applyLiveIndex(idx, undefined)).toBe(idx);
  });
});

describe('liveOf / subCodesOf', () => {
  const quotes = new Map<string, Quote>([
    ['600519', quote()],
    ['IDX:COMP', quote({ code: 'IDX:COMP', price: 10_123, chgBp: 123 })],
  ]);

  it('liveOf 取到个股', () => { expect(liveOf(quotes, '600519')?.price).toBe(5200); });

  it('⚠️ liveOf 对指数恒返回 undefined（指数行会被错误地当个股价格用）', () => {
    expect(liveOf(quotes, 'IDX:COMP')).toBeUndefined();
  });

  it('liveOf 对未订阅的代码返回 undefined', () => {
    expect(liveOf(quotes, '000001')).toBeUndefined();
  });

  it('subCodesOf 排除指数（服务端恒推，订阅它无意义）', () => {
    expect(subCodesOf([{ code: '600519' }, { code: 'IDX:COMP' }, { code: '000001' }]))
      .toEqual(['600519', '000001']);
  });

  it('subCodesOf 空输入 → 空数组', () => { expect(subCodesOf([])).toEqual([]); });
});
