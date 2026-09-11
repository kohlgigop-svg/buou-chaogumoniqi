// pages/Admin.tsx —— 管理后台容器：权限守卫 + 分区导航。
//
// ⚠️ 关键约束（计划 C Task 9 Step 1）：**非管理员不得发出任何 admin 请求**。
// 所以守卫必须在**挂载子面板之前**返回 —— 若把守卫写在每个子面板里，
// 子面板的 `useEffect(load)` 已经跑了，请求已经出去了，守卫就只是"事后遮掩"。
// 这也是为什么这里是唯一的守卫点，子面板一律不自己判权限。
//
// 生产链路上 `routes.tsx` 已经用 `RequireAdmin` 包住了本页，本组件里的守卫属于
// **纵深防御**：一旦有人把 `<Admin/>` 挂到别处（测试、未来新路由）而忘了包守卫，
// 这里仍能兜住。视觉文案与 `RequireAdmin` 保持一致，避免两条路径给出两种 403。
import { useState } from 'react';
import { useSession, isAuthed } from '../session.js';
import UsersPanel from './admin/UsersPanel.js';
import AnnouncePanel from './admin/AnnouncePanel.js';
import EnginePanel from './admin/EnginePanel.js';
import ConfigPanel from './admin/ConfigPanel.js';
import BackupPanel from './admin/BackupPanel.js';

type Tab = 'users' | 'announce' | 'audit' | 'config' | 'backups';

const TABS: { id: Tab; label: string; testId: string }[] = [
  { id: 'users', label: '用户', testId: 'admin-tab-users' },
  { id: 'announce', label: '公告', testId: 'admin-tab-announce' },
  { id: 'audit', label: '引擎 / 审计', testId: 'admin-tab-audit' },
  { id: 'config', label: '配置', testId: 'admin-tab-config' },
  { id: 'backups', label: '备份', testId: 'admin-tab-backups' },
];

export default function Admin(): React.JSX.Element {
  const session = useSession();
  const [tab, setTab] = useState<Tab>('users');

  // 未登录 / 非管理员：在挂载任何子面板之前返回。子面板一个都不会渲染，
  // 它们的 `useEffect(load)` 也就一个都不会跑 —— 这才是"不发请求"的实现方式。
  //
  // 这里**不能**顺手去 fetch 一次"看看服务端是否允许"：那本身就违反约束。
  // 前端只依据 `isAdmin` 决定渲不渲染，真正的拦截在服务端
  // （所有 /api/admin/* 都要求 is_admin，前端判断只是省一次 403 往返）。
  if (!isAuthed(session) || !session.user.isAdmin) {
    return (
      <div className="page-error" data-testid="admin-forbidden">
        <div className="page-error__code">403</div>
        <div className="page-error__text">无权限访问管理后台</div>
      </div>
    );
  }

  return (
    <div className="admin" data-testid="admin-panel">
      <nav className="admin__tabs" aria-label="管理分区">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`admin__tab ${tab === t.id ? 'is-active' : ''}`}
            data-testid={t.testId}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="admin__body">
        {tab === 'users' ? <UsersPanel /> : null}
        {tab === 'announce' ? <AnnouncePanel /> : null}
        {tab === 'audit' ? <EnginePanel /> : null}
        {tab === 'config' ? <ConfigPanel /> : null}
        {tab === 'backups' ? <BackupPanel /> : null}
      </div>
    </div>
  );
}
