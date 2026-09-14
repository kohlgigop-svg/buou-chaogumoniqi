import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser, MarketOverview, NewsRow, StockRow, StockDetail, MeView, HealthView } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import { RealtimeProvider } from '../src/lib/realtime.js';
import type { FillMessage, WsClient } from '../src/lib/ws.js';
import Market from '../src/pages/Market.js';
import Stock from '../src/pages/Stock.js';

// 行情实时接线（Task 9 收尾）：REST 只给首屏快照，价格必须由 WS tick 持续覆盖。
//
// 重点验「接线真的接通了」，而不重复验换算公式（那是 liveQuote.test.ts 的职责）：
// 1. Market：指数涨跌、榜单、股票列表都跟着 tick 变
// 2. Stock：个股页行情头跟着 tick 变，且**订阅了本股代码**（不订阅永远收不到）
// 3. 收不到 tick 时回落快照，不显示 0 / NaN
// 4. ⚠️ 指数行的 price 是 `10000 + chgBp`，不能被当成点位用

const alice: AuthUser = { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 };

/** 可手动派发 tick 的 client 替身；`subLog` 记录订阅调用。 */
function fakeClient(): WsClient & {
  emitTick: (q: [string, number, number, number][]) => void; subLog: string[][];
} {
  const tickHandlers = new Set<(m: unknown) => void>();
  const subLog: string[][] = [];
  const obj = {
    subLog,
    start() { /* noop */ },
    stop() { /* noop */ },
    sub(codes: string[]) { subLog.push(codes); },
    on(type: string, cb: (m: never) => void) {
      if (type === 'tick') tickHandlers.add(cb as unknown as (m: unknown) => void);
      return () => { tickHandlers.delete(cb as unknown as (m: unknown) => void); };
    },
    isOpen: () => true,
    retries: () => 0,
    emitTick(quotes: [string, number, number, number][]) {
      for (const cb of tickHandlers) cb({ t: 'tick', day: 5, tickInDay: 200, phase: 'continuous', quotes });
    },
  };
  return obj as unknown as WsClient & { emitTick: typeof obj.emitTick; subLog: string[][] };
}

const overviewBody: MarketOverview = {
  index: { code: 'IDX:COMP', level: 3123.45, chgPct: 0.0123 },
  sectors: [{ name: '银行', chgPct: 0.02 }, { name: '白酒', chgPct: -0.015 }],
  advancers: 60, decliners: 40, turnover: 123_456_789_00,
  topGainers: [
    { code: '000001', name: '平安银行', chgPct: 0.095, price: 1200 },
    { code: '600519', name: '贵州茅台', chgPct: 0.03, price: 180000 },
  ],
  topLosers: [{ code: '000002', name: '万科A', chgPct: -0.088, price: 900 }],
};

const stocksBody: StockRow[] = [
  { code: '000001', name: '平安银行', sector: '银行', board: 'SZ', status: 'normal', st: false, price: 1200, chgPct: 0.01, volume: 10, turnover: 100 },
  { code: '600519', name: '贵州茅台', sector: '白酒', board: 'SH', status: 'normal', st: false, price: 180000, chgPct: -0.02, volume: 20, turnover: 200 },
];

const detailBody: StockDetail = {
  quote: {
    code: '600519', name: '贵州茅台', sector: '白酒', board: '主板', status: 'normal',
    price: 5000, prevClose: 4944, chgPct: 0.01132686084142395,
    volume: 1_234_500, turnover: 2_097_000_00, limitUp: 5438, limitDown: 4450,
  },
  reports: [], dividends: [], news: [], fundamental: { eps: 12.5, pe: 13.59 },
};

const meBody: MeView = {
  user: alice,
  valuation: { cashAvailable: 1_089_111, cashFrozen: 0, positionsValue: 0,
    loansOutstanding: 0, totalAssets: 1_089_111, totalInflow: 1_089_111, returnPct: 0 },
  positions: [],
  work: { busyUntil: 0, shift: null, course: null },
};

const healthBody: HealthView = { ok: true, day: 5, lastTick: 119 };

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubRoutes(map: Record<string, unknown> = {}): void {
  const routes: Record<string, unknown> = {
    '/api/market/overview': overviewBody,
    '/api/stocks': { stocks: stocksBody },
    '/api/news': { items: [] as NewsRow[], nextBefore: null },
    '/api/me': meBody,
    '/healthz': healthBody,
    '/api/stocks/600519': detailBody,
    '/api/stocks/600519/candles': { code: '600519', type: 'tick', day: 5, candles: [{ tick: 0, price: 5000, volume: 100 }] },
    ...map,
  };
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.split('?')[0] ?? url;
    const hit = routes[path];
    if (hit === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(json(hit));
  });
}

function renderMarket(c: WsClient) {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={['/market']}>
        <RealtimeProvider client={c}>
          <Market />
        </RealtimeProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
}

function renderStock(c: WsClient, code = '600519') {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={[`/market/${code}`]}>
        <RealtimeProvider client={c}>
          <Routes>
            <Route path="/market/:code" element={<Stock />} />
          </Routes>
        </RealtimeProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
}

// 股票列表里按代码取一行的价格 / 涨跌幅。
//
// ⚠️ 必须**限定在 `.slist` 内**：同一只股票会同时出现在涨跌榜（`.movers`）与
// 股票列表（`.slist`）里，同一价格文本在页面上出现两次，`findByText` 会直接报
// "Found multiple elements"。这类歧义不是测试噪音，而是页面真实结构的反映。
function slistRowText(code: string): HTMLElement | null {
  const rows = Array.from(document.querySelectorAll('.slist .srow'));
  return (rows.find(el => el.textContent?.includes(code)) as HTMLElement | undefined) ?? null;
}
function slistPrice(code: string): string | null {
  const cell = slistRowText(code)?.querySelector('.srow__price');
  // ⚠️ `.srow__price` 里除了价格还有一个 `.srow__sub`（成交额紧凑显示），
  // 直接读 textContent 会把两者拼在一起（`¥1,800.001.23万`）。
  // 价格是第一个文本节点，取它就够。
  const first = cell?.firstChild;
  return first?.nodeType === Node.TEXT_NODE ? (first.textContent ?? null) : null;
}
function slistChg(code: string): string | null {
  return slistRowText(code)?.querySelector('.srow__chg')?.textContent ?? null;
}

describe('Market 实时接线', () => {
  it('订阅全市场代码（排除指数 —— 服务端恒推）', async () => {
    const c = fakeClient();
    stubRoutes();
    renderMarket(c);
    await screen.findByText('3,123.45');
    await waitFor(() => {
      const last = c.subLog.at(-1) ?? [];
      expect(last).toContain('000001');
      expect(last).toContain('600519');
      expect(last).not.toContain('IDX:COMP');
    });
  });

  it('指数涨跌随 tick 更新（chgBp=200 → +2.00%）', async () => {
    const c = fakeClient();
    stubRoutes();
    renderMarket(c);
    const el = await screen.findByTestId('index-chg');
    expect(el.textContent).toBe('+1.23%');
    act(() => { c.emitTick([['IDX:COMP', 10_200, 200, 0]]); });
    await waitFor(() => expect(screen.getByTestId('index-chg').textContent).toBe('+2.00%'));
  });

  it('⚠️ 指数点位不随 tick 变 —— WS 指数行的 price 是 10000+chgBp，不是点位', async () => {
    const c = fakeClient();
    stubRoutes();
    renderMarket(c);
    await screen.findByText('3,123.45');
    act(() => { c.emitTick([['IDX:COMP', 10_200, 200, 0]]); });
    // 若误把 live.price 当点位，这里会显示 10,200.00
    expect(screen.getByText('3,123.45')).toBeInTheDocument();
    expect(screen.queryByText('10,200.00')).toBeNull();
  });

  it('股票列表价格随 tick 更新', async () => {
    const c = fakeClient();
    stubRoutes();
    renderMarket(c);
    await screen.findByTestId('stock-list');
    // 快照：茅台 ¥1,800.00（180000 分）
    expect(slistPrice('600519')).toBe('¥1,800.00');
    act(() => { c.emitTick([['600519', 185_000, 300, 99]]); });
    await waitFor(() => expect(slistPrice('600519')).toBe('¥1,850.00'));
  });

  it('股票列表涨跌幅随 tick 更新（chgBp=300 → +3.00%）', async () => {
    const c = fakeClient();
    stubRoutes();
    renderMarket(c);
    await screen.findByTestId('stock-list');
    // 快照：茅台 −2.00%
    expect(slistChg('600519')).toBe('-2.00%');
    act(() => { c.emitTick([['600519', 185_000, 300, 99]]); });
    await waitFor(() => expect(slistChg('600519')).toBe('+3.00%'));
  });

  it('涨跌榜价格随 tick 更新', async () => {
    const c = fakeClient();
    stubRoutes();
    renderMarket(c);
    await screen.findByTestId('movers');
    act(() => { c.emitTick([['600519', 185_000, 300, 99]]); });
    // 榜单里茅台快照价 ¥1,800.00 → tick 后 ¥1,850.00（限定在榜单内，避免与股票列表同值歧义）
    await waitFor(() => {
      const prices = Array.from(document.querySelectorAll('[data-testid="movers"] .movers__price'))
        .map(el => el.textContent);
      expect(prices).toContain('¥1,850.00');
      expect(prices).not.toContain('¥1,800.00');
    });
  });

  it('收不到 tick 时回落快照（不显示 ¥0.00）', async () => {
    const c = fakeClient();
    stubRoutes();
    renderMarket(c);
    await screen.findByTestId('stock-list');
    // 派发一个**不含**600519 的 tick
    act(() => { c.emitTick([['000001', 1230, 50, 5]]); });
    expect(slistPrice('600519')).toBe('¥1,800.00');
    // 「未收到本股行情」不得把价格渲染成 0
    expect(slistRowText('600519')?.querySelector('.srow__price')?.textContent).not.toContain('¥0.00');
  });

  it('未连接（client=null）时仍正常渲染快照价', async () => {
    stubRoutes();
    renderMarket(null as unknown as WsClient);
    await screen.findByTestId('stock-list');
    expect(slistPrice('600519')).toBe('¥1,800.00');
  });
});

describe('Stock 实时接线', () => {
  it('订阅本股代码（不订阅就永远收不到这一只的行情）', async () => {
    const c = fakeClient();
    stubRoutes();
    renderStock(c);
    await screen.findByText('贵州茅台');
    await waitFor(() => expect(c.subLog.flat()).toContain('600519'));
  });

  it('行情头价格随 tick 更新', async () => {
    const c = fakeClient();
    stubRoutes();
    renderStock(c);
    expect(await screen.findByText('¥50.00', { selector: '.stock__price' })).toBeInTheDocument();
    act(() => { c.emitTick([['600519', 5_250, 123, 99]]); });
    expect(await screen.findByText('¥52.50', { selector: '.stock__price' })).toBeInTheDocument();
  });

  it('行情头涨跌幅随 tick 更新（chgBp=123 → +1.23%）', async () => {
    const c = fakeClient();
    stubRoutes();
    renderStock(c);
    // 快照 chgPct=0.0113… → +1.13%
    expect(await screen.findByText('+1.13%')).toBeInTheDocument();
    act(() => { c.emitTick([['600519', 5_250, 123, 99]]); });
    expect(await screen.findByText('+1.23%')).toBeInTheDocument();
  });

  it('实时价上涨时行情头用 up 色（A 股红涨）', async () => {
    const c = fakeClient();
    stubRoutes();
    renderStock(c);
    await screen.findByText('贵州茅台');
    act(() => { c.emitTick([['600519', 5_250, 123, 99]]); });
    await waitFor(() => {
      expect(screen.getByText('¥52.50', { selector: '.stock__price' }).className).toContain('up');
    });
  });

  it('实时价下跌时行情头用 down 色', async () => {
    const c = fakeClient();
    stubRoutes();
    renderStock(c);
    await screen.findByText('贵州茅台');
    act(() => { c.emitTick([['600519', 4_900, -100, 99]]); });
    await waitFor(() => {
      expect(screen.getByText('¥49.00', { selector: '.stock__price' }).className).toContain('down');
    });
  });

  it('⚠️ 平盘（chgBp=0）显示 0.00% 而不是 −100.00%（fmtBp 旧口径陷阱）', async () => {
    const c = fakeClient();
    stubRoutes();
    renderStock(c);
    await screen.findByText('贵州茅台');
    act(() => { c.emitTick([['600519', 5_000, 0, 99]]); });
    expect(await screen.findByText('0.00%')).toBeInTheDocument();
    expect(screen.queryByText('-100.00%')).toBeNull();
  });

  it('收不到本股 tick 时回落快照', async () => {
    const c = fakeClient();
    stubRoutes();
    renderStock(c);
    await screen.findByText('贵州茅台');
    act(() => { c.emitTick([['000001', 1230, 50, 5]]); });
    expect(screen.getByText('¥50.00', { selector: '.stock__price' })).toBeInTheDocument();
  });

  it('未连接时正常渲染快照', async () => {
    stubRoutes();
    renderStock(null as unknown as WsClient);
    expect(await screen.findByText('¥50.00', { selector: '.stock__price' })).toBeInTheDocument();
  });

  it('静态字段（昨收/涨跌停）不随 tick 变 —— WS 不推这些', async () => {
    const c = fakeClient();
    stubRoutes();
    renderStock(c);
    expect(await screen.findByText('¥49.44')).toBeInTheDocument();   // 昨收
    act(() => { c.emitTick([['600519', 5_250, 123, 99]]); });
    expect(screen.getByText('¥49.44')).toBeInTheDocument();
    expect(screen.getByText('¥54.38')).toBeInTheDocument();          // 涨停
  });
});

/** 静默未使用告警（FillMessage 在本文件仅作类型占位）。 */
void (null as unknown as FillMessage);
