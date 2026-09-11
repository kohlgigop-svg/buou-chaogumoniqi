// lib/ws.ts —— WebSocket 客户端：建连 / 退避重连 / 心跳 / 替换式订阅 / 类型化分派。
//
// 设计要点（每条都有对应的实证理由，勿"简化"掉）：
//
// 1. **socket 工厂与计时器全部可注入**。jsdom 不实现 WebSocket，真实 WebSocket 又带
//    网络与计时抖动，会让测试变成 flaky 的集成测试。把 `socketFactory` / `setTimeout` /
//    `setInterval` / `now` / `jitter` 提成依赖后，重连策略就成了可断言的纯逻辑。
//    生产环境走默认值（浏览器原生 WebSocket + 全局计时器），无需任何配置。
//
// 2. **订阅是替换式且要重放**。服务端 `sub` 是替换语义（`c.subs = m.codes`）。
//    若不在重连后重放最后一次订阅，页面会**静默停在旧行情**——看起来"还活着"，
//    数字却再也不更新，是最难发现的一类 bug。故 `sub()` 记录 `lastSubs`，`open` 时补发。
//
// 3. **4401 / 4403 不重连**。这两个是服务端在 upgrade 阶段主动关闭的鉴权/封禁码
//    （见 `server/src/api/ws.ts`）。重连只会立刻再被拒，形成打服务端的死循环。
//    4401 应交给上层跳登录，4403 提示封禁。
//
// 4. **心跳超时主动重连**。TCP 连接可能"假活"（服务端进程挂了但 socket 未关闭），
//    此时不会收到 close 事件。用「距上次收到任何消息的毫秒数」做判据，
//    超时即主动重连，避免用户对着不动的数字干等。
//
// 5. **每次重连都重置退避计数**。否则网络恢复后仍会按"失败 8 次"的 30s 延迟等待，
//    恢复体验很差。计数在 `open` 时归零。
/**
 * 交易时段（与 `server/src/core/clock.ts` 的 `Phase` 同名同值）。
 * 前端**不 import 服务端源码**（会拖入 node 依赖），故此处独立声明；
 * 若服务端增删取值，这里要同步——已有服务端测试锁住取值集合。
 */
export type Phase = 'auction_open' | 'continuous' | 'auction_close' | 'settlement';

/** 首延迟（ms）。 */
export const WS_BASE_DELAY_MS = 1000;
/** 延迟上限（ms）：封顶在抖动**之后**，避免算出 36s 这种超出规格的值。 */
export const WS_MAX_DELAY_MS = 30_000;
/** 抖动幅度（±20%）。 */
export const WS_JITTER_RATIO = 0.2;
/** 心跳超时：超过此毫秒数没收到任何消息就主动重连。 */
export const WS_HEARTBEAT_TIMEOUT_MS = 60_000;
/** 心跳检查间隔。 */
export const WS_HEARTBEAT_CHECK_MS = 5_000;

/** 服务端恒推的合成指数代码（见 `server/src/api/ws.ts` 的 INDEX_CODE）。 */
export const INDEX_CODE = 'IDX:COMP';

// ---------- 消息类型（对齐 server/src/api/ws.ts 的推送） ----------

/** 行情行：[code, price(分), chgBp(基点，10000=平盘), volume(股)]。 */
export type QuoteRow = [string, number, number, number];

export interface TickMessage {
  t: 'tick';
  day: number;
  tickInDay: number;
  phase: string;
  /** 首元素恒为指数 `IDX:COMP`，其 price 是基点本身（非分）。 */
  quotes: QuoteRow[];
}

export interface FillMessage {
  t: 'fill';
  orderId: number; code: string; side: string; price: number; qty: number;
  commission: number; stamp: number; transfer: number;
  day: number; tick: number; orderStatus: string;
}

export interface NewsItem {
  id: number; day: number; tick: number; scope: string; target: string | null; title: string;
}
export interface NewsMessage { t: 'news'; item: NewsItem }
export interface SettledMessage { t: 'settled'; day: number }
export interface WsErrorMessage { t: 'error'; code: string; message: string }

export type ServerMessage =
  | TickMessage | FillMessage | NewsMessage | SettledMessage | WsErrorMessage;

type MessageType = ServerMessage['t'];

/** 类型 → 回调签名的映射，让 `on('tick', cb)` 的 cb 参数自动收窄。 */
interface HandlerMap {
  tick: (m: TickMessage) => void;
  fill: (m: FillMessage) => void;
  news: (m: NewsMessage) => void;
  settled: (m: SettledMessage) => void;
  error: (m: WsErrorMessage) => void;
  open: () => void;
  close: (ev: { code: number; reason: string; willReconnect: boolean }) => void;
  raw: (m: ServerMessage) => void;
}

// ---------- 纯函数 ----------

/**
 * 第 n 次重试的延迟（ms，含抖动）。n 从 0 起。
 *
 * `2^n × BASE` 后乘 `1 + (rand×2−1) × 0.2`，最后夹到 `WS_MAX_DELAY_MS`。
 * **夹在抖动之后**是关键：先夹再乘抖动的话，算出的值会突破上限。
 */
export function backoffDelay(n: number, jitter: () => number = Math.random): number {
  const exp = WS_BASE_DELAY_MS * Math.pow(2, Math.max(0, n));
  const r = jitter();
  const factor = 1 + (r * 2 - 1) * WS_JITTER_RATIO;
  const jittered = exp * factor;
  return Math.min(WS_MAX_DELAY_MS, Math.max(1, Math.round(jittered)));
}

/**
 * 由 `location` 推导 WS 地址。
 *
 * 同源部署（生产 Fastify 托管、开发 vite proxy `/ws`），故只取 host 不拼路径前缀——
 * 任何写死 `localhost:8080` 的做法在部署后都会指向用户的机器。
 */
export function wsUrlFrom(loc: { protocol: string; host: string }): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}/ws`;
}

const KNOWN_TYPES: readonly string[] = ['tick', 'fill', 'news', 'settled', 'error'];

/**
 * 容错解析一帧。坏 JSON、非对象、缺 `t`、未知 `t` 一律返回 `null`。
 *
 * **未知类型返回 null 而非报错**：服务端将来新增消息类型时，旧前端应安静忽略，
 * 而不是弹错误或断开——向前兼容必须做在解析层。
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const t = (v as { t?: unknown }).t;
  if (typeof t !== 'string' || !KNOWN_TYPES.includes(t)) return null;
  return v as ServerMessage;
}

/** tick 的 `day`/`tickInDay` → 全局已完成 tick 数。与后端 `last_tick + 1` 同基数。 */
function completedTicks(day: number, tickInDay: number, ticksPerDay: number): number {
  return (day - 1) * ticksPerDay + tickInDay;
}

/**
 * 「最近一次 tick 距今秒数」。
 *
 * 口径与 `server/src/api/admin.ts` 的 `lagSeconds` 完全一致：
 * `(nowMs − genesisMs − (lastTick + 1) × TICK_MS) / 1000`，其中 `(lastTick+1)` 换成
 * 由 `day`/`tickInDay` 还原的已完成 tick 数。本地时钟落后时夹到 0，不返回负数。
 */
export function lagSecondsFrom(
  m: { day: number; tickInDay: number },
  nowMs: number,
  ticksPerDay: number,
  tickMs = 3000,
  genesisMs = 0,
): number {
  const completed = completedTicks(m.day, m.tickInDay, ticksPerDay);
  const elapsed = nowMs - genesisMs - completed * tickMs;
  return Math.max(0, Math.floor(elapsed / 1000));
}

/** 延迟分档：≤10s 正常、≤30s 警告、>30s 危险。 */
export type LagTone = 'ok' | 'warn' | 'danger';

export function lagTone(seconds: number): LagTone {
  if (seconds <= 10) return 'ok';
  if (seconds <= 30) return 'warn';
  return 'danger';
}

// ---------- 客户端 ----------

/** 定时器句柄（不依赖 DOM/Node 的具体返回类型，两者不兼容）。 */
export type TimerHandle = unknown;

export interface WsClientOptions {
  /** 不传则用 `wsUrlFrom(location)`。 */
  url?: string;
  /** 测试注入；默认 `new WebSocket(url)`。 */
  socketFactory?: (url: string) => WebSocket;
  /**
   * 定时器注入。
   *
   * 刻意**不用 `typeof setTimeout`**：DOM 与 Node 的定时器签名不兼容
   * （Node 版带 `__promisify__`），注入替身时会报一堆结构性错误。
   * 只声明我们真正用到的形状即可。
   */
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (h: TimerHandle) => void;
  setInterval?: (fn: () => void, ms: number) => TimerHandle;
  clearInterval?: (h: TimerHandle) => void;
  /** 测试注入的抖动源，返回 [0,1)。 */
  jitter?: () => number;
  now?: () => number;
}

export interface WsClient {
  start: () => void;
  stop: () => void;
  /** 替换式订阅；未连接时缓存，连接（或重连）后自动补发。 */
  sub: (codes: string[]) => void;
  on: <K extends keyof HandlerMap>(type: K, cb: HandlerMap[K]) => () => void;
  /** 当前是否有活跃连接（供 UI 显示状态）。 */
  isOpen: () => boolean;
  /** 当前重试序号（0 = 从未失败）。 */
  retries: () => number;
}

/** 服务端主动关闭且**不应重连**的码。 */
const NO_RECONNECT_CODES = new Set([4401, 4403]);

export function createWsClient(opts: WsClientOptions = {}): WsClient {
  const factory = opts.socketFactory ?? ((u: string) => new WebSocket(u));
  const setT = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clrT = opts.clearTimeout ?? ((h: TimerHandle) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const setI = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clrI = opts.clearInterval ?? ((h: TimerHandle) => clearInterval(h as ReturnType<typeof setInterval>));
  const jitter = opts.jitter ?? Math.random;
  const now = opts.now ?? Date.now;
  const url = opts.url ?? (typeof location !== 'undefined'
    ? wsUrlFrom(location)
    : 'ws://localhost/ws');

  const handlers: { [K in MessageType]: Set<HandlerMap[K]> } = {
    tick: new Set(), fill: new Set(), news: new Set(), settled: new Set(), error: new Set(),
  };
  const openHandlers = new Set<HandlerMap['open']>();
  const closeHandlers = new Set<HandlerMap['close']>();
  const rawHandlers = new Set<HandlerMap['raw']>();

  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 0;
  let lastSubs: string[] = [];
  let reconnectTimer: TimerHandle | null = null;
  let heartbeatTimer: TimerHandle | null = null;
  let lastMessageAt = 0;

  const clearReconnect = (): void => {
    if (reconnectTimer !== null) { clrT(reconnectTimer); reconnectTimer = null; }
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) { clrI(heartbeatTimer); heartbeatTimer = null; }
  };

  const sendSub = (codes: string[]): void => {
    if (ws === null || ws.readyState !== 1 /* OPEN */) return;
    try { ws.send(JSON.stringify({ t: 'sub', codes })); } catch { /* 断链由 close 处理 */ }
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    lastMessageAt = now();
    heartbeatTimer = setI(() => {
      if (stopped) return;
      if (now() - lastMessageAt > WS_HEARTBEAT_TIMEOUT_MS) {
        // 假活连接：主动断开以触发既有的重连路径。
        try { ws?.close(4000, 'heartbeat timeout'); } catch { /* ignore */ }
        handleClose(4000, 'heartbeat timeout');
      }
    }, WS_HEARTBEAT_CHECK_MS);
  };

  const handleClose = (code: number, reason: string): void => {
    stopHeartbeat();
    clearReconnect();
    if (stopped) return;
    const willReconnect = !NO_RECONNECT_CODES.has(code);
    for (const cb of closeHandlers) cb({ code, reason, willReconnect });
    if (!willReconnect) return;
    const delay = backoffDelay(retry, jitter);
    retry++;
    reconnectTimer = setT(() => { reconnectTimer = null; connect(); }, delay);
  };

  const connect = (): void => {
    if (stopped) return;
    let sock: WebSocket;
    try { sock = factory(url); } catch { handleClose(1006, 'factory threw'); return; }
    ws = sock;

    sock.onopen = () => {
      if (stopped) return;
      retry = 0;                        // 连接成功 → 退避计数归零
      startHeartbeat();
      for (const cb of openHandlers) cb();
      if (lastSubs.length > 0) sendSub(lastSubs); // 重放订阅
    };

    sock.onmessage = (ev: MessageEvent) => {
      lastMessageAt = now();
      const msg = parseServerMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg === null) return;         // 坏帧 / 未知类型：安静忽略，不断链
      for (const cb of rawHandlers) cb(msg);
      for (const cb of handlers[msg.t]) (cb as (m: ServerMessage) => void)(msg);
    };

    sock.onclose = (ev: CloseEvent) => { handleClose(ev.code, ev.reason); };
    sock.onerror = () => { /* error 之后必随 close，统一在 close 处理 */ };
  };

  return {
    start: () => { stopped = false; retry = 0; connect(); },
    stop: () => {
      stopped = true;
      clearReconnect();
      stopHeartbeat();
      if (ws !== null) { try { ws.close(1000, 'client stop'); } catch { /* ignore */ } }
      ws = null;
    },
    sub: (codes: string[]) => {
      lastSubs = [...codes];
      sendSub(lastSubs);
    },
    on: (type, cb) => {
      if (type === 'open') { openHandlers.add(cb as HandlerMap['open']); return () => openHandlers.delete(cb as HandlerMap['open']); }
      if (type === 'close') { closeHandlers.add(cb as HandlerMap['close']); return () => closeHandlers.delete(cb as HandlerMap['close']); }
      if (type === 'raw') { rawHandlers.add(cb as HandlerMap['raw']); return () => rawHandlers.delete(cb as HandlerMap['raw']); }
      const set = handlers[type as MessageType] as Set<typeof cb>;
      set.add(cb);
      return () => set.delete(cb);
    },
    isOpen: () => ws !== null && ws.readyState === 1,
    retries: () => retry,
  };
}
