import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser, MeView, MarginState, MarginView, MarginLimits } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import Margin from '../src/pages/Margin.js';

// Margin 页数据源：GET /api/margin、GET /api/me、GET /api/stocks/:code（查现价换算数量上限）
//                POST /api/margin/{open,finance,short,sell-repay,buy-cover,repay}
//
// 重点验：
// 1. 未开通：分够给开通按钮、分不够给门槛提示（不给一个点了必然失败的按钮）
// 2. 维持担保比例 `ratioE6 === null` 渲染成「—」，不是 0%
// 3. status='call' 渲染告警横幅
// 4. 数量非整手在本地就拦下（不发请求）
// 5. 错误码 → 中文文案
// 6. 多头给「卖券还款」、空头给「买券还券」

const alice: AuthUser = { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 };

const LIMITS: MarginLimits = {
  initRatioE6: 500_000, financeRateE6: 200, shortRateE6: 250,
  warnRatioE6: 1_500_000, liqRatioE6: 1_300_000,
  minOrderCents: 100_000, maxDebtPerCreditPoint: 200_000,
};

function state(over: Partial<MarginState> = {}): MarginState {
  return {
    open: true, minCredit: 650, eligible: true, credit: 700,
    debt: 0, interest: 0, owedTotal: 0, shortValue: 0, liability: 0,
    cash: 0, positionsValue: 0, collateral: 0,
    ratio: null, ratioE6: null, status: 'ok', canOpen: true,
    warnSinceDay: null, liquidatedCount: 0,
    creditCap: 140_000_000, debtRoom: 140_000_000,
    maxFinanceCents: 5_000_000, maxShortCents: 5_000_000,
    positions: [],
    ...over,
  };
}

const me: MeView = {
  user: alice,
  valuation: { cashAvailable: 10_000_000, cashFrozen: 0, positionsValue: 0,
    loansOutstanding: 0, totalAssets: 10_000_000, totalInflow: 10_000_000, returnPct: 0 },
  positions: [], work: { busyUntil: 0, shift: null, course: null },
};

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function route(over: {
  state?: Partial<MarginState>;
  price?: number;
  fail?: { url: string; status: number; code: string };
  calls?: { url: string; body: unknown }[];
} = {}) {
  const st = state(over.state);
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (over.calls !== undefined) {
      over.calls.push({ url: `${method} ${url}`,
        body: init?.body !== undefined ? JSON.parse(String(init.body)) as unknown : null });
    }
    if (over.fail !== undefined && url === over.fail.url) {
      return Promise.resolve(json({ code: over.fail.code, message: 'nope' }, over.fail.status));
    }
    if (url === '/api/margin') return Promise.resolve(json({ state: st, limits: LIMITS } as MarginView));
    if (url === '/api/me') return Promise.resolve(json(me));
    if (url.startsWith('/api/stocks/')) {
      return Promise.resolve(json({ quote: { code: '600000', name: 'X', sector: 'S', board: 'SH',
        status: 'normal', price: over.price ?? 1000, prevClose: 1000, chgPct: 0, volume: 0,
        turnover: 0, limitUp: 1100, limitDown: 900 }, reports: [], dividends: [], news: [],
        fundamental: { eps: 0, pe: 0 } }));
    }
    if (url.startsWith('/api/margin/')) {
      return Promise.resolve(json({ result: {}, state: st }));
    }
    return Promise.resolve(json({ code: 'NOT_FOUND', message: `no stub for ${method} ${url}` }, 404));
  });
}

function renderMargin() {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={['/life/margin']}>
        <Routes><Route path="/life/margin" element={<Margin />} /></Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('Margin 开通引导', () => {
  it('未开通且信誉分不足 → 只给门槛提示，不给开通按钮', async () => {
    route({ state: { open: false, eligible: false, credit: 600 } });
    renderMargin();
    expect(await screen.findByTestId('margin-credit-low')).toHaveTextContent('650');
    expect(screen.queryByTestId('margin-open')).toBeNull();
  });

  it('未开通但信誉分够 → 给开通按钮，点击调 POST /api/margin/open', async () => {
    const calls: { url: string; body: unknown }[] = [];
    route({ state: { open: false, eligible: true }, calls });
    renderMargin();
    fireEvent.click(await screen.findByTestId('margin-open'));
    await waitFor(() => expect(calls.some(c => c.url === 'POST /api/margin/open')).toBe(true));
  });
});

describe('Margin 账户概览', () => {
  it('⚠️ 无负债时维持担保比例显示「—」，不是 0.00%', async () => {
    route({ state: { open: true, ratioE6: null, status: 'ok' } });
    renderMargin();
    expect(await screen.findByTestId('margin-ratio')).toHaveTextContent('—');
    expect(screen.getByTestId('margin-ratio').textContent).not.toContain('0.00%');
  });

  it('有负债时显示百分比与状态徽标；警戒/平仓线随 limits 下发', async () => {
    route({ state: { open: true, ratioE6: 1_800_000, status: 'ok', debt: 2_500_000 } });
    renderMargin();
    expect(await screen.findByTestId('margin-ratio')).toHaveTextContent('180.00%');
    expect(screen.getByTestId('margin-status')).toHaveTextContent('正常');
    expect(screen.getByTestId('margin-debt')).toHaveTextContent('¥25,000.00');
    expect(screen.getByText(/警戒线\s*150\.00%/)).toBeTruthy();
    expect(screen.getByText(/平仓线\s*130\.00%/)).toBeTruthy();
  });

  it('跌破平仓线 → 红色告警横幅 + 「追保中」', async () => {
    route({ state: { open: true, ratioE6: 1_200_000, status: 'call' } });
    renderMargin();
    const alert = await screen.findByTestId('margin-alert');
    expect(alert).toHaveTextContent('强制平仓');
    expect(screen.getByTestId('margin-status')).toHaveTextContent('追保中');
  });

  it('低于警戒线 → 提示不能开新仓，且开仓按钮禁用', async () => {
    route({ state: { open: true, ratioE6: 1_400_000, status: 'warn', canOpen: false } });
    renderMargin();
    expect(await screen.findByTestId('margin-alert')).toHaveTextContent('不能开新仓');
    expect(screen.getByTestId('margin-submit-long')).toBeDisabled();
    expect(screen.getByTestId('margin-submit-short')).toBeDisabled();
  });
});

describe('Margin 开仓', () => {
  it('融资买入：填代码与整手数量 → POST /api/margin/finance', async () => {
    const calls: { url: string; body: unknown }[] = [];
    route({ calls });
    renderMargin();
    fireEvent.change(await screen.findByTestId('margin-code-long'), { target: { value: '600000' } });
    fireEvent.change(screen.getByTestId('margin-qty-long'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('margin-submit-long'));
    await waitFor(() => expect(calls.some(c => c.url === 'POST /api/margin/finance')).toBe(true));
    const call = calls.find(c => c.url === 'POST /api/margin/finance');
    expect(call?.body).toEqual({ code: '600000', qty: 1000 });
  });

  it('⚠️ 数量非 100 整数倍 → 本地拦下，不发请求', async () => {
    const calls: { url: string; body: unknown }[] = [];
    route({ calls });
    renderMargin();
    fireEvent.change(await screen.findByTestId('margin-code-short'), { target: { value: '600000' } });
    fireEvent.change(screen.getByTestId('margin-qty-short'), { target: { value: '150' } });
    fireEvent.click(screen.getByTestId('margin-submit-short'));
    expect(await screen.findByText(/100 股的整数倍/)).toBeTruthy();
    expect(calls.some(c => c.url === 'POST /api/margin/short')).toBe(false);
  });

  it('代码不是 6 位数字 → 本地拦下', async () => {
    const calls: { url: string; body: unknown }[] = [];
    route({ calls });
    renderMargin();
    fireEvent.change(await screen.findByTestId('margin-code-long'), { target: { value: 'ABC' } });
    fireEvent.change(screen.getByTestId('margin-qty-long'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('margin-submit-long'));
    expect(await screen.findByText('请输入 6 位股票代码')).toBeTruthy();
    expect(calls.some(c => c.url === 'POST /api/margin/finance')).toBe(false);
  });

  it('查到现价后把「金额上限」翻译成「最多 N 股」', async () => {
    // 上限 5,000,000 分 ÷ 1000 分/股 = 5000 股
    route({ price: 1000 });
    renderMargin();
    fireEvent.change(await screen.findByTestId('margin-code-long'), { target: { value: '600000' } });
    await waitFor(() => expect(screen.getByTestId('margin-cap-long')).toHaveTextContent('最多 5,000 股'));
  });

  it('服务端拒绝 → 错误码翻成中文（MARGIN_CALL）', async () => {
    route({ fail: { url: '/api/margin/finance', status: 403, code: 'MARGIN_CALL' } });
    renderMargin();
    fireEvent.change(await screen.findByTestId('margin-code-long'), { target: { value: '600000' } });
    fireEvent.change(screen.getByTestId('margin-qty-long'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('margin-submit-long'));
    expect(await screen.findByRole('status')).toHaveTextContent('维持担保比例低于警戒线，暂不能开新仓');
  });
});

describe('Margin 信用持仓', () => {
  it('多头给「卖券还款」、空头给「买券还券」', async () => {
    route({
      state: {
        open: true,
        positions: [
          { code: '600000', name: '甲股', kind: 'long', qty: 1000, cost: 1_000_000,
            price: 1100, marketValue: 1_100_000, pnl: 100_000, pnlPct: 0.1, frozen: 0, openedDay: 1 },
          { code: '600001', name: '乙股', kind: 'short', qty: 500, cost: 500_000,
            price: 900, marketValue: 450_000, pnl: 50_000, pnlPct: 0.1, frozen: 750_000, openedDay: 2 },
        ],
      },
    });
    renderMargin();
    await screen.findByTestId('margin-positions');
    const rows = screen.getAllByTestId('margin-position');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('融资买入');
    expect(rows[0]).toHaveTextContent('卖券还款');
    expect(rows[1]).toHaveTextContent('融券卖出');
    expect(rows[1]).toHaveTextContent('买券还券');
    // 空头才显示冻结担保金
    expect(rows[1]).toHaveTextContent('¥7,500.00');
  });

  it('了结数量留空 = 全部（提交整仓股数）', async () => {
    const calls: { url: string; body: unknown }[] = [];
    route({ calls, state: { open: true, positions: [
      { code: '600000', name: '甲股', kind: 'long', qty: 1000, cost: 1_000_000,
        price: 1000, marketValue: 1_000_000, pnl: 0, pnlPct: 0, frozen: 0, openedDay: 1 }] } });
    renderMargin();
    fireEvent.click(await screen.findByTestId('close-position'));
    await waitFor(() => expect(calls.some(c => c.url === 'POST /api/margin/sell-repay')).toBe(true));
    const call = calls.find(c => c.url === 'POST /api/margin/sell-repay');
    expect(call?.body).toEqual({ code: '600000', qty: 1000 });
  });

  it('无信用持仓 → 空态文案', async () => {
    route({ state: { open: true, positions: [] } });
    renderMargin();
    expect(await screen.findByText('暂无信用持仓')).toBeTruthy();
  });
});

describe('Margin 还款', () => {
  it('超过可用资金 → 本地拦下', async () => {
    const calls: { url: string; body: unknown }[] = [];
    route({ calls, state: { open: true, debt: 5_000_000, owedTotal: 5_000_000 } });
    renderMargin();
    fireEvent.change(await screen.findByTestId('margin-repay-amount'), { target: { value: '999999' } });
    fireEvent.click(screen.getByTestId('margin-repay'));
    expect(await screen.findByText(/超过可用资金/)).toBeTruthy();
    expect(calls.some(c => c.url === 'POST /api/margin/repay')).toBe(false);
  });

  it('正常金额 → POST /api/margin/repay（元 → 分）', async () => {
    const calls: { url: string; body: unknown }[] = [];
    route({ calls, state: { open: true, debt: 5_000_000, owedTotal: 5_000_000 } });
    renderMargin();
    fireEvent.change(await screen.findByTestId('margin-repay-amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('margin-repay'));
    await waitFor(() => expect(calls.some(c => c.url === 'POST /api/margin/repay')).toBe(true));
    expect(calls.find(c => c.url === 'POST /api/margin/repay')?.body).toEqual({ amount: 10_000 });
  });
});
