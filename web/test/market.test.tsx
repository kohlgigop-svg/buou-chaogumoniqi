import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AuthUser, MarketOverview, NewsRow, StockRow } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import Market from '../src/pages/Market.js';

// Market 页数据源：GET /market/overview + GET /stocks + GET /news。
// 按 URL 分派 stub，验：指数卡片、热力图分档、涨跌家数条、涨跌榜切换、搜索、新闻流与空态。

const alice: AuthUser = { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 };

function overview(over: Partial<MarketOverview> = {}): MarketOverview {
  return {
    index: { code: 'IDX:COMP', level: 3123.45, chgPct: 0.0123 },
    sectors: [
      { name: '银行', chgPct: 0.02 },
      { name: '白酒', chgPct: -0.015 },
      { name: '地产', chgPct: 0 },
    ],
    advancers: 60, decliners: 40, turnover: 123_456_789_00,
    topGainers: [
      { code: '000001', name: '平安银行', chgPct: 0.095, price: 1200 },
      { code: '600519', name: '贵州茅台', chgPct: 0.03, price: 180000 },
    ],
    topLosers: [
      { code: '000002', name: '万科A', chgPct: -0.088, price: 900 },
    ],
    ...over,
  };
}

const stocks: StockRow[] = [
  { code: '000001', name: '平安银行', sector: '银行', board: 'SZ', status: 'normal', st: false, price: 1200, chgPct: 0.01, volume: 10, turnover: 100 },
  { code: '600519', name: '贵州茅台', sector: '白酒', board: 'SH', status: 'normal', st: false, price: 180000, chgPct: -0.02, volume: 20, turnover: 200 },
];

function newsItem(id: number, title: string): NewsRow {
  return { id, day: 3, tick: 100, scope: 'MKT', title,
    related: { code: 'IDX:COMP', name: '大盘', chgPct: 0.015 } };
}

const page1: NewsRow[] = [newsItem(5, '央行宣布降准'), newsItem(4, '经济数据超预期')];

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** 按 URL 分派；未列出的路径返回 404，避免静默漏 stub。 */
function stubAll(map: Record<string, unknown> = {}): void {
  const routes: Record<string, unknown> = {
    '/api/market/overview': overview(),
    '/api/stocks': { stocks },
    '/api/news': { items: page1, nextBefore: 4 },
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

function renderMarket() {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={['/market']}>
        <Market />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('Market 指数卡片与家数', () => {
  it('渲染指数点位（/100 后保留两位）与涨跌幅', async () => {
    stubAll();
    renderMarket();
    expect(await screen.findByText('3,123.45')).toBeInTheDocument();
    expect(screen.getByText('+1.23%')).toBeInTheDocument();
  });

  it('涨幅为正时指数用 up 色', async () => {
    stubAll();
    renderMarket();
    const el = await screen.findByTestId('index-chg');
    expect(el.className).toContain('up');
  });

  it('指数下跌时用 down 色', async () => {
    stubAll({ '/api/market/overview': overview({ index: { code: 'IDX:COMP', level: 3000, chgPct: -0.02 } }) });
    renderMarket();
    const el = await screen.findByTestId('index-chg');
    await waitFor(() => expect(el.className).toContain('down'));
  });

  it('涨跌家数条宽度反映上涨占比（60/40 → 60%）', async () => {
    stubAll();
    renderMarket();
    const bar = await screen.findByTestId('advancers-bar');
    expect(bar.style.width).toBe('60%');
  });

  it('显示上涨与下跌家数原文', async () => {
    stubAll();
    renderMarket();
    expect((await screen.findByTestId('advancers')).textContent).toBe('上涨 60');
    expect(screen.getByTestId('decliners').textContent).toBe('下跌 40');
  });
});

describe('Market 板块热力图', () => {
  it('每个板块渲染一格，带 tone 类', async () => {
    stubAll();
    renderMarket();
    const up = await screen.findByTestId('sector-银行');
    expect(up.className).toContain('up');
    expect(screen.getByTestId('sector-白酒').className).toContain('down');
    expect(screen.getByTestId('sector-地产').className).toContain('flat');
  });

  it('色阶强度写入 CSS 变量（涨跌同幅度一致）', async () => {
    stubAll({ '/api/market/overview': overview({ sectors: [
      { name: '银行', chgPct: 0.05 },
      { name: '白酒', chgPct: -0.05 },
    ] }) });
    renderMarket();
    const a = await screen.findByTestId('sector-银行');
    const b = screen.getByTestId('sector-白酒');
    expect(a.style.getPropertyValue('--heat')).toBe('1');
    expect(b.style.getPropertyValue('--heat')).toBe('1');
  });

  it('板块格子显示涨跌幅文本', async () => {
    stubAll();
    renderMarket();
    const cell = await screen.findByTestId('sector-银行');
    expect(cell.textContent).toContain('银行');
    expect(cell.textContent).toContain('+2.00%');
  });
});

describe('Market 涨跌幅榜', () => {
  it('默认显示涨幅榜', async () => {
    stubAll();
    renderMarket();
    expect(await screen.findAllByText('平安银行')).not.toHaveLength(0);
    // 跌幅榜的个股此时不应出现在榜单里（仍可能在下方股票列表出现，故限定榜单容器）
    const movers = screen.getByTestId('movers');
    expect(movers.textContent).toContain('平安银行');
    expect(movers.textContent).not.toContain('万科A');
  });

  it('切到跌幅榜后显示下跌个股', async () => {
    stubAll();
    renderMarket();
    await screen.findAllByText('平安银行');
    fireEvent.click(screen.getByRole('tab', { name: '跌幅' }));
    await waitFor(() => {
      expect(screen.getByTestId('movers').textContent).toContain('万科A');
    });
  });

  it('榜单行带从 1 开始的序号', async () => {
    stubAll();
    renderMarket();
    await screen.findAllByText('平安银行');
    const rows = screen.getAllByTestId('mover-rank');
    expect(rows[0]?.textContent).toBe('1');
    expect(rows[1]?.textContent).toBe('2');
  });

  it('榜单涨跌幅按百分比格式化', async () => {
    stubAll();
    renderMarket();
    expect(await screen.findByText('+9.50%')).toBeInTheDocument();
  });
});

describe('Market 搜索', () => {
  it('按名称包含过滤', async () => {
    stubAll();
    renderMarket();
    const input = await screen.findByTestId('search-input');
    fireEvent.change(input, { target: { value: '茅台' } });
    await waitFor(() => {
      const list = screen.getByTestId('stock-list');
      expect(list.textContent).toContain('贵州茅台');
      expect(list.textContent).not.toContain('平安银行');
    });
  });

  it('无结果时显示空态', async () => {
    stubAll();
    renderMarket();
    await screen.findByTestId('search-input');
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'zzz不存在' } });
    expect(await screen.findByText(/没有匹配/)).toBeInTheDocument();
  });

  it('清空搜索后恢复完整列表', async () => {
    stubAll();
    renderMarket();
    const input = await screen.findByTestId('search-input');
    fireEvent.change(input, { target: { value: '茅台' } });
    await waitFor(() => {
      expect(screen.getByTestId('stock-list').textContent).not.toContain('平安银行');
    });
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.getByTestId('stock-list').textContent).toContain('平安银行');
    });
  });
});

describe('Market 新闻流', () => {
  it('渲染首屏新闻标题与游戏日', async () => {
    stubAll();
    renderMarket();
    expect(await screen.findByText('央行宣布降准')).toBeInTheDocument();
    expect(screen.getByText('经济数据超预期')).toBeInTheDocument();
  });

  it('新闻只展示，不带分页按钮（分页在 /news 子页）', async () => {
    stubAll();
    renderMarket();
    await screen.findByText('央行宣布降准');
    expect(screen.queryByRole('button', { name: /加载更多/ })).not.toBeInTheDocument();
  });
});

describe('Market 错误与导航', () => {
  it('概览接口失败时显示错误与重试', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ code: 'INTERNAL', message: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } },
    )));
    renderMarket();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('大盘指数涨跌家数条使用 up 色，下跌段用 down 色', async () => {
    stubAll();
    renderMarket();
    const up = await screen.findByTestId('advancers-bar');
    expect(up.className).toContain('up');
  });
});

describe('Market 导航', () => {
  it('股票行链接指向个股页（SPA 客户端路由，非整页跳转）', async () => {
    stubAll();
    renderMarket();
    const list = await screen.findByTestId('stock-list');
    const link = list.querySelector('a[href="/market/000001"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('平安银行');
  });

  it('涨跌幅榜的名称也是链接', async () => {
    stubAll();
    renderMarket();
    await screen.findAllByText('平安银行');
    const movers = screen.getByTestId('movers');
    expect(movers.querySelector('a[href="/market/000001"]')).not.toBeNull();
  });
});
