// components/TabBar.tsx —— 底部 5 Tab 导航（手机优先，固定底部）。
import { NavLink } from 'react-router-dom';

interface TabDef { to: string; label: string; icon: string; end?: boolean }

// end:true 仅用于「/」，否则它会对所有路由都匹配为 active。
const TABS: TabDef[] = [
  { to: '/', label: '首页', icon: '⌂', end: true },
  { to: '/market', label: '行情', icon: '≡' },
  { to: '/life', label: '生活', icon: '✦' },
  { to: '/leaderboard', label: '榜单', icon: '♛' },
  { to: '/me', label: '我的', icon: '☺' },
];

export default function TabBar(): React.JSX.Element {
  return (
    <nav className="tabbar">
      {TABS.map(t => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) => (isActive ? 'tabbar__item active' : 'tabbar__item')}
        >
          <span className="tabbar__icon" aria-hidden="true">{t.icon}</span>
          <span className="tabbar__label">{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
