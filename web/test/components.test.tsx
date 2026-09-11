import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser } from '../src/api.js';

// 会话以 Context 注入，测试可以脱离网络直接构造登录态。
import { SessionProvider, useSession, isAuthed } from '../src/session.js';
import TabBar from '../src/components/TabBar.js';

const alice: AuthUser = { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 };
const admin: AuthUser = { id: 2, username: 'root', credit: 900, isAdmin: true, bankruptCount: 0 };

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('TabBar', () => {
  it('渲染 5 个 Tab，指向正确路由', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <TabBar />
      </MemoryRouter>,
    );
    const labels = ['首页', '行情', '生活', '榜单', '我的'];
    for (const l of labels) expect(screen.getByText(l)).toBeInTheDocument();
    expect(screen.getByText('首页').closest('a')).toHaveAttribute('href', '/');
    expect(screen.getByText('行情').closest('a')).toHaveAttribute('href', '/market');
    expect(screen.getByText('生活').closest('a')).toHaveAttribute('href', '/life');
    expect(screen.getByText('榜单').closest('a')).toHaveAttribute('href', '/leaderboard');
    expect(screen.getByText('我的').closest('a')).toHaveAttribute('href', '/me');
  });

  it('当前路由的 Tab 带 active 类，其余不带', () => {
    render(
      <MemoryRouter initialEntries={['/market']}>
        <TabBar />
      </MemoryRouter>,
    );
    expect(screen.getByText('行情').closest('a')?.className).toMatch(/active/);
    expect(screen.getByText('首页').closest('a')?.className).not.toMatch(/active/);
  });

  it('子路由（/market/600000）仍高亮所属 Tab', () => {
    render(
      <MemoryRouter initialEntries={['/market/600000']}>
        <TabBar />
      </MemoryRouter>,
    );
    expect(screen.getByText('行情').closest('a')?.className).toMatch(/active/);
  });
});

describe('SessionProvider', () => {
  it('注入用户后 useSession 可读到 auth 态', async () => {
    const Probe = () => {
      const s = useSession();
      return <div data-testid="probe">{isAuthed(s) ? s.user.username : s.status}</div>;
    };
    render(
      <SessionProvider initial={{ status: 'authed', user: alice }}>
        <Probe />
      </SessionProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('alice');
  });

  it('guest 态下 useSession 报 anonymous', () => {
    const Probe = () => {
      const s = useSession();
      return <div data-testid="probe">{s.status}</div>;
    };
    render(
      <SessionProvider initial={{ status: 'anonymous' }}>
        <Probe />
      </SessionProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('anonymous');
  });

  it('管理员标记可读', () => {
    const Probe = () => {
      const s = useSession();
      return <div data-testid="probe">{isAuthed(s) && s.user.isAdmin ? 'admin' : 'user'}</div>;
    };
    render(
      <SessionProvider initial={{ status: 'authed', user: admin }}>
        <Probe />
      </SessionProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('admin');
  });
});
