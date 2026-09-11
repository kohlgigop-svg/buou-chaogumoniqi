import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser, JobRow, ShiftRow, MeView, HealthView } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import Work from '../src/pages/Work.js';

// Work 页数据源：GET /api/jobs、GET /api/shifts、POST /api/shifts、DELETE /api/shifts/:id、/healthz
//
// 重点验：
// 1. 不合格职业置灰且**点击不触发请求**（需求明确点名）
// 2. SHIFT_CAP(429) 映射中文「今日班次已满」
// 3. 班次状态徽标与「可取消」判定（依赖 gmin，边界在 lifeLogic 已测，这里验接线）
// 4. 单位：base_pay/wage/pay 是分

const alice: AuthUser = { id: 1, username: 'alice', credit: 600, isAdmin: false, bankruptCount: 0 };

const me: MeView = {
  user: alice,
  valuation: { cashAvailable: 10_000_000, cashFrozen: 0, positionsValue: 0,
    loansOutstanding: 0, totalAssets: 10_000_000, totalInflow: 10_000_000, returnPct: 0 },
  positions: [], work: { busyUntil: 0, shift: null, course: null },
};

/** 三个职业：可做的、缺能力的、缺多个条件的。 */
const jobs: JobRow[] = [
  { id: 1, name: '传单派发员', base_pay: 80_000, min_credit: null,
    reqs: [], eligible: true, wage: 80_000 },
  { id: 2, name: '外卖骑手', base_pay: 150_000, min_credit: null,
    reqs: [['FIT', 2]], eligible: false, wage: 150_000 },
  { id: 5, name: '平面设计师', base_pay: 280_000, min_credit: null,
    reqs: [['DESIGN', 3], ['COMM', 1]], eligible: false, wage: 280_000 },
  { id: 9, name: '基金经理', base_pay: 900_000, min_credit: 700,
    reqs: [['FIN', 6]], eligible: false, wage: 900_000 },
];

const shift = (over: Partial<ShiftRow> = {}): ShiftRow =>
  ({ id: 11, job_id: 1, start_gmin: 5000, end_gmin: 5480, status: 'scheduled', pay: null, ...over });

const health = (lastTick: number): HealthView => ({ ok: true, day: 1, lastTick });

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function route(over: {
  jobs?: JobRow[]; shifts?: ShiftRow[]; lastTick?: number;
  schedule?: unknown; scheduleStatus?: number;
  cancelStatus?: number;
} = {}) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url === '/api/jobs') return Promise.resolve(json({ jobs: over.jobs ?? jobs }));
    if (url.startsWith('/api/shifts')) {
      if (method === 'POST') {
        return Promise.resolve(json(over.schedule ?? { shiftId: 12, shifts: [] }, over.scheduleStatus ?? 200));
      }
      if (method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: over.cancelStatus ?? 204 }));
      }
      return Promise.resolve(json({ shifts: over.shifts ?? [] }));
    }
    if (url.includes('/healthz')) {
      // lastTick=lastTick → gmin 由 gminFromHealth 推导
      return Promise.resolve(json(health(over.lastTick ?? 539)));
    }
    if (url === '/api/me') return Promise.resolve(json(me));
    return Promise.resolve(json({ code: 'NOT_FOUND', message: `no stub for ${method} ${url}` }, 404));
  });
}

function renderWork() {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={['/life/work']}>
        <Routes><Route path="/life/work" element={<Work />} /></Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('Work 职业列表', () => {
  it('渲染职业名与实发工资（分 → 元）', async () => {
    route();
    renderWork();
    expect(await screen.findByText('传单派发员')).toBeInTheDocument();
    expect(screen.getByText('¥800.00')).toBeInTheDocument();     // 80,000 分
    expect(screen.getByText('¥1,500.00')).toBeInTheDocument();   // 150,000 分
  });

  it('合格职业的排班按钮可用', async () => {
    route();
    renderWork();
    await screen.findByText('传单派发员');
    const rows = screen.getAllByTestId('job-row');
    const ok = rows.find(r => r.dataset['eligible'] === '1');
    const btn = ok?.querySelector('[data-testid="schedule-job"]');
    expect(btn).not.toBeNull();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('不合格职业置灰并从 data-eligible 标记出来', async () => {
    route();
    renderWork();
    await screen.findByText('外卖骑手');
    const rows = screen.getAllByTestId('job-row');
    const locked = rows.filter(r => r.dataset['eligible'] === '0');
    expect(locked).toHaveLength(3);
    for (const r of locked) {
      const btn = r.querySelector('[data-testid="schedule-job"]') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    }
  });

  it('不合格职业显示具体缺口「需 体质≥2」', async () => {
    route();
    renderWork();
    await screen.findByText('外卖骑手');
    const gaps = screen.getAllByTestId('job-gap').map(e => e.textContent);
    expect(gaps).toContain('需 体质≥2');
    expect(gaps).toContain('需 设计≥3、沟通≥1');
    expect(gaps).toContain('需 财商≥6、信誉≥700');
  });

  it('⚠️ 缺口文案每行只出现一次（视觉验证曾见「需 体质≥2需 体质≥2」）', async () => {
    route();
    renderWork();
    await screen.findByText('外卖骑手');
    const row = screen.getAllByTestId('job-row')
      .find(r => r.dataset['eligible'] === '0');
    const occurrences = (row?.textContent ?? '').split('需 体质≥2').length - 1;
    expect(occurrences).toBe(1);
  });

  it('⚠️ 点击置灰职业的排班按钮不发请求', async () => {
    route();
    renderWork();
    await screen.findByText('外卖骑手');
    const before = fetchMock.mock.calls.filter(
      c => String(c[0]) === '/api/shifts' && (c[1] as RequestInit)?.method === 'POST',
    ).length;
    const rows = screen.getAllByTestId('job-row');
    const locked = rows.find(r => r.dataset['eligible'] === '0');
    fireEvent.click(locked?.querySelector('[data-testid="schedule-job"]') as Element);
    const after = fetchMock.mock.calls.filter(
      c => String(c[0]) === '/api/shifts' && (c[1] as RequestInit)?.method === 'POST',
    ).length;
    expect(after).toBe(before);      // 关键：disabled 按钮点不动
  });

  it('有溢出能力时显示工资涨幅', async () => {
    route({ jobs: [{ id: 1, name: '老手', base_pay: 100_000, min_credit: null,
      reqs: [['FIT', 2]], eligible: true, wage: 110_000 }] });
    renderWork();
    expect(await screen.findByTestId('wage-bonus')).toHaveTextContent('+10.00%');
  });

  it('无涨幅时不显示加价标签', async () => {
    route({ jobs: [{ id: 1, name: '新手', base_pay: 100_000, min_credit: null,
      reqs: [], eligible: true, wage: 100_000 }] });
    renderWork();
    await screen.findByText('新手');
    expect(screen.queryByTestId('wage-bonus')).toBeNull();
  });
});

describe('Work 排班', () => {
  it('排班成功提示班次号并刷新', async () => {
    route({ schedule: { shiftId: 77, shifts: [] } });
    renderWork();
    await screen.findByText('传单派发员');
    const ok = screen.getAllByTestId('job-row').find(r => r.dataset['eligible'] === '1');
    fireEvent.click(ok?.querySelector('[data-testid="schedule-job"]') as Element);
    expect(await screen.findByText(/已排班「传单派发员」，班次 #77/)).toBeInTheDocument();
  });

  it('⚠️ SHIFT_CAP 映射中文（不把裸码甩给用户）', async () => {
    route({ schedule: { code: 'SHIFT_CAP', message: 'cap' }, scheduleStatus: 429 });
    renderWork();
    await screen.findByText('传单派发员');
    const ok = screen.getAllByTestId('job-row').find(r => r.dataset['eligible'] === '1');
    fireEvent.click(ok?.querySelector('[data-testid="schedule-job"]') as Element);
    const t = await screen.findByRole('status');
    expect(t.textContent).toBe('今日排班已达上限');
    expect(t.textContent).not.toContain('SHIFT_CAP');
  });

  it('JOB_REQUIREMENT 映射中文', async () => {
    route({ schedule: { code: 'JOB_REQUIREMENT', message: 'x' }, scheduleStatus: 403 });
    renderWork();
    await screen.findByText('传单派发员');
    const ok = screen.getAllByTestId('job-row').find(r => r.dataset['eligible'] === '1');
    fireEvent.click(ok?.querySelector('[data-testid="schedule-job"]') as Element);
    const t = await screen.findByRole('status');
    expect(t.textContent).not.toBe('');
    expect(t.textContent).not.toContain('JOB_REQUIREMENT');   // 不得把裸码甩给用户
  });
});

describe('Work 我的排班', () => {
  it('空排班显示空态', async () => {
    route({ shifts: [] });
    renderWork();
    expect(await screen.findByText(/还没有排班/)).toBeInTheDocument();
  });

  it('渲染四种状态的徽标文案', async () => {
    route({ shifts: [
      shift({ id: 1, status: 'scheduled' }),
      shift({ id: 2, status: 'working', start_gmin: 1000, end_gmin: 1480 }),
      shift({ id: 3, status: 'done', pay: 80_000 }),
      shift({ id: 4, status: 'cancelled' }),
    ] });
    renderWork();
    await screen.findByTestId('shift-list');
    const labels = screen.getAllByTestId('shift-status').map(e => e.textContent);
    expect(labels).toEqual(['已排班', '进行中', '已完成', '已取消']);
  });

  it('已完成的班次显示薪酬', async () => {
    route({ shifts: [shift({ id: 3, status: 'done', pay: 80_000 })] });
    renderWork();
    expect(await screen.findByText('薪酬 ¥800.00')).toBeInTheDocument();
  });

  it('进行中的班次显示进度条', async () => {
    // gmin 由 lastTick 推导：lastTick=539 → completed=540 → gmin=648
    // 班次 1000..1480 → 还没开始，故这里用已开始的班次
    route({ lastTick: 539, shifts: [shift({ id: 2, status: 'working', start_gmin: 500, end_gmin: 980 })] });
    renderWork();
    expect(await screen.findByTestId('shift-progress')).toBeInTheDocument();
  });

  it('未开始的 scheduled 班次给取消按钮', async () => {
    // gmin=648 < start=5000 → 可取消
    route({ lastTick: 539, shifts: [shift({ id: 11, status: 'scheduled', start_gmin: 5000 })] });
    renderWork();
    expect(await screen.findByTestId('cancel-shift')).toBeInTheDocument();
  });

  it('已开始的班次不给取消按钮（与服务端 SHIFT_STARTED 同口径）', async () => {
    // gmin=648 ≥ start=100 → 不可取消
    route({ lastTick: 539, shifts: [shift({ id: 11, status: 'scheduled', start_gmin: 100 })] });
    renderWork();
    await screen.findByTestId('shift-row');
    expect(screen.queryByTestId('cancel-shift')).toBeNull();
  });

  it('取消班次后提示成功', async () => {
    route({ lastTick: 539, shifts: [shift({ id: 11, status: 'scheduled', start_gmin: 5000 })] });
    renderWork();
    fireEvent.click(await screen.findByTestId('cancel-shift'));
    expect(await screen.findByText(/已取消班次 #11/)).toBeInTheDocument();
  });

  it('取消失败（已开始）映射中文', async () => {
    route({ lastTick: 539, shifts: [shift({ id: 11, status: 'scheduled', start_gmin: 5000 })],
      cancelStatus: 409 });
    renderWork();
    fireEvent.click(await screen.findByTestId('cancel-shift'));
    const t = await screen.findByRole('status');
    expect(t.textContent).not.toBe('');
    expect(t.textContent).not.toContain('409');
  });

  it('班次显示所属游戏日与时长', async () => {
    // start_gmin = 5000 → 第 floor(5000/1440)+1 = 4 日
    route({ shifts: [shift({ id: 11, start_gmin: 5000, end_gmin: 5480 })] });
    renderWork();
    const row = await screen.findByTestId('shift-row');
    expect(row.textContent).toContain('第 4 日');
    expect(row.textContent).toContain('8 小时');
  });
});

describe('Work 错误态', () => {
  it('jobs 失败显示错误页与重试', async () => {
    fetchMock.mockResolvedValue(json({ code: 'INTERNAL', message: 'boom' }, 500));
    renderWork();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('healthz 失败不阻塞职业列表（进度条缺失可接受）', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/healthz')) return Promise.resolve(json({ code: 'X' }, 500));
      if (url === '/api/jobs') return Promise.resolve(json({ jobs }));
      if (url.startsWith('/api/shifts')) return Promise.resolve(json({ shifts: [] }));
      return Promise.resolve(json({}));
    });
    renderWork();
    expect(await screen.findByText('传单派发员')).toBeInTheDocument();
  });
});

describe('Work 刷新语义', () => {
  it('排班成功后重新拉取 jobs 与 shifts', async () => {
    route({ schedule: { shiftId: 77, shifts: [] } });
    renderWork();
    await screen.findByText('传单派发员');
    const ok = screen.getAllByTestId('job-row').find(r => r.dataset['eligible'] === '1');
    fireEvent.click(ok?.querySelector('[data-testid="schedule-job"]') as Element);
    await screen.findByText(/班次 #77/);
    await waitFor(() => {
      const jobCalls = fetchMock.mock.calls.filter(c => String(c[0]) === '/api/jobs').length;
      expect(jobCalls).toBeGreaterThanOrEqual(2);
    });
  });
});
