// test/auth-pages.test.tsx —— 登录/注册页的文案与初始资金提示。
//
// ⚠️ 为什么专门为一句文案写测试：`auth.initialCash` 从 ¥100,000 调到 ¥1,000,000 时
// （2026-09-14 五项优化之二），注册页那句硬编码的「初始资金 ¥100,000.00」
// **没人跟着改**，线上挂了整整一天 —— 新玩家看到的数字与实际到账差 10 倍。
// 文案与服务端常量之间没有编译期联系，只能靠测试钉住。
//
// 这里把「服务端的真值」以常量形式抄一份并加显式注释：它不是重复定义，
// 而是一个**对照锚点** —— 服务端改了两边都要动，测试会强制你想起来。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../src/session.js';
import Register from '../src/pages/Register.js';
import Login from '../src/pages/Login.js';

/**
 * ⚠️ 必须与 `server/src/config/defaults.ts` 的 `auth.initialCash` 保持一致
 * （单位：分）。改服务端时**必须同步改这里**，否则下面的测试会失败 ——
 * 这正是它存在的意义。
 */
const SERVER_INITIAL_CASH_CENTS = 100_000_000; // ¥1,000,000.00

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

function renderPage(node: React.ReactElement) {
  return render(
    <MemoryRouter>
      <SessionProvider>{node}</SessionProvider>
    </MemoryRouter>,
  );
}

describe('注册页', () => {
  it('⚠️ 初始资金提示必须与本次优化的真值一致（¥1,000,000）', () => {
    renderPage(<Register />);
    // 旧值 ¥100,000.00 是线上真实发生过的 bug，显式断言它不出现
    expect(screen.queryByText(/¥100,000\.00/)).toBeNull();
    expect(screen.getByText(/¥1,000,000\.00/)).toBeTruthy();
  });

  it('⚠️ 提示金额与服务端 initialCash 常量一致（防两侧漂移）', () => {
    // 把页面上的数字解析出来，与服务端常量比对 —— 而不是只硬断言一个字符串。
    // 这样若服务端改了金额，只需改上面的常量，测试会立刻指出页面没跟上。
    const yuan = (SERVER_INITIAL_CASH_CENTS / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    renderPage(<Register />);
    expect(screen.getByText(new RegExp(`¥${yuan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeTruthy();
  });

  it('渲染出用户名/密码输入与提交按钮', () => {
    renderPage(<Register />);
    expect(screen.getByText('用户名')).toBeTruthy();
    expect(screen.getByText('密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: /注册/ })).toBeTruthy();
  });

  it('有「去登录」入口', () => {
    renderPage(<Register />);
    expect(screen.getByText('去登录')).toBeTruthy();
  });
});

describe('登录页', () => {
  it('渲染出用户名/密码输入与提交按钮', () => {
    renderPage(<Login />);
    expect(screen.getByText('用户名')).toBeTruthy();
    expect(screen.getByText('密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: /登录/ })).toBeTruthy();
  });

  it('有「立即注册」入口', () => {
    renderPage(<Login />);
    expect(screen.getByText('立即注册')).toBeTruthy();
  });
});
