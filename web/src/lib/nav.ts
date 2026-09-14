// lib/nav.ts —— 主导航项定义（TabBar 与桌面侧栏共用）。
//
// 共用一份的意义：加页面时只改这里，手机底部 Tab 与桌面左侧栏自动同步，
// 不会出现「桌面有、手机没有」这种漂移。
export interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** 仅「/」需要：否则它会对所有路由都匹配为 active。 */
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '首页', icon: '⌂', end: true },
  { to: '/market', label: '行情', icon: '≡' },
  { to: '/life', label: '生活', icon: '✦' },
  { to: '/leaderboard', label: '榜单', icon: '♛' },
  { to: '/me', label: '我的', icon: '☺' },
];
