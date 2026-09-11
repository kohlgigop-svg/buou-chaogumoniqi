import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MeView, AuthUser } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import Home from '../src/pages/Home.js';

// 首页数据源只有 GET /me 一处，故直接 stub fetch 返回构造的 MeView。
// 重点验：数值格式化正确、信誉分档位取色、空持仓不崩、进行中班次/课程渲染。

const alice: AuthUser = { id: 1, username: 'alice', credit: 720, isAdmin: false, bankruptCount: 0 };

function meView(over: Partial<MeView> = {}, credit = 720): MeView {
  return {
    user: { ...alice, credit },
    valuation: {
      cashAvailable: 10_915_999, cashFrozen: 84_001, positionsValue: 2_000_000,
      loansOutstanding: 1_000_000, totalAssets: 12_000_000, totalInflow: 10_000_000,
      returnPct: 0.2,
    },
    positions: [],
    work: { busyUntil: 0, shift: null, course: null },
    ...over,
  };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

function stubMe(view: MeView): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
}

function renderHome() {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={['/']}>
        <Home />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('Home 资产概览', () => {
  it('渲染四张卡片的金额（分 → ¥ 格式化）', async () => {
    stubMe(meView());
    renderHome();
    // 持仓市值 2,000,000 分 = ¥20,000.00
    expect(await screen.findByText('¥20,000.00')).toBeInTheDocument();
    // 可用资金 10,915,999 分 = ¥109,159.99
    expect(screen.getByText('¥109,159.99')).toBeInTheDocument();
    // 负债 1,000,000 分 = ¥10,000.00
    expect(screen.getByText('¥10,000.00')).toBeInTheDocument();
  });

  it('总资产与累计收益率按口径渲染', async () => {
    stubMe(meView());
    renderHome();
    // 总资产 12,000,000 分 = ¥120,000.00
    expect(await screen.findByText('¥120,000.00')).toBeInTheDocument();
    // 服务端未回 todayPnl 时回落显示累计收益率
    expect(screen.getByText(/累计收益\s*\+20\.00%/)).toBeInTheDocument();
  });

  it('提供 todayPnl 时主位改为「今日盈亏」，累计收益率降为脚注', async () => {
    stubMe(meView({ todayPnl: { positionPnl: 1_230, cashFlow: -881, total: 349 } }));
    renderHome();
    await screen.findByText('¥120,000.00');
    // 今日 +¥3.49（349 分）
    expect(screen.getByTestId('today-pnl')).toHaveTextContent('今日 +¥3.49');
    // 拆解写清两部分，避免「持仓赚了但总数变小」的困惑
    expect(screen.getByTestId('today-pnl-breakdown'))
      .toHaveTextContent('持仓 +¥12.30 · 现金 -¥8.81');
    // 累计收益率仍在，但不再是主位
    expect(screen.getByText(/\+20\.00%/)).toBeInTheDocument();
  });

  it('⚠️ 今日盈亏为 0 → 灰档 + 「今日暂无变动」而不是空白', async () => {
    stubMe(meView({ todayPnl: { positionPnl: 0, cashFlow: 0, total: 0 } }));
    renderHome();
    const el = await screen.findByTestId('today-pnl');
    expect(el).toHaveTextContent('今日 ¥0.00');
    expect(el.className).toMatch(/flat/);
    expect(screen.getByTestId('today-pnl-breakdown')).toHaveTextContent('今日暂无变动');
  });

  it('今日盈亏为负 → down 档（绿）', async () => {
    stubMe(meView({ todayPnl: { positionPnl: -5_000, cashFlow: 0, total: -5_000 } }));
    renderHome();
    const el = await screen.findByTestId('today-pnl');
    expect(el).toHaveTextContent('今日 -¥50.00');
    expect(el.className).toMatch(/down/);
  });

  it('今日盈亏为正 → up 档（红）', async () => {
    stubMe(meView({ todayPnl: { positionPnl: 0, cashFlow: 12_345, total: 12_345 } }));
    renderHome();
    const el = await screen.findByTestId('today-pnl');
    expect(el.className).toMatch(/up/);
  });

  it('冻结资金非零时额外提示（否则用户会以为钱丢了）', async () => {
    stubMe(meView());
    renderHome();
    // 84,001 分 = ¥840.01，嵌在整句提示里
    expect(await screen.findByText(/冻结\s*¥840\.01/)).toBeInTheDocument();
  });

  it('信誉分按档位取对应样式（720 → good）', async () => {
    stubMe(meView({}, 720));
    renderHome();
    const el = await screen.findByTestId('credit-score');
    expect(el).toHaveTextContent('720');
    expect(el.className).toMatch(/good/);
  });

  it('信誉分 480 → danger 档', async () => {
    stubMe(meView({}, 480));
    renderHome();
    const el = await screen.findByTestId('credit-score');
    expect(el.className).toMatch(/danger/);
  });

  it('信誉分 600 → warning 档', async () => {
    stubMe(meView({}, 600));
    renderHome();
    const el = await screen.findByTestId('credit-score');
    expect(el.className).toMatch(/warning/);
  });
});

describe('Home 无持仓', () => {
  it('空持仓渲染空态，不崩溃也不显示 NaN', async () => {
    stubMe(meView({ positions: [], valuation: {
      cashAvailable: 10_000_000, cashFrozen: 0, positionsValue: 0, loansOutstanding: 0,
      totalAssets: 10_000_000, totalInflow: 10_000_000, returnPct: 0 } }));
    renderHome();
    expect(await screen.findByText(/暂无持仓/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('有持仓时列出代码与浮动盈亏', async () => {
    stubMe(meView({ positions: [{
      code: '600000', name: '浦发银行', qtyTotal: 100, qtySellable: 100,
      costTotal: 1_000_000, avgCost: 10_000, price: 12_000, pnl: 200_000, pnlPct: 0.2 }] }));
    renderHome();
    expect(await screen.findByText('600000')).toBeInTheDocument();
    expect(screen.getByText('浦发银行')).toBeInTheDocument();
    // 浮盈 200,000 分 = +¥2,000.00
    expect(screen.getByText('+¥2,000.00')).toBeInTheDocument();
  });
});

describe('Home 进行中', () => {
  it('无班次无课程时提示为空闲', async () => {
    stubMe(meView());
    renderHome();
    expect(await screen.findByText(/空闲/)).toBeInTheDocument();
  });

  it('有班次时渲染职业名与进度条', async () => {
    stubMe(meView({ work: { busyUntil: 1067, shift: {
      id: 1, job_id: 1, start_gmin: 587, end_gmin: 1067, status: 'working', pay: null }, course: null } }));
    renderHome();
    expect(await screen.findByText(/工作中/)).toBeInTheDocument();
    const bar = screen.getByTestId('shift-progress');
    expect(bar).toHaveAttribute('aria-valuenow');
    const v = Number(bar.getAttribute('aria-valuenow'));
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });

  it('有课程时渲染能力名与进度', async () => {
    stubMe(meView({ work: { busyUntil: 2000, shift: null, course: {
      id: 9, ability: 'EDU', start_gmin: 100, end_gmin: 900, status: 'active' } } }));
    renderHome();
    expect(await screen.findByText(/学习中/)).toBeInTheDocument();
  });
});

describe('Home 错误处理', () => {
  it('/me 失败时显示中文错误而非白屏', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ code: 'INTERNAL', message: 'boom' }),
      { status: 500, headers: { 'content-type': 'application/json' } }));
    renderHome();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('服务器异常，请稍后重试')).toBeInTheDocument();
  });
});
