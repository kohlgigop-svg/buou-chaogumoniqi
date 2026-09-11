// test/admin.test.tsx —— Task 9：管理后台组件契约。
//
// 与其它组件测试同样策略：注入会话 + stub fetch，不依赖真实网络。
// 重点锁三件事（计划 Step 1 明确要求）：
//   ① 非管理员不渲染任何管理 UI；
//   ② config 前缀校验在**发请求之前**就拦住 `auth.sessionDays`；
//   ③ 封禁必须二次确认；审计 failures 非空时红字列出。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AuthUser } from '../src/api.js';
import { SessionProvider, type Session } from '../src/session.js';
import Admin from '../src/pages/Admin.js';

const alice: AuthUser = { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 };
const root: AuthUser = { id: 2, username: 'root', credit: 900, isAdmin: true, bankruptCount: 0 };

const authed = (u: AuthUser): Session => ({ status: 'authed', user: u });

// ---------- fetch stub ----------

interface Call { method: string; url: string; body: unknown }
let calls: Call[] = [];
/** 按 `METHOD path` 给出的响应覆盖；未命中走 defaultBody。 */
let overrides: Record<string, { status: number; body: unknown }> = {};

// ⚠️ ADMIN_USERS 里的 isAdmin 用 **0/1 整数**：服务端 `/api/admin/users` 不做布尔转换
// （实测回 0/1；`/api/auth/*`、`/api/me` 才转成真 boolean）。若这里写 `false`，
// 替身就比真服务端"好说话"，会让 `=== 1` 这类写法在测试里过、上线挂。
const ADMIN_USERS = {
  users: [
    { id: 1, username: 'alice', credit: 700, status: 'active', isAdmin: 0, bankruptCount: 0,
      createdDay: 1, valuation: { totalAssets: 1_000_000, returnPct: 0, cashAvailable: 1_000_000,
        cashFrozen: 0, positionsValue: 0, loansOutstanding: 0, totalInflow: 1_000_000 } },
    { id: 3, username: 'mallory', credit: 350, status: 'banned', isAdmin: 0, bankruptCount: 2,
      createdDay: 1, valuation: { totalAssets: 0, returnPct: -1, cashAvailable: 0,
        cashFrozen: 0, positionsValue: 0, loansOutstanding: 0, totalInflow: 1_000_000 } },
    { id: 2, username: 'root', credit: 900, status: 'active', isAdmin: 1, bankruptCount: 0,
      createdDay: 1, valuation: { totalAssets: 2_000_000, returnPct: 0, cashAvailable: 2_000_000,
        cashFrozen: 0, positionsValue: 0, loansOutstanding: 0, totalInflow: 2_000_000 } },
  ],
};
const ADMIN_ENGINE = { day: 3, tickInDay: 612, lastTick: 3012, lagSeconds: 4 };
const ADMIN_AUDIT_OK = { globalOk: true, globalError: null, usersOk: true, checkedUsers: 2, failures: [] };
const ADMIN_AUDIT_BAD = {
  globalOk: false, globalError: 'balance mismatch: expected 100 got 90', usersOk: false,
  checkedUsers: 2,
  failures: [{ id: 3, username: 'mallory', error: 'user 3 balance mismatch' }],
};
const ADMIN_CONFIG = {
  config: { work: { shiftsPerDay: 2 }, trading: { slippageK: 0.06 } },
  overrides: [{ key: 'work.shiftsPerDay', value: '2' }],
};
const ADMIN_BACKUPS = { files: [{ file: 'day-2.db', bytes: 2048 }, { file: 'day-1.db', bytes: 1024 }] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  overrides = {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    const rawBody = init?.body;
    calls.push({
      method, url,
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
    });
    const key = `${method} ${new URL(url, 'http://x').pathname}`;
    if (overrides[key] !== undefined) {
      const o = overrides[key]!;
      return jsonResponse(o.body, o.status);
    }
    if (key === 'GET /api/admin/users') return jsonResponse(ADMIN_USERS);
    if (key === 'GET /api/admin/engine') return jsonResponse(ADMIN_ENGINE);
    if (key === 'GET /api/admin/audit') return jsonResponse(ADMIN_AUDIT_OK);
    if (key === 'GET /api/admin/config') return jsonResponse(ADMIN_CONFIG);
    if (key === 'GET /api/admin/backups') return jsonResponse(ADMIN_BACKUPS);
    return jsonResponse({ ok: true });
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

function renderAdmin(session: Session) {
  return render(
    <SessionProvider initial={session}>
      <MemoryRouter initialEntries={['/admin']}>
        <Admin />
      </MemoryRouter>
    </SessionProvider>,
  );
}

/**
 * 渲染并切到指定分区。
 *
 * Task 9 的 Admin 是「容器 + 分区导航」，默认只挂载用户表 —— 这是刻意的：
 * 一次性挂载 5 个面板会让首屏同时打 5 个 admin 接口（含昂贵的全库对账），
 * 值班时反而更慢。所以下面每个分区的测试必须先显式切过去。
 */
async function renderAdminAt(session: Session, tabId: string): Promise<void> {
  const user = userEvent.setup();
  renderAdmin(session);
  await screen.findByTestId('admin-panel');
  await user.click(screen.getByTestId(tabId));
}

/** 找到某个请求调用（若不存在返回 undefined）。 */
function findCall(method: string, pathFragment: string): Call | undefined {
  return calls.find(c => c.method === method && c.url.includes(pathFragment));
}

// ---------- 守卫 ----------

describe('管理后台守卫', () => {
  it('⚠️ 非管理员：不渲染任何管理 UI，也不发管理请求', async () => {
    renderAdmin(authed(alice));
    expect(await screen.findByTestId('admin-forbidden')).toBeInTheDocument();
    // 关键：连一个 admin 请求都不能发出去
    expect(calls.filter(c => c.url.includes('/api/admin/'))).toHaveLength(0);
  });

  it('管理员：渲染后台各分区', async () => {
    renderAdmin(authed(root));
    expect(await screen.findByTestId('admin-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-forbidden')).toBeNull();
  });
});

// ---------- 用户表 ----------

describe('用户表', () => {
  it('渲染用户名、信誉分、破产次数与封禁状态', async () => {
    renderAdmin(authed(root));
    const table = await screen.findByTestId('admin-users');
    expect(within(table).getByText('alice')).toBeInTheDocument();
    expect(within(table).getByText('mallory')).toBeInTheDocument();
    expect(within(table).getByTestId('user-status-3')).toHaveTextContent('已封禁');
    expect(within(table).getByTestId('user-bankrupt-3')).toHaveTextContent('2');
  });

  it('本地搜索过滤用户（不发新请求）', async () => {
    const user = userEvent.setup();
    renderAdmin(authed(root));
    await screen.findByTestId('admin-users');
    const before = calls.length;
    await user.type(screen.getByTestId('admin-user-search'), 'mal');
    expect(screen.queryByText('alice')).toBeNull();
    expect(screen.getByText('mallory')).toBeInTheDocument();
    expect(calls.length).toBe(before); // 本地过滤
  });

  it('封禁按钮对已封禁用户显示"解封"，对正常用户显示"封禁"', async () => {
    renderAdmin(authed(root));
    await screen.findByTestId('admin-users');
    expect(screen.getByTestId('ban-1')).toHaveTextContent('封禁');
    expect(screen.getByTestId('ban-3')).toHaveTextContent('解封');
  });

  it('⚠️ isAdmin 为 1 的行才显示「管理员」标签（服务端回的是 0/1 整数）', async () => {
    renderAdmin(authed(root));
    const table = await screen.findByTestId('admin-users');
    // root 是 isAdmin=1 → 有标签；alice 是 isAdmin=0 → 没有
    const rows = within(table).getAllByRole('row');
    const rootRow = rows.find(r => within(r).queryByText('root') !== null)!;
    const aliceRow = rows.find(r => within(r).queryByText('alice') !== null)!;
    expect(within(rootRow).getByText('管理员')).toBeInTheDocument();
    expect(within(aliceRow).queryByText('管理员')).toBeNull();
  });
});

// ---------- 封禁二次确认 ----------

describe('封禁需二次确认', () => {
  it('⚠️ 点击封禁不直接发请求，先出确认', async () => {
    const user = userEvent.setup();
    renderAdmin(authed(root));
    await screen.findByTestId('admin-users');

    await user.click(screen.getByTestId('ban-1'));
    expect(findCall('POST', '/api/admin/users/1/ban')).toBeUndefined();
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent('alice');
  });

  it('确认后才发请求', async () => {
    const user = userEvent.setup();
    renderAdmin(authed(root));
    await screen.findByTestId('admin-users');
    await user.click(screen.getByTestId('ban-1'));
    await user.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(findCall('POST', '/api/admin/users/1/ban')).toBeDefined());
  });

  it('取消则不发请求', async () => {
    const user = userEvent.setup();
    renderAdmin(authed(root));
    await screen.findByTestId('admin-users');
    await user.click(screen.getByTestId('ban-1'));
    await user.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(findCall('POST', '/api/admin/users/1/ban')).toBeUndefined();
  });

  it('解封也需确认（不因为"是恢复操作"就跳过）', async () => {
    const user = userEvent.setup();
    renderAdmin(authed(root));
    await screen.findByTestId('admin-users');
    await user.click(screen.getByTestId('ban-3'));
    expect(await screen.findByTestId('confirm-dialog')).toHaveTextContent('mallory');
    expect(findCall('POST', '/api/admin/users/3/unban')).toBeUndefined();
  });
});

// ---------- 重置密码 ----------

describe('重置密码', () => {
  it('提交后提示"所有会话已被踢出"', async () => {
    const user = userEvent.setup();
    renderAdmin(authed(root));
    await screen.findByTestId('admin-users');

    await user.click(screen.getByTestId('reset-pwd-1'));
    const dialog = await screen.findByTestId('reset-pwd-dialog');
    await user.type(within(dialog).getByTestId('reset-pwd-input'), 'newPass!123');
    await user.click(within(dialog).getByTestId('reset-pwd-submit'));

    await waitFor(() => expect(findCall('POST', '/api/admin/users/1/reset-password')).toBeDefined());
    expect(await screen.findByTestId('admin-toast')).toHaveTextContent('该用户所有会话已被踢出');
  });

  it('新密码不足 8 位时本地拦住，不发请求', async () => {
    const user = userEvent.setup();
    renderAdmin(authed(root));
    await screen.findByTestId('admin-users');
    await user.click(screen.getByTestId('reset-pwd-1'));
    const dialog = await screen.findByTestId('reset-pwd-dialog');
    await user.type(within(dialog).getByTestId('reset-pwd-input'), 'short');
    await user.click(within(dialog).getByTestId('reset-pwd-submit'));
    expect(findCall('POST', '/api/admin/users/1/reset-password')).toBeUndefined();
    expect(within(dialog).getByTestId('reset-pwd-error')).toHaveTextContent('8');
  });
});

// ---------- 公告 ----------

describe('公告发布', () => {
  it('内容为空时不发请求', async () => {
    await renderAdminAt(authed(root), 'admin-tab-announce');
    await userEvent.setup().click(await screen.findByTestId('admin-announce-submit'));
    expect(findCall('POST', '/api/admin/announce')).toBeUndefined();
  });

  it('填写后发布成功并清空输入', async () => {
    const user = userEvent.setup();
    await renderAdminAt(authed(root), 'admin-tab-announce');
    const input = await screen.findByTestId('admin-announce-input');
    await user.type(input, '今日停服维护');
    await user.click(screen.getByTestId('admin-announce-submit'));
    await waitFor(() => expect(findCall('POST', '/api/admin/announce')).toBeDefined());
    expect(findCall('POST', '/api/admin/announce')!.body).toEqual({ content: '今日停服维护' });
  });
});

// ---------- 引擎状态 ----------

describe('引擎状态', () => {
  it('显示 day / tickInDay / lastTick / 延迟', async () => {
    await renderAdminAt(authed(root), 'admin-tab-audit');
    const box = await screen.findByTestId('admin-engine');
    expect(within(box).getByTestId('engine-day')).toHaveTextContent('3');
    expect(within(box).getByTestId('engine-tick')).toHaveTextContent('612');
    expect(within(box).getByTestId('engine-lasttick')).toHaveTextContent('3012');
    expect(within(box).getByTestId('engine-lag')).toHaveTextContent('4');
  });
});

// ---------- 审计 ----------

describe('审计结果', () => {
  it('全绿时不显示失败列表', async () => {
    await renderAdminAt(authed(root), 'admin-tab-audit');
    const box = await screen.findByTestId('admin-audit');
    expect(within(box).getByTestId('audit-global')).toHaveTextContent('正常');
    expect(within(box).queryByTestId('audit-failures')).toBeNull();
  });

  it('⚠️ failures 非空时红字逐条列出', async () => {
    overrides['GET /api/admin/audit'] = { status: 200, body: ADMIN_AUDIT_BAD };
    await renderAdminAt(authed(root), 'admin-tab-audit');
    const box = await screen.findByTestId('admin-audit');
    expect(within(box).getByTestId('audit-global')).toHaveTextContent('异常');
    const list = within(box).getByTestId('audit-failures');
    expect(list).toHaveTextContent('mallory');
    expect(list).toHaveTextContent('user 3 balance mismatch');
    // 必须是"红字"级别的显式标记。
    // 用 tone-danger（语义色）而非 tone-up（方向色）—— 后者在 A 股配色下虽然也是红，
    // 但名字里的 up 会被读成"上涨"，放在"对账失败"上语义错位（见 theme.css）。
    expect(list.className).toContain('tone-danger');
  });
});

// ---------- config 热改 ----------

describe('config 热改：前端前缀校验', () => {
  it('⚠️ auth.sessionDays 被本地拦住且不发请求（计划明确要求）', async () => {
    const user = userEvent.setup();
    await renderAdminAt(authed(root), 'admin-tab-config');
    await screen.findByTestId('admin-config');

    await user.clear(screen.getByTestId('config-key'));
    await user.type(screen.getByTestId('config-key'), 'auth.sessionDays');
    await user.clear(screen.getByTestId('config-value'));
    await user.type(screen.getByTestId('config-value'), '30');
    await user.click(screen.getByTestId('config-submit'));

    expect(findCall('PUT', '/api/admin/config')).toBeUndefined();
    expect(await screen.findByTestId('config-error')).toHaveTextContent('不可热改');
  });

  it('白名单键通过并发请求，值为解析后的类型（数字不是字符串）', async () => {
    const user = userEvent.setup();
    await renderAdminAt(authed(root), 'admin-tab-config');
    await screen.findByTestId('admin-config');

    await user.clear(screen.getByTestId('config-key'));
    await user.type(screen.getByTestId('config-key'), 'work.shiftsPerDay');
    await user.clear(screen.getByTestId('config-value'));
    await user.type(screen.getByTestId('config-value'), '1');
    await user.click(screen.getByTestId('config-submit'));

    await waitFor(() => expect(findCall('PUT', '/api/admin/config')).toBeDefined());
    expect(findCall('PUT', '/api/admin/config')!.body).toEqual({ key: 'work.shiftsPerDay', value: 1 });
    // 回显"将写入什么"要能区分字符串与数字
    expect(await screen.findByTestId('admin-toast')).toHaveTextContent('work.shiftsPerDay');
  });

  it('带引号的值当字符串（不误解析成数字）', async () => {
    const user = userEvent.setup();
    await renderAdminAt(authed(root), 'admin-tab-config');
    await screen.findByTestId('admin-config');
    await user.clear(screen.getByTestId('config-key'));
    await user.type(screen.getByTestId('config-key'), 'work.shiftsPerDay');
    await user.clear(screen.getByTestId('config-value'));
    await user.type(screen.getByTestId('config-value'), '"1"');
    await user.click(screen.getByTestId('config-submit'));
    await waitFor(() => expect(findCall('PUT', '/api/admin/config')).toBeDefined());
    expect(findCall('PUT', '/api/admin/config')!.body).toEqual({ key: 'work.shiftsPerDay', value: '1' });
  });

  it('服务端返回 CONFIG_KEY 时展示可读错误', async () => {
    overrides['PUT /api/admin/config'] = {
      status: 400, body: { code: 'CONFIG_KEY', message: 'key not in whitelist' },
    };
    const user = userEvent.setup();
    await renderAdminAt(authed(root), 'admin-tab-config');
    await screen.findByTestId('admin-config');
    await user.clear(screen.getByTestId('config-key'));
    await user.type(screen.getByTestId('config-key'), 'work.shiftsPerDay');
    await user.clear(screen.getByTestId('config-value'));
    await user.type(screen.getByTestId('config-value'), '2');
    await user.click(screen.getByTestId('config-submit'));
    expect(await screen.findByTestId('config-error')).toHaveTextContent('该配置项不可热改');
  });
});

// ---------- 备份 ----------

describe('备份列表', () => {
  it('降序显示并按游戏日命名', async () => {
    await renderAdminAt(authed(root), 'admin-tab-backups');
    const list = await screen.findByTestId('admin-backups');
    const items = within(list).getAllByTestId('backup-row');
    expect(items[0]).toHaveTextContent('day-2.db');
    expect(items[1]).toHaveTextContent('day-1.db');
  });

  it('显示人类可读大小', async () => {
    await renderAdminAt(authed(root), 'admin-tab-backups');
    const list = await screen.findByTestId('admin-backups');
    expect(within(list).getAllByTestId('backup-size')[0]).toHaveTextContent('2.0 KB');
  });

  it('下载链接指向正确的端点', async () => {
    await renderAdminAt(authed(root), 'admin-tab-backups');
    const list = await screen.findByTestId('admin-backups');
    const links = within(list).getAllByTestId('backup-download');
    expect(links[0]).toHaveAttribute('href', '/api/admin/backups/day-2.db');
  });
});

// ---------- 面板导航 ----------

describe('分区导航', () => {
  it('默认显示用户表', async () => {
    renderAdmin(authed(root));
    expect(await screen.findByTestId('admin-users')).toBeInTheDocument();
  });

  it('可切换到审计分区', async () => {
    const user = userEvent.setup();
    renderAdmin(authed(root));
    await screen.findByTestId('admin-users');
    await user.click(screen.getByTestId('admin-tab-audit'));
    expect(await screen.findByTestId('admin-audit')).toBeInTheDocument();
  });

  it('切到 config 分区', async () => {
    const user = userEvent.setup();
    renderAdmin(authed(root));
    await screen.findByTestId('admin-users');
    await user.click(screen.getByTestId('admin-tab-config'));
    expect(await screen.findByTestId('admin-config')).toBeInTheDocument();
  });
});
