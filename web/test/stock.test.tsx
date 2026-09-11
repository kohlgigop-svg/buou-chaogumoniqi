import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser, StockDetail, MeView, HealthView } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import Stock from '../src/pages/Stock.js';

// Stock 页数据源：
//   GET /api/stocks/:code    → quote + reports + dividends + news + fundamental
//   GET /api/stocks/:code/candles?type=tick|day
//   GET /api/auth/me         → 可用资金 / 可卖量
//   GET /healthz             → lastTick 推导相位
//
// 重点验：
// 1. 单位口径 —— 价格是「分」，涨跌幅是比例（不是百分数），指数不在此页
// 2. 相位推导 —— (lastTick + 1) % 1200 分档；结算相位必须禁用下单
// 3. 无「今开」伪造 —— 服务端 quote 无 open 字段，页面不得展示该行
// 4. 下单成功 → 提示 + 刷新；下单失败 → 错误码中文映射
// 5. 无持仓 / 有持仓两种展示

const alice: AuthUser = { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 };

// ⚠️ 价格故意取「一手买得起」的量级：现价 ¥50.00（5000 分），一手 100 股 = ¥5,000，
// 远小于 fixture 的可用资金 ¥10,891.11，这样各用例可以放心地填 100 股而不会被
// 「可用资金不足」误拦 —— 否则测的是资金校验，不是被测行为。
// 单独验价格步进/单位的用例会各自覆盖 quote。
const detail: StockDetail = {
  quote: {
    code: '600519', name: '贵州茅台', sector: '白酒', board: '主板', status: 'normal',
    price: 5_000, prevClose: 4_944, chgPct: 0.01132686084142395,
    volume: 1_234_500, turnover: 2_097_000_00,
    limitUp: 5_438, limitDown: 4_450,
  },
  reports: [
    { periodIdx: 3, reportDay: 60, epsE6: 12_500_000, revenue: 88_000_000_00, profit: 21_000_000_00, surpriseE6: 84_200 },
  ],
  dividends: [{ announcedDay: 40, exDay: 45, perShareE6: 2_100_000 }],
  news: [
    { id: 7, day: 5, tick: 60, scope: 'STK', target: '600519', typeId: 'REPORT', title: '一季度业绩预增', impactE6: 84_200 },
  ],
  fundamental: { eps: 12.5, pe: 13.59 },
};

const me: MeView = {
  user: alice,
  valuation: {
    cashAvailable: 1_089_111, cashFrozen: 0, positionsValue: 0,
    loansOutstanding: 0, totalAssets: 1_089_111, totalInflow: 1_089_111, returnPct: 0,
  },
  positions: [],
  work: { busyUntil: 0, shift: null, course: null },
};

const health: HealthView = { ok: true, day: 5, lastTick: 119 };   // +1 = 120 → 连续竞价

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 路由感知的 fetch stub —— 按 URL 分派。
 *
 * ⚠️ 用 `mockResolvedValue`（不是 `mockImplementation`）是刻意的：
 * 与 home/market 测试保持同一套路数，且避免在 jsdom 里出现「同一 promise 被多处消费」的怪象。
 * 需要按 URL 分派时用 `mockImplementation` 返回**新的** Promise 即可，
 * 这里统一走 `Promise.resolve(...)`，每次调用都新建 Response。
 *
 * 顺序很关键：`/api/stocks/:code/candles` 必须排在 `/api/stocks/:code` 之前。
 */
function route(over: {
  detail?: unknown; detailStatus?: number;
  me?: unknown; meStatus?: number;
  candles?: unknown; candlesStatus?: number;
  health?: unknown; healthStatus?: number;
  order?: unknown; orderStatus?: number;
} = {}) {
  const bodies = {
    detail: over.detail ?? detail, detailStatus: over.detailStatus ?? 200,
    me: over.me ?? me, meStatus: over.meStatus ?? 200,
    candles: over.candles ?? { code: '600519', type: 'tick', day: 5, candles: [{ tick: 0, price: 168_000, volume: 100 }] },
    candlesStatus: over.candlesStatus ?? 200,
    health: over.health ?? health, healthStatus: over.healthStatus ?? 200,
    order: over.order ?? { orderId: 42, reused: false }, orderStatus: over.orderStatus ?? 200,
  };
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/candles')) return Promise.resolve(json(bodies.candles, bodies.candlesStatus));
    if (url.includes('/healthz')) return Promise.resolve(json(bodies.health, bodies.healthStatus));
    if (url === '/api/me') return Promise.resolve(json(bodies.me, bodies.meStatus));
    if (url === '/api/orders' && method === 'POST') return Promise.resolve(json(bodies.order, bodies.orderStatus));
    if (url.startsWith('/api/stocks/')) return Promise.resolve(json(bodies.detail, bodies.detailStatus));
    return Promise.resolve(json({ code: 'NOT_FOUND', message: `no stub for ${method} ${url}` }, 404));
  });
}

function renderStock(code = '600519') {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={[`/market/${code}`]}>
        <Routes>
          <Route path="/market/:code" element={<Stock />} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('Stock 首屏', () => {
  it('渲染股票名、代码、板块与价格', async () => {
    route();
    renderStock();
    expect(await screen.findByText('贵州茅台')).toBeInTheDocument();
    expect(screen.getByText('600519')).toBeInTheDocument();
    // 现价 ¥50.00 会同时出现在行情头与盘口「现价」行，故限定在行情头内断言
    expect(screen.getByText('¥50.00', { selector: '.stock__price' })).toBeInTheDocument();
    expect(screen.getByText('白酒 · 主板')).toBeInTheDocument();
  });

  it('涨跌幅按比例渲染为百分数', async () => {
    route();
    renderStock();
    // chgPct = 0.011326860... 是比例不是百分数，应显示 +1.13%
    expect(await screen.findByText('+1.13%')).toBeInTheDocument();
  });

  it('展示昨收、成交量、成交额与涨跌停', async () => {
    route();
    renderStock();
    expect(await screen.findByText('昨收')).toBeInTheDocument();
    expect(screen.getByText('¥49.44')).toBeInTheDocument();
    expect(screen.getByText('涨停')).toBeInTheDocument();
    expect(screen.getByText('¥54.38')).toBeInTheDocument();
    expect(screen.getByText('跌停')).toBeInTheDocument();
    expect(screen.getByText('¥44.50')).toBeInTheDocument();
  });

  it('不展示「今开」——服务端 quote 无 open 字段，不得编造', async () => {
    route();
    renderStock();
    await screen.findByText('贵州茅台');
    expect(screen.queryByText('今开')).toBeNull();
  });

  it('渲染盘口与示意标注', async () => {
    route();
    renderStock();
    expect(await screen.findByText(/示意深度/)).toBeInTheDocument();
    expect(screen.getAllByTestId('depth-ask')).toHaveLength(5);
    expect(screen.getAllByTestId('depth-bid')).toHaveLength(5);
  });

  it('渲染财报与分红行', async () => {
    route();
    renderStock();
    await screen.findByTestId('report-row');
    expect(screen.getByTestId('dividend-row')).toBeInTheDocument();
    // EPS 12.50 与 PE 13.59 用 .stat__value 限定（财报表格里也有两位小数列）
    const stats = Array.from(document.querySelectorAll('.fin__stats .stat__value'))
      .map(el => el.textContent);
    expect(stats).toEqual(['12.50', '13.59']);
  });

  it('渲染相关新闻', async () => {
    route();
    renderStock();
    expect(await screen.findByText('一季度业绩预增')).toBeInTheDocument();
  });

  it('分时数据为空时展示空态，不渲染空坐标框', async () => {
    route({ candles: { code: '600519', type: 'tick', day: 5, candles: [] } });
    renderStock();
    await screen.findByText('贵州茅台');
    expect(await screen.findByTestId('candle-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('candle-chart')).toBeNull();
  });

  it('日K首日无数据时提示「首日尚未收盘」', async () => {
    route({ candles: { code: '600519', type: 'day', candles: [] } });
    renderStock();
    await screen.findByText('贵州茅台');
    expect(await screen.findByText(/首日尚未收盘/)).toBeInTheDocument();
  });

  it('走势数据加载失败时展示失败文案', async () => {
    route({ candlesStatus: 500 });
    renderStock();
    await screen.findByText('贵州茅台');
    expect(await screen.findByText('走势数据加载失败')).toBeInTheDocument();
  });

  it('盘口配色遵循 A 股惯例：卖档（高于现价）红、买档（低于现价）绿', async () => {
    route();
    renderStock();
    await screen.findByTestId('report-row');
    const asks = screen.getAllByTestId('depth-ask');
    const bids = screen.getAllByTestId('depth-bid');
    for (const el of asks) expect(el.querySelector('.depth__price')?.className).toContain('up');
    for (const el of bids) expect(el.querySelector('.depth__price')?.className).toContain('down');
  });

  it('盘口卖档价高于现价、买档价低于现价', async () => {
    route();
    renderStock();
    await screen.findByTestId('report-row');
    const prices = (sel: string) => screen.getAllByTestId(sel)
      .map(el => Number(el.querySelector('.depth__price')?.textContent?.replace(/[¥,]/g, '') ?? '0'));
    const asks = prices('depth-ask');
    const bids = prices('depth-bid');
    // 现价 ¥50.00
    for (const p of asks) expect(p).toBeGreaterThan(50);
    for (const p of bids) expect(p).toBeLessThan(50);
    // 卖档自上而下递减（卖5 最高 → 卖1 最低）
    expect(asks[0]).toBeGreaterThan(asks[4] as number);
    // 买档自上而下递减（买1 最高 → 买5 最低）
    expect(bids[0]).toBeGreaterThan(bids[4] as number);
  });

  it('无持仓时显示「当前无持仓」', async () => {
    route();
    renderStock();
    expect(await screen.findByText('当前无持仓')).toBeInTheDocument();
  });
});

describe('Stock 相位推导', () => {
  it('lastTick=119 → (119+1)%1200=120，属连续竞价，市价单可用', async () => {
    route({ health: { ok: true, day: 5, lastTick: 119 } });
    renderStock();
    await screen.findByText('贵州茅台');
    expect(screen.getByRole('tab', { name: '市价' })).not.toBeDisabled();
  });

  it('lastTick=59 → 60，进入连续竞价边界（>=60 才不是开盘竞价）', async () => {
    route({ health: { ok: true, day: 5, lastTick: 59 } });
    renderStock();
    await screen.findByText('贵州茅台');
    // 60 落在 [60,1160) → continuous
    expect(screen.getByRole('tab', { name: '市价' })).not.toBeDisabled();
  });

  it('lastTick=58 → 59，仍属开盘竞价，市价单禁用', async () => {
    route({ health: { ok: true, day: 5, lastTick: 58 } });
    renderStock();
    await screen.findByText('贵州茅台');
    expect(screen.getByRole('tab', { name: '市价' })).toBeDisabled();
    expect(screen.getByText(/仅支持限价单/)).toBeInTheDocument();
  });

  it('lastTick=1189 → 1190，属结算相位，一律禁止下单', async () => {
    route({ health: { ok: true, day: 5, lastTick: 1189 } });
    renderStock();
    await screen.findByText('贵州茅台');
    // 结算相位下，即使填了合法数量也不能提交
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    expect(screen.getByTestId('submit-order')).toBeDisabled();
    expect(screen.getByText('已收盘结算，暂停交易')).toBeInTheDocument();
  });

  it('lastTick=1159 → 1160，进入收盘竞价，市价单禁用但限价可下', async () => {
    route({ health: { ok: true, day: 5, lastTick: 1159 } });
    renderStock();
    await screen.findByText('贵州茅台');
    expect(screen.getByRole('tab', { name: '市价' })).toBeDisabled();
    // 用「全仓」而不是手填 100 股：现价 ¥1,699 一手要 ¥169,900，远超 fixture 的可用资金，
    // 手填会被「可用资金不足」正确拦下 —— 那验的不是相位。全仓按钮始终落在可买范围内。
    fireEvent.click(screen.getByLabelText('全仓'));
    expect(screen.getByTestId('submit-order')).not.toBeDisabled();
  });

  it('healthz 不可用时回落到连续竞价（不阻塞交易）', async () => {
    route({ healthStatus: 500 });
    renderStock();
    await screen.findByText('贵州茅台');
    expect(screen.getByRole('tab', { name: '市价' })).not.toBeDisabled();
  });
});

describe('Stock 下单', () => {
  it('买入成功后提示已冻结并刷新数据', async () => {
    route();
    renderStock();
    await screen.findByText('贵州茅台');
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    expect(await screen.findByText(/委托已提交/)).toBeInTheDocument();
    expect(screen.getByText(/资金已冻结/)).toBeInTheDocument();
    // 刷新：/api/stocks/:code 至少请求两次（首屏 + 下单后）
    const stockCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/stocks/') && !String(c[0]).includes('/candles'));
    await waitFor(() => expect(stockCalls.length).toBeGreaterThanOrEqual(2));
  });

  it('幂等命中时提示「委托已存在」', async () => {
    route({ order: { orderId: 42, reused: true, frozen: 0 } });
    renderStock();
    await screen.findByText('贵州茅台');
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    expect(await screen.findByText(/幂等命中/)).toBeInTheDocument();
  });

  it('下单失败时把错误码映射为中文', async () => {
    route({ order: { code: 'INSUFFICIENT_CASH', message: 'no cash' }, orderStatus: 400 });
    renderStock();
    await screen.findByText('贵州茅台');
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    expect(await screen.findByText('可用资金不足')).toBeInTheDocument();
  });

  it('提交的价格是「分」——按元输入 50.50 应发出 5050', async () => {
    route();
    renderStock();
    await screen.findByText('贵州茅台');
    fireEvent.change(screen.getByTestId('price-input'), { target: { value: '50.50' } });
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    await screen.findByText(/委托已提交/);
    const orderCall = fetchMock.mock.calls.find(c => String(c[0]) === '/api/orders');
    const body = JSON.parse(String((orderCall?.[1] as RequestInit)?.body));
    expect(body.price).toBe(5_050);
    expect(body.qty).toBe(100);
    expect(body.side).toBe('B');
    expect(body.code).toBe('600519');
    expect(typeof body.clientKey).toBe('string');
    expect(body.clientKey.length).toBeLessThanOrEqual(64);
  });
});

describe('Stock 错误态', () => {
  it('股票不存在时显示错误页', async () => {
    route({ detail: { code: 'STOCK_NOT_FOUND', message: 'no such stock' }, detailStatus: 404 });
    renderStock('999999');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
