// pages/Me.tsx —— 我的 Tab 容器：资料 / 委托 / 成交 / 流水 四个子页。
//
// 用子路由 + 分段控件，与生活 Tab 同一套路（并列的日常查看，不是层级关系）。
// 子路径可分享（能直接开 /me/ledger）。
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import Profile from './Profile.js';
import Orders from './Orders.js';
import Trades from './Trades.js';
import Ledger from './Ledger.js';

const TABS = [
  { to: '/me/profile', label: '资料' },
  { to: '/me/orders', label: '委托' },
  { to: '/me/trades', label: '成交' },
  { to: '/me/ledger', label: '流水' },
] as const;

export default function Me(): React.JSX.Element {
  return (
    <div className="me">
      <nav className="segtabs" aria-label="我的分区">
        {TABS.map(t => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) => `segtabs__item ${isActive ? 'is-active' : ''}`}
            data-testid={`me-tab-${t.to.split('/').pop() ?? ''}`}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route path="profile" element={<Profile />} />
        <Route path="orders" element={<Orders />} />
        <Route path="trades" element={<Trades />} />
        <Route path="ledger" element={<Ledger />} />
        {/* /me 与未知子路径都落到「资料」 */}
        <Route index element={<Navigate to="profile" replace />} />
        <Route path="*" element={<Navigate to="profile" replace />} />
      </Routes>
    </div>
  );
}
