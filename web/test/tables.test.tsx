import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser, LeaderboardRow, LedgerRow, OrderRow, TradeRow } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import Leaderboard from '../src/pages/Leaderboard.js';
import Me from '../src/pages/Me.js';

// 榜单数据源：GET /api/leaderboard?by=total|return
// 我的数据源：GET /api/orders | /api/trades | /api/ledger（游标分页）
//            POST /api/auth/password、POST /api/auth/logout

const alice: AuthUser = { id: 1, username: 'alice', credit: 600, isAdmin: false, bankruptCount: 0 };

const lbRow = (over: Partial<LeaderboardRow> = {}): LeaderboardRow => ({
  username: 'u1', totalAssets: 10_000_000, returnPct: 0, bankruptCount: 0, bankrupt: false, ...over,
});

const ledger = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: 1, user_id: 1, bucket: 'A', day: 1, tick: 0, kind: 'GENESIS',
  amount: 10_000_000, balance_after: 10_000_000, ref_type: 'genesis', ref_id: 1,
  created_at: 1_789_109_718, ...over,
});

const order = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: 1, user_id: 1, code: '000334', side: 'B', type: 'L', price: 5183, qty: 100,
  filled: 0, status: 'open', frozen: 518_805, client_key: 'k1', day: 1, created_tick: 100, ...over,
});

const trade = (over: Partial<TradeRow> = {}): TradeRow => ({
  id: 1, order_id: 1, user_id: 1, code: '000334', side: 'B', price: 5183, qty: 100,
  commission: 500, stamp: 0, transfer: 5, day: 1, tick: 100, ...over,
});

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 榜单 stub：按 `by` 参数返回不同排序，用于验「切换后重排」。 */
function routeLb(rows: { total: LeaderboardRow[]; ret: LeaderboardRow[] }) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/leaderboard')) {
      const by = url.includes('by=return') ? 'return' : 'total';
      return Promise.resolve(json({ by, rows: by === 'return' ? rows.ret : rows.total }));
    }
    if (url === '/api/me') {
      return Promise.resolve(json({
        user: alice,
        valuation: { cashAvailable: 0, cashFrozen: 0, positionsValue: 0, loansOutstanding: 0,
          totalAssets: 0, totalInflow: 0, returnPct: 0 },
        positions: [], work: { busyUntil: 0, shift: null, course: null },
      }));
    }
    return Promise.resolve(json({ code: 'NOT_FOUND', message: `no stub for ${url}` }, 404));
  });
}

function renderAt(path: string) {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/me/*" element={<Me />} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('榜单', () => {
  it('渲染榜单行（总资产榜）', async () => {
    routeLb({ total: [lbRow({ username: 'bob', totalAssets: 20_000_000 })], ret: [] });
    renderAt('/leaderboard');
    expect(await screen.findByTestId('lb-list')).toBeInTheDocument();
    expect(await screen.findByText('bob')).toBeInTheDocument();
    expect(screen.getByText('¥200,000.00')).toBeInTheDocument();
  });

  it('⚠️ 切换 by=return 后重排（收益率榜）', async () => {
    routeLb({
      total: [lbRow({ username: 'rich', totalAssets: 90_000_000, returnPct: 0.01 }),
        lbRow({ username: 'trader', totalAssets: 10_000_000, returnPct: 0.9 })],
      ret: [lbRow({ username: 'trader', totalAssets: 10_000_000, returnPct: 0.9 }),
        lbRow({ username: 'rich', totalAssets: 90_000_000, returnPct: 0.01 })],
    });
    renderAt('/leaderboard');
    await screen.findByTestId('lb-list');
    // 默认总资产榜：rich 在前
    let names = screen.getAllByTestId('lb-name').map(e => e.textContent);
    expect(names[0]).toBe('rich');

    fireEvent.click(screen.getByTestId('lb-by-return'));
    await vi.waitFor(() => {
      names = screen.getAllByTestId('lb-name').map(e => e.textContent);
      expect(names[0]).toBe('trader');
    });
    // 且请求带上了 by=return
    const req = fetchMock.mock.calls.find(c => String(c[0]).includes('by=return'));
    expect(req).toBeTruthy();
  });

  it('前三名有徽标，第四名起没有', async () => {
    routeLb({
      total: [1, 2, 3, 4].map(i => lbRow({ username: `u${i}`, totalAssets: (5 - i) * 1_000_000 })),
      ret: [],
    });
    renderAt('/leaderboard');
    await screen.findByTestId('lb-list');
    const badges = screen.getAllByTestId('lb-rank').map(e => e.textContent);
    expect(badges.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(screen.getAllByTestId('lb-rank')).toHaveLength(3);
  });

  it('⚠️ 破产标注只在 bankrupt=true 时出现', async () => {
    routeLb({
      total: [
        lbRow({ username: 'ok', bankrupt: false, bankruptCount: 0 }),
        lbRow({ username: 'broke', bankrupt: true, bankruptCount: 2 }),
      ],
      ret: [],
    });
    renderAt('/leaderboard');
    await screen.findByTestId('lb-list');
    const rows = screen.getAllByTestId('lb-row');
    expect(rows[0]?.textContent).not.toContain('已破产');
    expect(rows[1]?.textContent).toContain('已破产');
    expect(rows[1]?.querySelector('[data-testid="lb-bankrupt"]')).not.toBeNull();
  });

  it('⚠️ 按 username 高亮自己（服务端榜单不回 id）', async () => {
    routeLb({
      total: [lbRow({ username: 'bob' }), lbRow({ username: 'alice' })],
      ret: [],
    });
    renderAt('/leaderboard');
    await screen.findByTestId('lb-list');
    const rows = screen.getAllByTestId('lb-row');
    expect(rows[0]?.className).not.toContain('is-me');
    expect(rows[1]?.className).toContain('is-me');
  });

  it('空榜单显示空态', async () => {
    routeLb({ total: [], ret: [] });
    renderAt('/leaderboard');
    expect(await screen.findByText('榜单还没有数据')).toBeInTheDocument();
  });

  it('⚠️ 说明文字跟着当前榜单走（切到收益率榜不再写总资产公式）', async () => {
    routeLb({
      total: [lbRow({ username: 'a' })],
      ret: [lbRow({ username: 'a', returnPct: 0.05 })],
    });
    renderAt('/leaderboard');
    await screen.findByTestId('lb-list');
    // 总资产榜：应出现总资产口径说明，且**不能**出现收益率公式
    expect(document.body.textContent).toContain('总资产 = 可用 + 冻结 + 持仓市值 − 未偿贷款');
    expect(document.body.textContent).not.toContain('累计入金');

    fireEvent.click(screen.getByTestId('lb-by-return'));
    await waitFor(() => {
      expect(document.body.textContent).toContain('累计入金');
    });
    // 切到收益率榜后不得再显示总资产公式
    expect(document.body.textContent).not.toContain('总资产 = 可用');
  });

  it('接口失败显示错误页', async () => {
    fetchMock.mockResolvedValue(json({ code: 'INTERNAL', message: 'boom' }, 500));
    renderAt('/leaderboard');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('我的 · 分页表', () => {
  /** 分页 stub：按 before 游标返回切好片的数据。 */
  function routePaged<T extends { id: number }>(path: string, all: T[], pageSize = 2) {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(path)) {
        const m = /before=(\d+)/.exec(url);
        const before = m === null ? undefined : Number(m[1]);
        const pool = before === undefined ? all : all.filter(x => x.id < before);
        const items = pool.slice(0, pageSize);
        const last = items[items.length - 1];
        return Promise.resolve(json({ items, nextBefore: last === undefined ? null : last.id }));
      }
      if (url === '/api/me') {
        return Promise.resolve(json({
          user: alice,
          valuation: { cashAvailable: 0, cashFrozen: 0, positionsValue: 0, loansOutstanding: 0,
            totalAssets: 0, totalInflow: 0, returnPct: 0 },
          positions: [], work: { busyUntil: 0, shift: null, course: null },
        }));
      }
      if (url === '/api/auth/logout') return Promise.resolve(json({ ok: true }));
      if (url === '/api/auth/password') return Promise.resolve(json({ ok: true }));
      return Promise.resolve(json({ code: 'NOT_FOUND', message: `no stub for ${url}` }, 404));
    });
  }

  const many = Array.from({ length: 5 }, (_, i) => ledger({ id: 5 - i }));

  it('首屏只加载第一页', async () => {
    routePaged('/api/ledger', many, 2);
    renderAt('/me/ledger');
    await screen.findByTestId('paged-table');
    expect(screen.getAllByTestId('ledger-row')).toHaveLength(2);
  });

  it('⚠️「加载更多」用 nextBefore 取下一页，且相邻页重叠条被去重', async () => {
    routePaged('/api/ledger', many, 2);
    renderAt('/me/ledger');
    await screen.findByTestId('paged-table');
    fireEvent.click(screen.getByTestId('paged-more'));
    await vi.waitFor(() => {
      expect(screen.getAllByTestId('ledger-row')).toHaveLength(4);
    });
    // 请求第二页时带上了 before=<第一页末条 id>=4
    const second = fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/ledger'));
    expect(String(second[1]?.[0])).toContain('before=4');
  });

  it('⚠️ 末页后隐藏「加载更多」', async () => {
    routePaged('/api/ledger', [ledger({ id: 2 }), ledger({ id: 1 })], 2);
    renderAt('/me/ledger');
    await screen.findByTestId('paged-table');
    // nextBefore = 1（末条 id），仍有下一页可试；点一次后拿到空页 → 按钮消失
    fireEvent.click(screen.getByTestId('paged-more'));
    await vi.waitFor(() => {
      expect(screen.queryByTestId('paged-more')).toBeNull();
    });
  });

  it('空列表渲染空态而不是空白', async () => {
    routePaged('/api/ledger', [], 2);
    renderAt('/me/ledger');
    expect(await screen.findByTestId('paged-empty')).toBeInTheDocument();
  });

  it('⚠️ 流水 kind 显示中文，未知 kind 回落原文', async () => {
    routePaged('/api/ledger', [
      ledger({ id: 2, kind: 'TRADE_BUY', amount: -518_805 }),
      ledger({ id: 1, kind: 'SOME_NEW_KIND', amount: 100 }),
    ], 5);
    renderAt('/me/ledger');
    await screen.findByTestId('paged-table');
    const t = document.querySelector('.me')?.textContent ?? '';
    expect(t).toContain('买入');
    expect(t).toContain('SOME_NEW_KIND');
  });

  it('委托表显示买卖方向、状态中文与未成交数量', async () => {
    routePaged('/api/orders', [
      order({ id: 2, side: 'B', status: 'open', qty: 100, filled: 30 }),
      order({ id: 1, side: 'S', status: 'done', qty: 200, filled: 200 }),
    ], 5);
    renderAt('/me/orders');
    await screen.findByTestId('paged-table');
    const t = document.querySelector('.me')?.textContent ?? '';
    expect(t).toContain('买入');
    expect(t).toContain('卖出');
    expect(t).toContain('未成交');
    expect(t).toContain('已成交');
    expect(t).toContain('70');          // 100 − 30
  });

  it('⚠️ 成交表的费用列读 stamp/transfer（不是 stamp_tax/transfer_fee）', async () => {
    routePaged('/api/trades', [
      trade({ id: 2, side: 'S', commission: 500, stamp: 259, transfer: 5 }),
    ], 5);
    renderAt('/me/trades');
    await screen.findByTestId('paged-table');
    const t = document.querySelector('.me')?.textContent ?? '';
    expect(t).toContain('¥5.00');        // 佣金 500 分
    expect(t).toContain('¥2.59');        // 印花税 259 分
    expect(t).toContain('¥0.05');        // 过户费 5 分
    expect(t).not.toContain('undefined');
  });
});

describe('我的 · 改密码与登出', () => {
  beforeEach(() => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/password' && init?.method === 'POST') return Promise.resolve(json({ ok: true }));
      if (url === '/api/auth/logout') return Promise.resolve(json({ ok: true }));
      if (url === '/api/me') {
        return Promise.resolve(json({
          user: alice,
          valuation: { cashAvailable: 0, cashFrozen: 0, positionsValue: 0, loansOutstanding: 0,
            totalAssets: 0, totalInflow: 0, returnPct: 0 },
          positions: [], work: { busyUntil: 0, shift: null, course: null },
        }));
      }
      return Promise.resolve(json({ items: [], nextBefore: null }));
    });
  });

  it('改密码提交 oldPassword/newPassword', async () => {
    renderAt('/me/profile');
    await screen.findByTestId('pw-form');
    fireEvent.change(screen.getByTestId('pw-old'), { target: { value: 'oldpw123' } });
    fireEvent.change(screen.getByTestId('pw-new'), { target: { value: 'newpw456' } });
    fireEvent.change(screen.getByTestId('pw-confirm'), { target: { value: 'newpw456' } });
    fireEvent.click(screen.getByTestId('pw-submit'));
    const call = await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find(x =>
        String(x[0]) === '/api/auth/password' && (x[1] as RequestInit)?.method === 'POST');
      expect(c).toBeTruthy();
      return c!;
    });
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.oldPassword).toBe('oldpw123');
    expect(body.newPassword).toBe('newpw456');
  });

  it('⚠️ 两次新密码不一致本地拦截，不发请求', async () => {
    renderAt('/me/profile');
    await screen.findByTestId('pw-form');
    fireEvent.change(screen.getByTestId('pw-old'), { target: { value: 'oldpw123' } });
    fireEvent.change(screen.getByTestId('pw-new'), { target: { value: 'newpw456' } });
    fireEvent.change(screen.getByTestId('pw-confirm'), { target: { value: 'different99' } });
    fireEvent.click(screen.getByTestId('pw-submit'));
    expect(await screen.findByText('两次输入的新密码不一致')).toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(x =>
      String(x[0]) === '/api/auth/password' && (x[1] as RequestInit)?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('⚠️ 新密码太短本地拦截，不发请求', async () => {
    renderAt('/me/profile');
    await screen.findByTestId('pw-form');
    fireEvent.change(screen.getByTestId('pw-old'), { target: { value: 'oldpw123' } });
    fireEvent.change(screen.getByTestId('pw-new'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('pw-submit'));
    expect(await screen.findByText(/新密码至少 8 位/)).toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(x =>
      String(x[0]) === '/api/auth/password' && (x[1] as RequestInit)?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('改密码成功提示会踢出其它会话', async () => {
    renderAt('/me/profile');
    await screen.findByTestId('pw-form');
    fireEvent.change(screen.getByTestId('pw-old'), { target: { value: 'oldpw123' } });
    fireEvent.change(screen.getByTestId('pw-new'), { target: { value: 'newpw456' } });
    fireEvent.change(screen.getByTestId('pw-confirm'), { target: { value: 'newpw456' } });
    fireEvent.click(screen.getByTestId('pw-submit'));
    const t = await screen.findByRole('status');
    expect(t.textContent).toMatch(/其它设备|其他设备/);
  });

  it('点退出登录调用 /api/auth/logout', async () => {
    renderAt('/me/profile');
    const btn = await screen.findByTestId('logout');
    fireEvent.click(btn);
    await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find(x => String(x[0]) === '/api/auth/logout');
      expect(c).toBeTruthy();
    });
  });

  it('/me 无子路径时重定向到 profile', async () => {
    renderAt('/me');
    expect(await screen.findByTestId('pw-form')).toBeInTheDocument();
  });
});
