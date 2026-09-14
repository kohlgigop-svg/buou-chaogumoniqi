import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AuthUser } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import AppShell from '../src/components/AppShell.js';
import { FillToasts, ToastHost, fillToToast, type ToastItem } from '../src/components/Toast.js';
import { RealtimeProvider } from '../src/lib/realtime.js';
import type { FillMessage, WsClient } from '../src/lib/ws.js';

// 成交提示（规格 §4.4）：成交回报经 WS 即时推送，前端必须给出可见落点。
//
// 重点验：
// 1. 消息 → 文案：买卖方向、逐笔费用明细、全部/部分成交措辞
// 2. 同 orderId 合并：部分成交连推多条只留一条，且是最新一条
// 3. 自动消隐与手动关闭
// 4. 挂在 AppShell 上：跨页常驻（成交时用户可能已离开个股页）

const alice: AuthUser = { id: 1, username: 'alice', credit: 700, isAdmin: false, bankruptCount: 0 };

function fill(over: Partial<FillMessage> = {}): FillMessage {
  return {
    t: 'fill', orderId: 42, code: '600519', side: 'B', price: 5000, qty: 100,
    commission: 500, stamp: 0, transfer: 5, day: 5, tick: 200, orderStatus: 'partial',
    ...over,
  };
}

/** 可手动派发 `fill` 的 client 替身（与 realtime.test 的 fakeClient 同套路数）。 */
function fakeClient(): WsClient & { emitFill: (m: FillMessage) => void; subLog: string[][] } {
  const fillHandlers = new Set<(m: FillMessage) => void>();
  const subLog: string[][] = [];
  const obj = {
    subLog,
    start() { /* noop */ },
    stop() { /* noop */ },
    sub(codes: string[]) { subLog.push(codes); },
    on(type: string, cb: (m: never) => void) {
      if (type === 'fill') fillHandlers.add(cb as unknown as (m: FillMessage) => void);
      return () => { fillHandlers.delete(cb as unknown as (m: FillMessage) => void); };
    },
    isOpen: () => true,
    retries: () => 0,
    emitFill(m: FillMessage) { for (const cb of fillHandlers) cb(m); },
  };
  return obj as unknown as WsClient & { emitFill: (m: FillMessage) => void; subLog: string[][] };
}

describe('fillToToast：成交消息 → 提示条目', () => {
  it('买单：标题标「买入成交 <代码>」，tone 为 up（红）', () => {
    const t = fillToToast(fill({ side: 'B' }));
    expect(t.title).toBe('买入成交 600519');
    expect(t.tone).toBe('up');
  });

  it('卖单：标题标「卖出成交」，tone 为 down（绿）', () => {
    const t = fillToToast(fill({ side: 'S' }));
    expect(t.title).toBe('卖出成交 600519');
    expect(t.tone).toBe('down');
  });

  it('明细含数量、成交价与逐笔费用（佣金/印花税/过户费）', () => {
    const t = fillToToast(fill({ qty: 300, price: 5120, commission: 1536, stamp: 1536, transfer: 15 }));
    expect(t.detail).toContain('300 股 @ ¥51.20');
    expect(t.detail).toContain('佣金 ¥15.36');
    expect(t.detail).toContain('印花税 ¥15.36');
    expect(t.detail).toContain('过户费 ¥0.15');
  });

  it('orderStatus=done → 「已全部成交」；否则「部分成交」', () => {
    expect(fillToToast(fill({ orderStatus: 'done' })).detail).toContain('已全部成交');
    expect(fillToToast(fill({ orderStatus: 'partial' })).detail).toContain('部分成交');
  });

  it('key 按 orderId 生成（同单可被合并）', () => {
    expect(fillToToast(fill({ orderId: 7 })).key).toBe('fill-7');
    expect(fillToToast(fill({ orderId: 8 })).key).toBe('fill-8');
  });

  it('价格为「分」：5120 分 → ¥51.20，不是 ¥5120.00', () => {
    expect(fillToToast(fill({ price: 5120 })).detail).toContain('¥51.20');
  });
});

describe('ToastHost 渲染', () => {
  const items: ToastItem[] = [
    { key: 'fill-1', title: '买入成交 600519', detail: '100 股 @ ¥50.00｜已全部成交', tone: 'up' },
    { key: 'fill-2', title: '卖出成交 000001', detail: '200 股 @ ¥12.00｜部分成交', tone: 'down' },
  ];

  it('空列表 → 不渲染任何节点', () => {
    const { container } = render(<ToastHost items={[]} onDismiss={() => { /* noop */ }} autoHideMs={0} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('toast-host')).toBeNull();
  });

  it('渲染每条标题与明细，tone 落到类名上', () => {
    render(<ToastHost items={items} onDismiss={() => { /* noop */ }} autoHideMs={0} />);
    expect(screen.getAllByTestId('toast')).toHaveLength(2);
    expect(screen.getByText('买入成交 600519')).toBeInTheDocument();
    expect(screen.getByText('卖出成交 000001')).toBeInTheDocument();
    const [a, b] = screen.getAllByTestId('toast');
    expect(a?.className).toContain('filltoast--up');
    expect(b?.className).toContain('filltoast--down');
  });

  it('是 aria-live 区域（成交是异步发生的，读屏用户也需要被告知）', () => {
    render(<ToastHost items={items} onDismiss={() => { /* noop */ }} autoHideMs={0} />);
    expect(screen.getByTestId('toast-host')).toHaveAttribute('aria-live', 'polite');
  });

  it('点关闭按钮回调对应 key', () => {
    const onDismiss = vi.fn();
    render(<ToastHost items={items} onDismiss={onDismiss} autoHideMs={0} />);
    fireEvent.click(screen.getAllByLabelText('关闭')[1] as HTMLElement);
    expect(onDismiss).toHaveBeenCalledWith('fill-2');
  });
});

describe('ToastHost 自动消隐', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('到点后按 key 回调（每条各自计时）', () => {
    const onDismiss = vi.fn();
    render(<ToastHost items={[{ key: 'fill-1', title: 'x', detail: 'y', tone: 'up' }]}
      onDismiss={onDismiss} autoHideMs={3000} />);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(onDismiss).toHaveBeenCalledWith('fill-1');
  });

  it('autoHideMs=0 关闭自动消隐', () => {
    const onDismiss = vi.fn();
    render(<ToastHost items={[{ key: 'fill-1', title: 'x', detail: 'y', tone: 'up' }]}
      onDismiss={onDismiss} autoHideMs={0} />);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('卸载后计时器被清掉，不再回调（否则会悬空 setState）', () => {
    const onDismiss = vi.fn();
    const { unmount } = render(<ToastHost items={[{ key: 'fill-1', title: 'x', detail: 'y', tone: 'up' }]}
      onDismiss={onDismiss} autoHideMs={3000} />);
    unmount();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('FillToasts：接成交流 + 同单合并', () => {
  it('收到 fill 后弹出提示', () => {
    const c = fakeClient();
    render(
      <SessionProvider initial={{ status: 'authed', user: alice }}>
        <RealtimeProvider client={c}>
          <FillToasts autoHideMs={0} />
        </RealtimeProvider>
      </SessionProvider>,
    );
    expect(screen.queryByTestId('toast')).toBeNull();
    act(() => { c.emitFill(fill({ orderId: 42, qty: 100, orderStatus: 'partial' })); });
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(screen.getByText('买入成交 600519')).toBeInTheDocument();
  });

  it('⚠️ 同 orderId 连续推多条 → 只留一条，且是最新一条（部分成交不刷屏）', () => {
    const c = fakeClient();
    render(
      <SessionProvider initial={{ status: 'authed', user: alice }}>
        <RealtimeProvider client={c}>
          <FillToasts autoHideMs={0} />
        </RealtimeProvider>
      </SessionProvider>,
    );
    act(() => { c.emitFill(fill({ orderId: 42, qty: 100, orderStatus: 'partial' })); });
    act(() => { c.emitFill(fill({ orderId: 42, qty: 200, orderStatus: 'partial' })); });
    act(() => { c.emitFill(fill({ orderId: 42, qty: 300, orderStatus: 'done' })); });
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    const detail = screen.getByTestId('toast').textContent ?? '';
    expect(detail).toContain('300 股');       // 最新一条
    expect(detail).toContain('已全部成交');
    expect(detail).not.toContain('100 股');
  });

  it('不同订单各占一条', () => {
    const c = fakeClient();
    render(
      <SessionProvider initial={{ status: 'authed', user: alice }}>
        <RealtimeProvider client={c}>
          <FillToasts autoHideMs={0} />
        </RealtimeProvider>
      </SessionProvider>,
    );
    act(() => { c.emitFill(fill({ orderId: 1, code: '600519' })); });
    act(() => { c.emitFill(fill({ orderId: 2, code: '000001', side: 'S' })); });
    expect(screen.getAllByTestId('toast')).toHaveLength(2);
  });

  it('手动关闭后条目消失', () => {
    const c = fakeClient();
    render(
      <SessionProvider initial={{ status: 'authed', user: alice }}>
        <RealtimeProvider client={c}>
          <FillToasts autoHideMs={0} />
        </RealtimeProvider>
      </SessionProvider>,
    );
    act(() => { c.emitFill(fill()); });
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('未连接（client=null）时不崩，也不渲染提示', () => {
    render(
      <SessionProvider initial={{ status: 'authed', user: alice }}>
        <RealtimeProvider client={null}>
          <FillToasts autoHideMs={0} />
        </RealtimeProvider>
      </SessionProvider>,
    );
    expect(screen.queryByTestId('toast-host')).toBeNull();
  });
});

describe('AppShell 集成：成交通知跨页常驻', () => {
  // 放在 AppShell 而不是个股页的理由：限价单异步成交，用户可能已离开个股页。
  // 这条用例锁死「提示挂在 shell 上」这个决定，防止后人把它挪回个股页。
  it('停在首页也能收到成交通知', () => {
    const c = fakeClient();
    render(
      <SessionProvider initial={{ status: 'authed', user: alice }}>
        <MemoryRouter initialEntries={['/leaderboard']}>
          <RealtimeProvider client={c}>
            <AppShell><div data-testid="page">榜单</div></AppShell>
          </RealtimeProvider>
        </MemoryRouter>
      </SessionProvider>,
    );
    expect(screen.getByTestId('page')).toBeInTheDocument();
    act(() => { c.emitFill(fill({ orderId: 99, side: 'S', code: '000002' })); });
    expect(screen.getByText('卖出成交 000002')).toBeInTheDocument();
  });
});
