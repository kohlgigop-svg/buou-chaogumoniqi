// pages/Life.tsx —— 生活 Tab 容器：打工 / 能力 / 银行 三个子页。
//
// 用「子路由 + 分段控件」而不是三层导航：生活 Tab 的三个子域（赚钱 / 成长 / 借贷）
// 是并列的日常操作，不是层级关系。子路径保留可分享性（可直接开 /life/bank）。
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import Work from './Work.js';
import Abilities from './Abilities.js';
import Bank from './Bank.js';

const TABS = [
  { to: '/life/work', label: '打工' },
  { to: '/life/abilities', label: '能力' },
  { to: '/life/bank', label: '银行' },
] as const;

export default function Life(): React.JSX.Element {
  return (
    <div className="life">
      <nav className="segtabs" aria-label="生活分区">
        {TABS.map(t => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) => `segtabs__item ${isActive ? 'is-active' : ''}`}
            data-testid={`life-tab-${t.to.split('/').pop() ?? ''}`}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route path="work" element={<Work />} />
        <Route path="abilities" element={<Abilities />} />
        <Route path="bank" element={<Bank />} />
        {/* /life 与未知子路径都落到「打工」 */}
        <Route index element={<Navigate to="work" replace />} />
        <Route path="*" element={<Navigate to="work" replace />} />
      </Routes>
    </div>
  );
}
