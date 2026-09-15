import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, useRoutes } from 'react-router-dom';
import type { AuthUser } from '../src/api.js';
import { SessionProvider, type Session } from '../src/session.js';
import { routes } from '../src/routes.js';
import App from '../src/App.js';

// 路由守卫的行为必须先于页面实现固化：未登录不得看到任何业务页，
// 非管理员不得进入 /admin（显示 403 而非静默跳转）。

const alice: AuthUser = { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 };
const root: AuthUser = { id: 2, username: 'root', credit: 900, isAdmin: true, bankruptCount: 0 };

const authed = (u: AuthUser): Session => ({ status: 'authed', user: u });

/** 用与生产完全相同的路由表渲染指定路径。 */
function RoutesUnderTest(): React.JSX.Element | null {
  return useRoutes(routes);
}

function renderAt(path: string, session: Session) {
  return render(
    <SessionProvider initial={session}>
      <MemoryRouter initialEntries={[path]}>
        <RoutesUnderTest />
      </MemoryRouter>
    </SessionProvider>,
  );
}

// 页面占位与底部 Tab 会显示同名文字（如「首页」既是页面也是 Tab 标签），
// 故断言页面内容时要限定在 .page-placeholder 内，否则会命中多个节点。
function placeholderText(): string | null {
  const el = document.querySelector('.page-placeholder');
  return el === null ? null : el.textContent;
}

// 顶部标题栏的标题（区分页面占位与 Tab 标签的第三种来源）。
function headerText(): string | null {
  const el = document.querySelector('.appshell__title');
  return el === null ? null : el.textContent;
}

// 首页（Task 3 起为真实页面）会请求 /me 与 /healthz；路由测试只关心守卫与渲染，
// 故统一 stub fetch，避免真实网络调用。
const ME_BODY = {
  user: { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 },
  valuation: { cashAvailable: 0, cashFrozen: 0, positionsValue: 0, loansOutstanding: 0,
    totalAssets: 0, totalInflow: 0, returnPct: 0 },
  positions: [],
  work: { busyUntil: 0, shift: null, course: null },
};

const OVERVIEW_BODY = {
  index: { code: 'IDX:COMP', level: 3123.45, chgPct: 0.01 },
  sectors: [], advancers: 0, decliners: 0, turnover: 0,
  topGainers: [], topLosers: [],
};

// 生活 Tab（Task 6）的三个子页各有自己的数据源，这里给最小可用桩，
// 让「/life 已实现为真实页面」可以被路由测试断言（而不是靠占位文案）。
const LIFE_BODIES: Record<string, unknown> = {
  '/api/jobs': { jobs: [] },
  '/api/shifts': { shifts: [] },
  '/api/abilities': { abilities: {}, kinds: [], nextCourseCost: {} },
  // ⚠️ `room` 是**必填**的（服务端 borrowRoom() 的下发形状）：银行页的可借上限只能取它，
  //    不返回会让页面在渲染期炸掉。桩要跟着契约走，别让页面去兜底 ——
  //    兜底只会把「契约破了」变成「静默显示 ¥0.00」，更难查。
  '/api/bank/products': { credit: 700, creditLow: false, products: [],
    room: { capCents: 0, creditRoom: 0, leverageRoom: 0, room: 0, binding: 'credit',
      leverageCap: 0, divisor: 300, netWorth: 0, openPrincipal: 0, loansOutstanding: 0 } },
  '/api/bank/loans': { credit: 700, loans: [] },
  '/api/credit': { credit: 700, events: [] },
  // ⚠️ `state` 与 `limits` 都是**必填**的（服务端 /api/margin 的下发形状）。
  //    少发 `state` 会让融资页在渲染期直接抛 TypeError（深链用例会红成一片噪声），
  //    而不是优雅降级 —— 这是刻意的：契约破了就该炸，别让页面兜底成「静默显示 0」。
  '/api/margin': {
    state: { open: false, minCredit: 650, eligible: true, credit: 700,
      debt: 0, interest: 0, owedTotal: 0, shortValue: 0, liability: 0,
      cash: 0, positionsValue: 0, collateral: 0, ratio: null, ratioE6: null,
      status: 'ok', canOpen: false, warnSinceDay: null, liquidatedCount: 0,
      creditCap: 0, debtRoom: 0, maxFinanceCents: 0, maxShortCents: 0, positions: [] },
    limits: { initRatioE6: 500_000, financeRateE6: 200, shortRateE6: 250,
      warnRatioE6: 1_500_000, liqRatioE6: 1_300_000,
      minOrderCents: 100_000, maxDebtPerCreditPoint: 200_000 },
  },
};

// 榜单（Task 7）与我的 Tab 的分页表也需要最小桩。
const TASK7_BODIES: Record<string, unknown> = {
  '/api/leaderboard': { by: 'total', rows: [] },
  '/api/orders': { items: [], nextBefore: null },
  '/api/trades': { items: [], nextBefore: null },
  '/api/ledger': { items: [], nextBefore: null },
};

beforeEach(() => {
  vi.restoreAllMocks();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.split('?')[0] ?? url;
    let body: unknown = ME_BODY;
    if (url.includes('/healthz')) body = { ok: true, day: 1, lastTick: 0 };
    else if (path === '/api/market/overview') body = OVERVIEW_BODY;
    else if (path === '/api/stocks') body = { stocks: [] };
    else if (path === '/api/news') body = { items: [], nextBefore: null };
    else if (LIFE_BODIES[path] !== undefined) body = LIFE_BODIES[path];
    else if (TASK7_BODIES[path] !== undefined) body = TASK7_BODIES[path];
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' } }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('未登录守卫', () => {
  it('anonymous 访问 / → 重定向到登录页，不渲染首页', async () => {
    renderAt('/', { status: 'anonymous' });
    expect(await screen.findByText('大布偶证券交易所')).toBeInTheDocument();
    expect(screen.getByText('登录')).toBeInTheDocument();
    expect(screen.queryByText('首页')).toBeNull();
  });

  it('anonymous 访问 /market → 同样落到登录页', async () => {
    renderAt('/market', { status: 'anonymous' });
    expect(await screen.findByText('登录')).toBeInTheDocument();
    expect(screen.queryByText('行情')).toBeNull();
  });

  it('loading 态不渲染登录页（避免闪一下又跳走）', () => {
    renderAt('/', { status: 'loading' });
    expect(screen.queryByText('登录')).toBeNull();
    expect(screen.getByText('加载中…')).toBeInTheDocument();
  });
});

describe('登录后放行', () => {
  it('authed 访问 / → 渲染首页（已实现，非占位）与底部 Tab', async () => {
    renderAt('/', authed(alice));
    await screen.findByText('首页', { selector: '.tabbar__label' });
    // 顶部标题栏是稳定信号：首页已实现为真实页面，不再是 .page-placeholder
    expect(headerText()).toBe('大布偶证券交易所');
    // 底部 Tab 六项齐全（2026-09-15 起「新闻」提升为一等板块，与行情并列）
    for (const l of ['行情', '新闻', '生活', '榜单', '我的']) {
      expect(screen.getByText(l, { selector: '.tabbar__label' })).toBeInTheDocument();
    }
  });

  it('authed 访问 /news → 渲染每日新闻板块（已实现，非占位）', async () => {
    renderAt('/news', authed(alice));
    await screen.findByText('新闻', { selector: '.tabbar__label' });
    // 卡片标题是稳定信号；且必须是**独立板块**而不是被踢回首页
    expect(await screen.findByText('每日新闻')).toBeInTheDocument();
    expect(document.querySelector('.page-placeholder')).toBeNull();
  });

  it('authed 访问 /market → 渲染行情页（已实现，非占位）', async () => {
    renderAt('/market', authed(alice));
    await screen.findByText('行情', { selector: '.tabbar__label' });
    // 行情页已实现：出现「大盘指数」卡片标题而非 .page-placeholder
    expect(await screen.findByText('大盘指数')).toBeInTheDocument();
    expect(document.querySelector('.page-placeholder')).toBeNull();
  });

  it('authed 访问 /life → 渲染生活 Tab（已实现，非占位），默认落到「打工」', async () => {
    renderAt('/life', authed(alice));
    await screen.findByText('生活', { selector: '.tabbar__label' });
    // 三个子域的分段控件是稳定信号；/life 无子路径时 index 路由重定向到 work
    expect(await screen.findByText('职业列表')).toBeInTheDocument();
    for (const l of ['打工', '能力', '银行', '借贷', '融资']) {
      expect(screen.getByText(l, { selector: '.segtabs__item' })).toBeInTheDocument();
    }
    expect(document.querySelector('.page-placeholder')).toBeNull();
  });

  it('/life/bank 可直接深链进入银行子页（子路由保留可分享性）', async () => {
    renderAt('/life/bank', authed(alice));
    expect(await screen.findByText('授信概览')).toBeInTheDocument();
    expect(screen.getByTestId('life-tab-bank')).toHaveClass('is-active');
  });

  it('/life/margin 可直接深链进入融资融券子页', async () => {
    // 杠杆是独立子域（有担保的信用交易），与「银行」（无抵押信用贷）、
    // 「借贷」（玩家对玩家）并列；深链必须能直达，否则分享出去的链接会落到打工页。
    renderAt('/life/margin', authed(alice));
    // 桩里 state.open=false，故落点是开通引导卡（不是「落到了打工页」）
    expect(await screen.findByTestId('margin-open')).toBeInTheDocument();
    expect(screen.getByTestId('life-tab-margin')).toHaveClass('is-active');
  });

  it('authed 访问 /leaderboard → 渲染榜单页（已实现，非占位）', async () => {
    renderAt('/leaderboard', authed(alice));
    await screen.findByText('榜单', { selector: '.tabbar__label' });
    // 榜单页已实现：出现「总资产榜」卡片标题而非 .page-placeholder
    expect(await screen.findByText('总资产榜')).toBeInTheDocument();
    expect(document.querySelector('.page-placeholder')).toBeNull();
  });

  it('authed 访问 /me → 渲染我的 Tab（已实现，非占位），默认落到「资料」', async () => {
    renderAt('/me', authed(alice));
    await screen.findByText('我的', { selector: '.tabbar__label' });
    // 四个子域的分段控件是稳定信号；/me 无子路径时 index 路由重定向到 profile
    expect(await screen.findByTestId('pw-form')).toBeInTheDocument();
    for (const l of ['资料', '委托', '成交', '流水']) {
      expect(screen.getByText(l, { selector: '.segtabs__item' })).toBeInTheDocument();
    }
    expect(document.querySelector('.page-placeholder')).toBeNull();
  });

  it('/me/ledger 可直接深链进入流水子页', async () => {
    renderAt('/me/ledger', authed(alice));
    expect(await screen.findByText('资金流水')).toBeInTheDocument();
    expect(screen.getByTestId('me-tab-ledger')).toHaveClass('is-active');
  });
});

describe('管理员守卫', () => {
  it('非管理员访问 /admin → 403 文案，不渲染后台', async () => {
    renderAt('/admin', authed(alice));
    expect(await screen.findByText('无权限访问管理后台')).toBeInTheDocument();
    expect(placeholderText()).toBeNull();
  });

  it('管理员访问 /admin → 正常渲染后台', async () => {
    renderAt('/admin', authed(root));
    await screen.findByText('管理后台', { selector: '.appshell__title' });
    // Task 9 起 /admin 是真实后台页（不再是 `.page-placeholder` 占位），
    // 故这里改断言后台容器本身已挂载。
    expect(screen.getByTestId('admin-panel')).toBeInTheDocument();
    expect(placeholderText()).toBeNull();
  });
});

describe('App 根组件', () => {
  it('注入 authed 会话时直接进入首页外壳（会话来自注入，无需探测）', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App initialSession={authed(alice)} />
      </MemoryRouter>,
    );
    await screen.findByText('首页', { selector: '.tabbar__label' });
    expect(headerText()).toBe('大布偶证券交易所');
  });

  it('注入 anonymous 会话时渲染登录页', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App initialSession={{ status: 'anonymous' }} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('登录')).toBeInTheDocument();
  });
});
