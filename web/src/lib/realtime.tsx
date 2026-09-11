// lib/realtime.tsx —— 全局实时连接 Provider。
//
// 为什么放在 Context 而不是每个页面各自 `createWsClient()`：
//   1. **连接是昂贵资源**。每页一个连接 = 每次路由切换都重连，服务端还要维护
//      N 份订阅集；浏览器对同源 WS 连接数也有限制（HTTP/1.1 通常 6 个）。
//   2. **延迟角标要跨页常驻**。它挂在 `AppShell` 的标题栏上，若连接由页面持有，
//      切页时角标会闪回"连接中"。
//   3. **测试需要注入替身**。`RealtimeProvider` 支持传入 `client` 跳过真实建连，
//      组件测试才能不依赖 jsdom 的 WebSocket（jsdom 不实现它）。
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createWsClient, type FillMessage, type WsClient } from './ws.js';
import { useLag, lagBadgeText, type LagState } from './useLag.js';
import { useQuotes, type Quote } from './useQuotes.js';
import { useSession } from '../session.js';

export interface RealtimeApi {
  client: WsClient | null;
  /** 延迟角标文案；正常时为 `null`（不占位）。 */
  lagBadge: string | null;
  lag: LagState;
  /** 订阅一组代码（替换式）。 */
  sub: (codes: string[]) => void;
}

const RealtimeContext = createContext<RealtimeApi | null>(null);

/** 无 Provider 时返回安全空实现，避免组件测试因缺少包裹而崩。 */
export function useRealtime(): RealtimeApi {
  return useContext(RealtimeContext) ?? EMPTY;
}

const EMPTY: RealtimeApi = {
  client: null,
  lagBadge: null,
  lag: { seconds: null, tone: 'ok', seen: false },
  sub: () => { /* no-op */ },
};

export interface RealtimeProviderProps {
  children: ReactNode;
  /** 测试注入口：跳过真实建连。 */
  client?: WsClient | null;
}

export function RealtimeProvider({ children, client: injected }: RealtimeProviderProps): React.JSX.Element {
  const { status } = useSession();
  const [client, setClient] = useState<WsClient | null>(injected ?? null);

  // 仅在**已登录**时建连。未登录（含启动探测期）不建——
  // 服务端会立刻 4401 关闭，白跑一轮重连逻辑还会刷日志。
  useEffect(() => {
    if (injected !== undefined) return;               // 测试注入态不建连
    if (status !== 'authed') { setClient(null); return; }
    const c = createWsClient();
    c.start();
    setClient(c);
    return () => { c.stop(); };
  }, [injected, status]);

  const lag = useLag(client);

  // 角标需要随延迟增长刷新，而 `useLag` 已内部定时；这里只做文案派生。
  const lagBadge = useMemo(() => lagBadgeText(lag), [lag.seconds, lag.tone, lag.seen]);

  const value = useMemo<RealtimeApi>(() => ({
    client,
    lagBadge,
    lag,
    sub: (codes: string[]) => client?.sub(codes),
  }), [client, lagBadge, lag.seconds, lag.tone, lag.seen]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/** 便捷 hook：在页面里订阅一组代码并拿回报价表。 */
export function useRealtimeQuotes(codes: string[]): Map<string, Quote> {
  const { client } = useRealtime();
  // 未连接时传 null 给 useQuotes，它会跳过订阅（等连接建立后依赖变化自动补订）。
  const source = useMemo(
    () => (client === null ? null : { on: client.on.bind(client), sub: client.sub.bind(client) }),
    [client],
  );
  return useQuotes(source, codes);
}

/** 订阅私有成交回报（toast 用）。 */
export function useFillFeed(onFill: (m: FillMessage) => void): void {
  const { client } = useRealtime();
  const ref = useRef(onFill);
  ref.current = onFill;   // 每次渲染更新，避免把回调放进依赖导致反复订阅
  useEffect(() => {
    if (client === null) return;
    return client.on('fill', (m) => { ref.current(m); });
  }, [client]);
}

export { useLag };
export type { FillMessage };
