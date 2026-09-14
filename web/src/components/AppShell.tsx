// components/AppShell.tsx —— 应用外壳：顶部标题栏 + 内容区 + 底部 TabBar。
//
// 延迟角标（Task 8）：行情有延迟时必须让用户看得见。默认从 `useRealtime()` 取，
// 但保留 `latencyBadge` prop 以便测试直接注入文案、也便于将来别处复用。
import { useEffect, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import TabBar from './TabBar.js';
import { FillToasts } from './Toast.js';
import { useSession } from '../session.js';
import { useRealtime } from '../lib/realtime.js';

/** 路由 → 标题。未列出的路由不显示标题栏标题（如个股页自带标题）。 */
const TITLES: Record<string, string> = {
  '/': '大布偶证券交易所',
  '/market': '行情',
  '/life': '生活',
  '/leaderboard': '榜单',
  '/me': '我的',
  '/news': '资讯',
  '/admin': '管理后台',
};

export interface AppShellProps {
  /**
   * 行情延迟角标文案（如「延迟 3s」）；为空则不显示。
   * 不传时从实时连接读（正常延迟下也是 `null`，即不占位）。
   */
  latencyBadge?: string | null;
  children?: ReactNode;
}

export default function AppShell({ latencyBadge, children }: AppShellProps): React.JSX.Element {
  const { pathname } = useLocation();
  const title = TITLES[pathname] ?? '';
  const { lagBadge, lag } = useRealtime();
  // prop 优先级高于 context —— 测试与特殊页面需要能覆盖。
  const badge = latencyBadge !== undefined ? latencyBadge : lagBadge;
  return (
    <div className="appshell">
      <header className="appshell__header">
        <span className="appshell__title">{title}</span>
        {badge !== null && badge !== ''
          ? <span className={`appshell__latency appshell__latency--${lag.tone}`}
              data-testid="latency-badge">{badge}</span>
          : null}
      </header>
      <main className="appshell__main">{children ?? <Outlet />}</main>
      {/* 成交通知跨页常驻：限价单是异步成交的，用户可能已离开个股页（规格 §4.4）。 */}
      <FillToasts />
      <TabBar />
    </div>
  );
}

/** 未登录 → 重定向 /login。包在受保护路由外层。 */
export function RequireAuth({ children }: { children: ReactNode }): React.JSX.Element | null {
  const { status } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    if (status === 'anonymous') navigate('/login', { replace: true, state: { from: pathname } });
  }, [status, navigate, pathname]);

  if (status === 'authed') return <>{children}</>;
  if (status === 'anonymous') return null;
  return <div className="app-loading">加载中…</div>;
}

/** 非管理员 → 403 页（不跳转，明确告知无权限）。 */
export function RequireAdmin({ children }: { children: ReactNode }): React.JSX.Element {
  const { user } = useSession();
  if (user === null) return <div className="app-loading">加载中…</div>;
  if (!user.isAdmin) {
    return (
      <div className="page-error">
        <div className="page-error__code">403</div>
        <div className="page-error__text">无权限访问管理后台</div>
      </div>
    );
  }
  return <>{children}</>;
}

/** 顶部会话状态位（用户名 / 登录入口）。 */
export function useClockTick(intervalMs = 1000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN(v => v + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return n;
}
