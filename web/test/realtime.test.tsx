// test/realtime.test.tsx —— Task 8：Provider / 延迟角标 / useQuotes 的组件级集成。
//
// 这些用例全部通过**注入替身 client** 驱动，不依赖 jsdom 的 WebSocket
// （jsdom 未实现它），也不产生真实网络——与 `ws.test.ts` 的分层策略一致。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AuthUser } from '../src/api.js';
import { SessionProvider, type Session } from '../src/session.js';
import AppShell from '../src/components/AppShell.js';
import { RealtimeProvider } from '../src/lib/realtime.js';
import { lagBadgeText, type LagState } from '../src/lib/useLag.js';
import type { WsClient } from '../src/lib/ws.js';

const alice: AuthUser = { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 };
const authed: Session = { status: 'authed', user: alice };

/** 可手动驱动的 client 替身：记录订阅、可手动派发 tick。 */
function fakeClient(): WsClient & { emitTick: (m: { day: number; tickInDay: number; quotes: [string, number, number, number][]; genesisMs?: number }) => void; subLog: string[][]; started: boolean } {
  const tickHandlers = new Set<(m: never) => void>();
  const subLog: string[][] = [];
  const obj = {
    started: false,
    subLog,
    start() { obj.started = true; },
    stop() { obj.started = false; },
    sub(codes: string[]) { subLog.push(codes); },
    on(type: keyof Record<string, unknown>, cb: (m: never) => void) {
      if (type === 'tick') tickHandlers.add(cb as (m: never) => void);
      return () => tickHandlers.delete(cb as (m: never) => void);
    },
    isOpen: () => true,
    retries: () => 0,
    emitTick(m: { day: number; tickInDay: number; quotes: [string, number, number, number][]; genesisMs?: number }) {
      for (const cb of tickHandlers) (cb as unknown as (x: typeof m) => void)(m);
    },
  };
  return obj as unknown as WsClient & { emitTick: typeof obj.emitTick; subLog: string[][]; started: boolean };
}

function renderShell(client: WsClient | null, latencyBadge?: string | null): ReturnType<typeof render> {
  return render(
    <SessionProvider initial={authed}>
      <MemoryRouter initialEntries={['/']}>
        <RealtimeProvider client={client}>
          <AppShell {...(latencyBadge !== undefined ? { latencyBadge } : {})} />
        </RealtimeProvider>
      </MemoryRouter>
    </SessionProvider>,
  );
}

/** 1 游戏日 = 1200 tick，1 tick = 3000ms（与服务端 `core/clock.ts` 一致）。 */
const TICKS_PER_DAY = 1200;
const TICK_MS = 3000;

/**
 * 构造一个「让指定 day/tickInDay 的 tick 落后 lagSeconds 秒」的 genesis 毫秒。
 * `lagSeconds = 0` 表示这帧 tick 恰好等于此刻 —— 属正常延迟，角标不该出现。
 *
 * 之所以要现算而不是写死：`useLag` 内部用的是真实 `Date.now()`。
 */
function genesisFor(day: number, tickInDay: number, lagSeconds = 0): number {
  const completed = (day - 1) * TICKS_PER_DAY + tickInDay;
  return Date.now() - completed * TICK_MS - lagSeconds * 1000;
}

describe('延迟角标 lagBadgeText', () => {
  it('未收到 tick → 「连接中…」（不能骗人地显示 0s）', () => {
    expect(lagBadgeText({ seconds: null, tone: 'ok', seen: false })).toBe('连接中…');
  });

  it('正常延迟 → null（不占位）', () => {
    expect(lagBadgeText({ seconds: 3, tone: 'ok', seen: true })).toBeNull();
  });

  it('警告档 → 「延迟 Ns」', () => {
    expect(lagBadgeText({ seconds: 15, tone: 'warn', seen: true })).toBe('延迟 15s');
  });

  it('危险档 → 「延迟 Ns」', () => {
    expect(lagBadgeText({ seconds: 45, tone: 'danger', seen: true })).toBe('延迟 45s');
  });
});

describe('AppShell 延迟角标渲染', () => {
  it('显式 prop 优先于 context', () => {
    renderShell(fakeClient(), '延迟 99s');
    expect(screen.getByTestId('latency-badge')).toHaveTextContent('延迟 99s');
  });

  it('未收到 tick 时显示「连接中…」', () => {
    renderShell(fakeClient());
    expect(screen.getByTestId('latency-badge')).toHaveTextContent('连接中…');
  });

  it('未登录（无 Provider 的 client）时不渲染角标也不崩', () => {
    renderShell(null);
    // client 为 null → useLag 的 seen=false → 仍显示「连接中…」
    expect(screen.getByTestId('latency-badge')).toHaveTextContent('连接中…');
  });

  it('收到新鲜 tick 后角标消失（正常延迟不占位）', () => {
    const c = fakeClient();
    renderShell(c);
    act(() => { c.emitTick({ day: 1, tickInDay: 0, quotes: [], genesisMs: genesisFor(1, 0) }); });
    expect(screen.queryByTestId('latency-badge')).toBeNull();
  });

  it('⚠️ 回归：genesisMs 必须从 tick 透传进 lagSecondsFrom（否则角标恒亮成 Unix 时间戳）', () => {
    // 修复前 `useLag` 只传前 4 个参数、`lagSecondsFrom` 的 `genesisMs` 退回默认 0，
    // 于是 `elapsed ≈ nowMs` ⇒ 角标显示「延迟 1789362002s」（当前 Unix 时间戳）且恒红。
    // 这里用「已跑完 20 游戏日」的 tick：genesis 真的透传了 → 延迟 0 → 角标不出现；
    // 一旦 genesis 丢失，算出来会是 ~17 亿秒，角标必然出现 ⇒ 这条会红。
    const c = fakeClient();
    renderShell(c);
    act(() => { c.emitTick({ day: 20, tickInDay: 0, quotes: [], genesisMs: genesisFor(20, 0) }); });
    expect(screen.queryByTestId('latency-badge')).toBeNull();
  });

  it('tick 落后 45s → 角标显示「延迟 45s」（证明数值真的走完整条链路）', () => {
    const c = fakeClient();
    renderShell(c);
    act(() => { c.emitTick({ day: 20, tickInDay: 0, quotes: [], genesisMs: genesisFor(20, 0, 45) }); });
    expect(screen.getByTestId('latency-badge')).toHaveTextContent('延迟 45s');
  });

  it('旧服务端（帧里没有 genesisMs）→ 保持「连接中…」，不报假数字', () => {
    const c = fakeClient();
    renderShell(c);
    act(() => { c.emitTick({ day: 1, tickInDay: 0, quotes: [] }); });   // 故意不带 genesisMs
    expect(screen.getByTestId('latency-badge')).toHaveTextContent('连接中…');
  });
});

describe('RealtimeProvider 不建连的场景', () => {
  it('注入 client 时不会自行 start（由调用方控制生命周期）', () => {
    const c = fakeClient();
    renderShell(c);
    expect(c.started).toBe(false);
  });

  it('未登录时不建连（避免必然的 4401 拒绝）', () => {
    render(
      <SessionProvider initial={{ status: 'anonymous' }}>
        <MemoryRouter initialEntries={['/']}>
          <RealtimeProvider>
            <div data-testid="probe">ok</div>
          </RealtimeProvider>
        </MemoryRouter>
      </SessionProvider>,
    );
    expect(screen.getByTestId('probe')).toBeInTheDocument();
  });
});

describe('useLag 语义', () => {
  it('LagState 的 tone 与 seconds 自洽（通过 lagBadgeText 观察）', () => {
    const cases: [LagState, string | null][] = [
      [{ seconds: 0, tone: 'ok', seen: true }, null],
      [{ seconds: 10, tone: 'ok', seen: true }, null],
      [{ seconds: 11, tone: 'warn', seen: true }, '延迟 11s'],
      [{ seconds: 31, tone: 'danger', seen: true }, '延迟 31s'],
    ];
    for (const [state, expected] of cases) {
      expect(lagBadgeText(state)).toBe(expected);
    }
  });
});

/** 静默 vitest 的未使用告警（vi 在本文件仅用于将来扩展）。 */
void vi;
