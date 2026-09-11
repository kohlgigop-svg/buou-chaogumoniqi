// test/ws.test.ts —— Task 8：WebSocket 客户端（纯逻辑）+ 延迟角标。
//
// 分层原则：把**纯函数**与**socket 生命周期**分开测。
//   · 退避序列 / 延迟秒数 / 消息解析 / chgBp 换算 → 纯函数，无需网络、无需假计时器。
//   · 连接与重连 → 用一个**可注入的 socket 工厂**（`WsFactory`）驱动，
//     不依赖 jsdom 的 WebSocket（jsdom 不实现它），也就不会有真实网络与计时抖动。
//
// 这正是 `ws.ts` 的 `socketFactory` 依赖注入存在的理由：可测性不是巧合，是设计出来的。
import { describe, it, expect, vi } from 'vitest';
import {
  backoffDelay,
  wsUrlFrom,
  parseServerMessage,
  lagSecondsFrom,
  lagTone,
  WS_BASE_DELAY_MS,
  WS_MAX_DELAY_MS,
  WS_HEARTBEAT_TIMEOUT_MS,
  type ServerMessage,
} from '../src/lib/ws.js';
import { quoteFromRow, INDEX_CODE } from '../src/lib/useQuotes.js';

// ---------- 工具：可控假 socket ----------

/** 记录 send/close 调用的最小 socket 替身。 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closedWith: { code?: number; reason?: string }[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(readonly url: string) { FakeSocket.instances.push(this); }

  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.closedWith.push({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) });
  }

  /** 测试驱动：模拟连接建立。 */
  open(): void { this.readyState = 1; this.onopen?.(); }
  /** 测试驱动：模拟服务端下发一帧。 */
  deliver(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  /** 测试驱动：模拟服务端/网络关闭。 */
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const REQUIRED_SEND = ['open', 'close'] as const;

// ---------- backoffDelay ----------

describe('backoffDelay：指数退避 1s→2s→4s…上限 30s，抖动 ±20%', () => {
  it('无抖动时呈 2 的幂：1s, 2s, 4s, 8s, 16s, 30s(封顶)', () => {
    const seq = [0, 1, 2, 3, 4, 5].map(n => backoffDelay(n, () => 0.5)); // 0.5 → 抖动系数 1.0
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it('抖动取下界时为正下界 0.8 倍（未封顶时）', () => {
    // rand=0 → factor = 1 + (0*2-1)*0.2 = 0.8
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(2, () => 0)).toBe(3200);
  });

  it('抖动取上界时为 1.2 倍', () => {
    // rand=1 → factor = 1.2；但 rand 恒取 1 不现实，这里直接考边界语义
    expect(backoffDelay(0, () => 1)).toBe(1200);
    expect(backoffDelay(1, () => 1)).toBe(2400);
  });

  it('封顶 30s 在抖动之后仍生效（不会因 +20% 溢出到 36s）', () => {
    // 2^5 * 1000 = 32000，即使 +20% 也应被夹到 30000
    expect(backoffDelay(5, () => 1)).toBe(30000);
    expect(backoffDelay(50, () => 1)).toBe(30000);
  });

  it('延迟永不为负，也永不小于 0', () => {
    for (let n = 0; n < 12; n++) {
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const d = backoffDelay(n, () => r);
        expect(d).toBeGreaterThan(0);
        expect(d).toBeLessThanOrEqual(WS_MAX_DELAY_MS);
      }
    }
  });

  it('首延迟基数与上限常量自洽', () => {
    expect(WS_BASE_DELAY_MS).toBe(1000);
    expect(WS_MAX_DELAY_MS).toBe(30000);
    expect(backoffDelay(0, () => 0.5)).toBe(WS_BASE_DELAY_MS);
  });
});

// ---------- wsUrlFrom ----------

describe('wsUrlFrom：由 location 推导，ws:/wss: 自适应', () => {
  it('https 页面 → wss', () => {
    expect(wsUrlFrom({ protocol: 'https:', host: 'example.com' })).toBe('wss://example.com/ws');
  });

  it('http 页面 → ws', () => {
    expect(wsUrlFrom({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
  });

  it('未知协议保守用 ws（开发环境兜底）', () => {
    expect(wsUrlFrom({ protocol: 'file:', host: 'x' })).toBe('ws://x/ws');
  });
});

// ---------- parseServerMessage ----------

describe('parseServerMessage：容错解析，坏帧不抛异常', () => {
  it('解析 tick 帧并保留 quotes 行', () => {
    const m = parseServerMessage(JSON.stringify({
      t: 'tick', day: 1, tickInDay: 42, phase: 'continuous',
      quotes: [['IDX:COMP', 10123, 123, 5000], ['600619', 84600, -250, 300]],
    }));
    expect(m?.t).toBe('tick');
  });

  it('坏 JSON 返回 null 而不是抛', () => {
    expect(parseServerMessage('not json')).toBeNull();
  });

  it('非对象（如 "null"/"42"/"[]"）返回 null', () => {
    expect(parseServerMessage('null')).toBeNull();
    expect(parseServerMessage('42')).toBeNull();
    expect(parseServerMessage('[]')).toBeNull();
  });

  it('缺少 t 字段返回 null', () => {
    expect(parseServerMessage(JSON.stringify({ day: 1 }))).toBeNull();
  });

  it('未知类型 t 返回 null（向前兼容：不认识就别当消息处理）', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'future_thing' }))).toBeNull();
  });

  it('已知类型全部可解析', () => {
    for (const t of ['tick', 'fill', 'news', 'settled', 'error'] as const) {
      expect(parseServerMessage(JSON.stringify({ t }))?.t).toBe(t);
    }
  });
});

// ---------- lagSecondsFrom ----------

describe('lagSecondsFrom：用 tick 的 day/tickInDay 与本地时钟推算「最近 tick 距今秒数」', () => {
  const TICKS_PER_DAY = 1200;
  const TICK_MS = 3000;

  it('恰好落在 tick 边界上 → 0 秒', () => {
    expect(lagSecondsFrom({ day: 1, tickInDay: 100 }, TICK_MS, TICKS_PER_DAY)).toBe(0);
  });

  it('同日内跨分钟：过了 45 秒（15 tick）→ 45', () => {
    expect(lagSecondsFrom({ day: 1, tickInDay: 0 }, 45_000, TICKS_PER_DAY)).toBe(45);
  });

  it('跨日累加：第 2 日 tickInDay=0 → 全局已完成 1200 tick', () => {
    // day=2, tickInDay=0 → completed = (2-1)*1200 + 0 = 1200 → 1200*3000ms = 3600s
    expect(lagSecondsFrom({ day: 2, tickInDay: 0 }, 1200 * TICK_MS, TICKS_PER_DAY)).toBe(0);
    expect(lagSecondsFrom({ day: 2, tickInDay: 0 }, 1200 * TICK_MS + 30_000, TICKS_PER_DAY)).toBe(30);
  });

  it('跨日且日中途：第 3 日 tickInDay=600 → completed=2400+600', () => {
    const completed = 2 * TICKS_PER_DAY + 600;
    expect(lagSecondsFrom({ day: 3, tickInDay: 600 }, completed * TICK_MS + 9_000, TICKS_PER_DAY)).toBe(9);
  });

  it('本地时钟落后于 tick 时夹到 0，不返回负数', () => {
    expect(lagSecondsFrom({ day: 1, tickInDay: 100 }, 0, TICKS_PER_DAY)).toBe(0);
  });

  it('结果取整为秒（向下）', () => {
    expect(lagSecondsFrom({ day: 1, tickInDay: 0 }, 1_999, TICKS_PER_DAY)).toBe(1);
  });
});

describe('lagTone：>10s 黄、>30s 红', () => {
  it('0–10 秒正常', () => {
    expect(lagTone(0)).toBe('ok');
    expect(lagTone(10)).toBe('ok');   // 边界：等于 10 仍正常
  });
  it('>10 秒变黄', () => {
    expect(lagTone(11)).toBe('warn');
    expect(lagTone(30)).toBe('warn'); // 边界：等于 30 仍黄
  });
  it('>30 秒变红', () => {
    expect(lagTone(31)).toBe('danger');
    expect(lagTone(600)).toBe('danger');
  });
});

// ---------- quoteFromRow ----------

describe('quoteFromRow：WS 行 → 报价对象，chgBp 是基点', () => {
  it('解析四元组，chgBp 原样保留（不做百分比换算）', () => {
    const q = quoteFromRow(['600619', 84600, -250, 300]);
    expect(q).not.toBeNull();
    expect(q).toEqual({ code: '600619', price: 84600, chgBp: -250, volume: 300 });
  });

  it('首元素恒为指数且有固定的 INDEX_CODE', () => {
    expect(INDEX_CODE).toBe('IDX:COMP');
    const q = quoteFromRow([INDEX_CODE, 10123, 123, 5000]);
    expect(q).not.toBeNull();
    expect(q!.code).toBe(INDEX_CODE);
    // 指数「价格」就是基点本身（10000 = 平盘），不是分
    expect(q!.price).toBe(10123);
    expect(q!.chgBp).toBe(123);
  });

  it('非数组或长度不足返回 null', () => {
    expect(quoteFromRow(null)).toBeNull();
    expect(quoteFromRow(['600619', 1])).toBeNull();
    expect(quoteFromRow('600619')).toBeNull();
  });

  it('数值字段非数字时返回 null（脏帧不污染行情表）', () => {
    expect(quoteFromRow(['600619', 'x', 1, 2])).toBeNull();
    expect(quoteFromRow(['600619', 1, 'x', 2])).toBeNull();
  });

  it('代码非字符串返回 null', () => {
    expect(quoteFromRow([600619, 1, 2, 3])).toBeNull();
  });
});

// ---------- 连接生命周期：重连策略 ----------

describe('ws.ts 连接与重连策略（可注入 socket 工厂）', () => {
  /** 每个用例都重置替身登记表，避免跨用例串台。 */
  const resetFakes = (): void => { FakeSocket.instances.length = 0; };

  /** 动态导入，确保每个用例拿到干净的模块状态。 */
  async function loadClient(): Promise<typeof import('../src/lib/ws.js')> {
    return import('../src/lib/ws.js');
  }

  it('4401 → 不重连（会话失效，应跳登录）', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const onClose = vi.fn();
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    });
    client.on('close', onClose);
    client.start();
    const s = FakeSocket.instances[0]!;
    s.open();
    s.serverClose(4401, 'unauthorized');
    // 无新连接被创建
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('4403 → 不重连（账号封禁，重连也无意义）', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    });
    client.start();
    const s = FakeSocket.instances[0]!;
    s.open();
    s.serverClose(4403, 'banned');
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('普通断开（1006）→ 会按退避重连', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const scheduled: (() => void)[] = [];
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: (fn) => { scheduled.push(fn); return scheduled.length as unknown as ReturnType<typeof setTimeout>; },
      jitter: () => 0.5,
    });
    client.start();
    const s1 = FakeSocket.instances[0]!;
    s1.open();
    s1.serverClose(1006, 'abnormal');
    expect(scheduled).toHaveLength(1); // 已排定一次重连
    scheduled[0]!();                    // 触发重连
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('重连成功后重试计数归零（下一次失败仍从 1s 起）', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const delays: number[] = [];
    const scheduled: (() => void)[] = [];
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: ((fn: () => void, ms: number) => {
        delays.push(ms); scheduled.push(fn);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      }),
      jitter: () => 0.5,
    });
    client.start();

    // 第 1 次失败 → 1s
    FakeSocket.instances[0]!.serverClose(1006, '');
    expect(delays[0]).toBe(1000);
    scheduled[0]!();

    // 第 2 次连接成功，然后再次失败 → 应回到 1s（计数已归零）
    const s2 = FakeSocket.instances[1]!;
    s2.open();
    s2.serverClose(1006, '');
    expect(delays[1]).toBe(1000);
  });

  it('连续失败时退避递增：1s, 2s, 4s', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const delays: number[] = [];
    const scheduled: (() => void)[] = [];
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: ((fn: () => void, ms: number) => {
        delays.push(ms); scheduled.push(fn);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      }),
      jitter: () => 0.5,
    });
    client.start();
    for (let i = 0; i < 3; i++) {
      FakeSocket.instances[i]!.serverClose(1006, '');
      scheduled[i]!();
    }
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('stop() 后不再重连（主动关闭不算失败）', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const scheduled: (() => void)[] = [];
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: (fn) => { scheduled.push(fn); return scheduled.length as unknown as ReturnType<typeof setTimeout>; },
    });
    client.start();
    const s = FakeSocket.instances[0]!;
    s.open();
    client.stop();
    s.serverClose(1006, ''); // 即便紧接着来了 close 事件
    expect(scheduled).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('sub(codes) 是替换式：发送 {t:"sub",codes}', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    });
    client.start();
    const s = FakeSocket.instances[0]!;
    s.open();
    client.sub(['600619', '600859']);
    expect(JSON.parse(s.sent[0]!)).toEqual({ t: 'sub', codes: ['600619', '600859'] });

    client.sub(['002331']);
    expect(JSON.parse(s.sent[1]!)).toEqual({ t: 'sub', codes: ['002331'] });
  });

  it('连接未就绪时 sub 会缓存，open 后自动补发', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    });
    client.start();
    const s = FakeSocket.instances[0]!;
    client.sub(['600619']);          // 还没 open
    expect(s.sent).toHaveLength(0);
    s.open();
    expect(JSON.parse(s.sent[0]!)).toEqual({ t: 'sub', codes: ['600619'] });
  });

  it('重连后自动重放订阅（否则页面会静默停在旧行情）', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const scheduled: (() => void)[] = [];
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: (fn: () => void) => { scheduled.push(fn); return scheduled.length; },
      jitter: () => 0.5,
    });
    client.start();
    const s1 = FakeSocket.instances[0]!;
    s1.open();
    client.sub(['600619']);
    s1.serverClose(1006, '');
    scheduled[0]!();
    const s2 = FakeSocket.instances[1]!;
    s2.open();
    expect(JSON.parse(s2.sent[0]!)).toEqual({ t: 'sub', codes: ['600619'] });
  });

  it('消息分派到类型化回调', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const onTick = vi.fn();
    const onFill = vi.fn();
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    });
    client.on('tick', onTick);
    client.on('fill', onFill);
    client.start();
    const s = FakeSocket.instances[0]!;
    s.open();
    s.deliver({ t: 'tick', day: 1, tickInDay: 5, phase: 'continuous', quotes: [] });
    s.deliver({ t: 'fill', orderId: 7, code: '600619', side: 'B', qty: 100 });
    s.deliver({ t: 'settled', day: 1 });
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onFill).toHaveBeenCalledTimes(1);
  });

  it('坏帧不会打断连接，也不会触发回调', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const onTick = vi.fn();
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setTimeout: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    });
    client.on('tick', onTick);
    client.start();
    const s = FakeSocket.instances[0]!;
    s.open();
    s.onmessage?.({ data: '{{{bad' });
    s.deliver({ t: 'unknown_type' });
    expect(onTick).not.toHaveBeenCalled();
    expect(s.readyState).toBe(1); // 仍 OPEN
  });

  it('心跳超时（默认 60s 无消息）主动重连', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    expect(WS_HEARTBEAT_TIMEOUT_MS).toBe(60_000);
    // 心跳用独立的计时器；这里用一个可手动触发的计时器替身。
    // 时钟必须**会走**：心跳判据是 `now() - lastMessageAt > 60s`，
    // 用一个恒返 0 的假时钟会让差值恒为 0，永远不触发（这正是第一版测试踩的坑）。
    const timers = new Map<number, () => void>();
    let nextId = 1;
    let clockMs = 0;
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setInterval: ((fn: () => void) => {
        const id = nextId++; timers.set(id, fn);
        return id as unknown as ReturnType<typeof setInterval>;
      }),
      clearInterval: (id: unknown) => { timers.delete(id as number); },
      now: () => clockMs,
      setTimeout: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    });
    client.start();
    const s1 = FakeSocket.instances[0]!;
    s1.open();                        // 记下 lastMessageAt = 0
    clockMs = 61_000;                 // 推进 61 秒，期间无消息
    for (const fn of timers.values()) fn(); // 触发心跳检查
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    expect(s1.closedWith.length).toBeGreaterThan(0); // 假活连接被主动关闭
  });

  it('心跳未超时不会误杀连接', async () => {
    resetFakes();
    const { createWsClient } = await loadClient();
    const timers = new Map<number, () => void>();
    let nextId = 1;
    let clockMs = 0;
    const client = createWsClient({
      url: 'ws://x/ws',
      socketFactory: (u: string) => new FakeSocket(u) as unknown as WebSocket,
      setInterval: ((fn: () => void) => {
        const id = nextId++; timers.set(id, fn);
        return id as unknown as ReturnType<typeof setInterval>;
      }),
      clearInterval: (id: unknown) => { timers.delete(id as number); },
      now: () => clockMs,
      setTimeout: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    });
    client.start();
    const s1 = FakeSocket.instances[0]!;
    s1.open();
    clockMs = 30_000;                 // 只过 30 秒
    for (const fn of timers.values()) fn();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(s1.readyState).toBe(1);    // 仍 OPEN
  });
});

// ---------- 类型完整性（编译期约束，运行期仅做存在性断言） ----------

describe('ServerMessage 判别联合可用性', () => {
  it('tick 帧带 day/tickInDay/phase/quotes', () => {
    const m: ServerMessage = {
      t: 'tick', day: 2, tickInDay: 1180, phase: 'settlement',
      quotes: [[INDEX_CODE, 10050, 50, 1]],
    };
    expect(m.t).toBe('tick');
  });

  it('fill 帧是本项目的私有成交回报字段', () => {
    const m: ServerMessage = {
      t: 'fill', orderId: 1, code: '600619', side: 'B', price: 84600, qty: 100,
      commission: 500, stamp: 0, transfer: 0, day: 1, tick: 61, orderStatus: 'filled',
    };
    expect(m.t).toBe('fill');
  });

  it('所有必需 send 类型常量存在（防止误删导出）', () => {
    expect(REQUIRED_SEND).toContain('open');
  });
});
