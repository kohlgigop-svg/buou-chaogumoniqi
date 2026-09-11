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
  return { id, day: 5, tick: 60, scope: 'MKT', title, impactE6: 0, ...over };
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

describe('News 影响幅度', () => {
  it('正向影响显示为带 + 的百分比并用 up 色', async () => {
    fetchMock.mockResolvedValue(json({
      items: [item(1, '利好', { impactE6: 15000 })], nextBefore: null,
    }));
    renderNews();
    const pct = await screen.findByText('+1.50%');
    expect(pct.className).toContain('up');
  });

  it('负向影响用 down 色', async () => {
    fetchMock.mockResolvedValue(json({
      items: [item(1, '利空', { impactE6: -20000 })], nextBefore: null,
    }));
    renderNews();
    const pct = await screen.findByText('-2.00%');
    expect(pct.className).toContain('down');
  });

  it('影响为 0 时不显示幅度标记', async () => {
    fetchMock.mockResolvedValue(json({ items: [item(1, '中立', { impactE6: 0 })], nextBefore: null }));
    renderNews();
    await screen.findByText('中立');
    expect(screen.queryByText('0.00%')).not.toBeInTheDocument();
  });
});
