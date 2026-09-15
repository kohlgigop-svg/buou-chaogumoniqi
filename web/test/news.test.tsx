import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AuthUser, NewsRow } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import News from '../src/pages/News.js';

// News 页数据源只有 GET /api/news（倒序分页）。
// 重点验：首屏渲染、加载更多追加去重、nextBefore 为 null 时收尾、失败时错误态。

const alice: AuthUser = { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 };

function item(id: number, title: string, over: Partial<NewsRow> = {}): NewsRow {
  return { id, day: 5, tick: 60, scope: 'MKT', title, ...over };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderNews() {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={['/news']}>
        <News />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('News 首屏', () => {
  it('渲染标题与游戏日', async () => {
    fetchMock.mockResolvedValue(json({ items: [item(9, '央行降准'), item(8, '经济超预期')], nextBefore: 8 }));
    renderNews();
    expect(await screen.findByText('央行降准')).toBeInTheDocument();
    expect(screen.getByText('经济超预期')).toBeInTheDocument();
    expect(screen.getAllByText('第 5 日')).toHaveLength(2);
  });

  it('全市场新闻标注为「全市场」', async () => {
    fetchMock.mockResolvedValue(json({ items: [item(1, 't', { scope: 'MKT' })], nextBefore: null }));
    renderNews();
    expect(await screen.findByText('全市场')).toBeInTheDocument();
  });

  it('板块与个股新闻分别标注', async () => {
    fetchMock.mockResolvedValue(json({
      items: [item(2, 'a', { scope: 'SEC' }), item(1, 'b', { scope: 'STK' })], nextBefore: null,
    }));
    renderNews();
    expect(await screen.findByText('板块')).toBeInTheDocument();
    expect(screen.getByText('个股')).toBeInTheDocument();
  });

  it('空列表显示空态', async () => {
    fetchMock.mockResolvedValue(json({ items: [], nextBefore: null }));
    renderNews();
    expect(await screen.findByText('暂无新闻')).toBeInTheDocument();
  });

  it('接口失败显示错误与重试按钮', async () => {
    fetchMock.mockResolvedValue(json({ code: 'INTERNAL', message: 'boom' }, 500));
    renderNews();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('News 分页', () => {
  it('nextBefore 有值时显示「加载更多」', async () => {
    fetchMock.mockResolvedValue(json({ items: [item(9, 'a')], nextBefore: 9 }));
    renderNews();
    expect(await screen.findByRole('button', { name: /加载更多/ })).toBeInTheDocument();
  });

  it('nextBefore 为 null 时不显示「加载更多」', async () => {
    fetchMock.mockResolvedValue(json({ items: [item(9, 'a')], nextBefore: null }));
    renderNews();
    await screen.findByText('a');
    expect(screen.queryByRole('button', { name: /加载更多/ })).not.toBeInTheDocument();
  });

  it('追加下一页并保持倒序', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [item(9, '第一页A'), item(8, '第一页B')], nextBefore: 8 }));
    renderNews();
    await screen.findByText('第一页A');

    fetchMock.mockResolvedValueOnce(json({ items: [item(7, '第二页A')], nextBefore: null }));
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));

    expect(await screen.findByText('第二页A')).toBeInTheDocument();
    const titles = screen.getAllByTestId('news-item').map(n => n.textContent ?? '');
    expect(titles[0]).toContain('第一页A');
    expect(titles[2]).toContain('第二页A');
  });

  it('边界重叠的 id 被去重（服务端 id<before 语义导致必然重叠）', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [item(9, '甲'), item(8, '乙')], nextBefore: 8 }));
    renderNews();
    await screen.findByText('甲');

    // 第二页把 id=8 又返回了一次
    fetchMock.mockResolvedValueOnce(json({ items: [item(8, '乙'), item(7, '丙')], nextBefore: null }));
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));

    await screen.findByText('丙');
    expect(screen.getAllByText('乙')).toHaveLength(1);
    expect(screen.getAllByTestId('news-item')).toHaveLength(3);
  });

  it('翻页请求带上 before 参数（末条 id）', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [item(9, '甲'), item(8, '乙')], nextBefore: 8 }));
    renderNews();
    await screen.findByText('甲');
    fetchMock.mockResolvedValueOnce(json({ items: [], nextBefore: null }));
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(c => String(c[0]));
      expect(calls.some(u => u.includes('before=8'))).toBe(true);
    });
  });
});

describe('News 关联标的的实际涨跌（不是预测值）', () => {
  it('个股新闻：显示标的名 + 当日实际涨跌，且可点进个股详情页', async () => {
    fetchMock.mockResolvedValue(json({
      items: [item(1, '万嘉置业业绩预增', {
        scope: 'STK', related: { code: '000003', name: '万嘉置业', chgPct: 0.015 },
      })], nextBefore: null,
    }));
    renderNews();
    const tag = await screen.findByTestId('news-related');
    expect(tag.textContent).toContain('万嘉置业');
    expect(tag.textContent).toContain('+1.50%');
    expect(tag.querySelector('.news__related-chg')?.className).toContain('up');
    expect(tag.getAttribute('href')).toBe('/market/000003');
  });

  it('下跌用 down 色', async () => {
    fetchMock.mockResolvedValue(json({
      items: [item(1, '利空', { scope: 'STK', related: { code: '000003', name: '甲', chgPct: -0.02 } })],
      nextBefore: null,
    }));
    renderNews();
    const tag = await screen.findByTestId('news-related');
    expect(tag.textContent).toContain('-2.00%');
    expect(tag.querySelector('.news__related-chg')?.className).toContain('down');
  });

  it('板块/大盘没有详情页 → 不是链接（code 为 null）', async () => {
    fetchMock.mockResolvedValue(json({
      items: [item(1, '板块新闻', { scope: 'SEC', related: { code: null, name: '白酒饮料', chgPct: 0.03 } })],
      nextBefore: null,
    }));
    renderNews();
    const tag = await screen.findByTestId('news-related');
    expect(tag.tagName).toBe('SPAN');
    expect(tag.textContent).toContain('白酒饮料');
  });

  it('⚠️ 标的无行情（related 为 null）时不渲染涨跌 —— 不能显示成 0%', async () => {
    fetchMock.mockResolvedValue(json({
      items: [item(1, '退市股新闻', { scope: 'STK', related: null })], nextBefore: null,
    }));
    renderNews();
    await screen.findByText('退市股新闻');
    expect(screen.queryByTestId('news-related')).not.toBeInTheDocument();
    expect(screen.queryByText('0.00%')).not.toBeInTheDocument();
  });

  it('⚠️ 接口不再下发 impactE6（前视信息），页面自然也不再显示它', async () => {
    // 夹具里根本没有这个字段；旧实现会渲染 `undefined` 或崩，这里钉住新行为。
    fetchMock.mockResolvedValue(json({
      items: [item(1, '中立新闻', { related: { code: 'IDX:COMP', name: '大盘', chgPct: 0 } })],
      nextBefore: null,
    }));
    renderNews();
    const li = await screen.findByTestId('news-item');
    expect(li.textContent).not.toContain('undefined');
    expect(li.textContent).not.toContain('NaN');
  });
});
