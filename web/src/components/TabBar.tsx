// components/TabBar.tsx —— 底部 5 Tab 导航（手机优先，固定底部）。
//
// 导航项定义抽到 `NAV_ITEMS`：桌面侧栏（AppShell）与这里共用同一份，
// 避免「加了新页面但只改了一处」导致两套导航不一致。
import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from '../lib/nav.js';

export default function TabBar(): React.JSX.Element {
  return (
    <nav className="tabbar">
      {NAV_ITEMS.map(t => (
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
