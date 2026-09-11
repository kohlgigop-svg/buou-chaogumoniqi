// routes.tsx —— 路由表。
//
// 结构：/login、/register 为公开页；其余全部包在 RequireAuth + AppShell 内。
// /admin 额外要求 isAdmin（隐藏入口，非管理员显示 403 页而非跳转）。
import type { RouteObject } from 'react-router-dom';
import AppShell, { RequireAuth, RequireAdmin } from './components/AppShell.js';
import Login from './pages/Login.js';
import Register from './pages/Register.js';
import Home from './pages/Home.js';
import Market from './pages/Market.js';
import Stock from './pages/Stock.js';
import News from './pages/News.js';
import Life from './pages/Life.js';
import Leaderboard from './pages/Leaderboard.js';
import Me from './pages/Me.js';
import Admin from './pages/Admin.js';

export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  { path: '/register', element: <Register /> },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { path: '/', element: <Home /> },
      { path: '/market', element: <Market /> },
      { path: '/market/:code', element: <Stock /> },
      { path: '/news', element: <News /> },
      { path: '/life/*', element: <Life /> },
      { path: '/leaderboard', element: <Leaderboard /> },
      { path: '/me/*', element: <Me /> },
      {
        path: '/admin',
        element: (
          <RequireAdmin>
            <Admin />
          </RequireAdmin>
        ),
      },
    ],
  },
];
