// lib/useLag.ts —— 行情延迟角标。
//
// 为什么需要它（规格 §17 监控要求）：引擎是定时器驱动的仿真，一旦定时器被
// 阻塞/暂停，价格会**停在原地但页面看起来完全正常**。用户会以为"今天没行情"，
// 实际是数据管道断了。把「最近一次 tick 距今多久」显式显示出来，
// 才能让这种静默故障可见。
//
// 判据来自服务端推的 `tick` 消息（`day` + `tickInDay`）与本地时钟之差，
// 口径与服务端 `/api/admin/engine` 的 `lagSeconds` 一致（见 `ws.ts` 的 `lagSecondsFrom`）。
import { useEffect, useState } from 'react';
import { lagSecondsFrom, lagTone, type LagTone, type TickMessage } from './ws.js';

/** 1 游戏日 = 1200 tick = 3600 秒（3s/tick）。 */
export const TICKS_PER_DAY = 1200;
export const TICK_MS = 3000;

/** 角标刷新间隔：延迟是"秒"级指标，1s 刷新足够且不会造成渲染压力。 */
export const LAG_REFRESH_MS = 1000;

export interface LagState {
  /** 距最近一次 tick 的秒数；从未收到过 tick 时为 `null`。 */
  seconds: number | null;
  tone: LagTone;
  /** 是否已收到过至少一次 tick（未收到时角标应显示"连接中"而非"延迟 0s"）。 */
  seen: boolean;
}

/** `useLag` 需要的 socket 能力。 */
export interface TickSource {
  on: (type: 'tick', cb: (m: TickMessage) => void) => () => void;
}

/**
 * 返回延迟角标状态。
 *
 * **未收到 tick 时不报 0**：`seen=false` 让 UI 能区分「刚连上还没数据」与
 * 「数据很新」，否则首屏会显示"延迟 0s"骗人。
 */
export function useLag(source: TickSource | null, refreshMs = LAG_REFRESH_MS): LagState {
  const [last, setLast] = useState<{ day: number; tickInDay: number } | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (source === null) return;
    return source.on('tick', (m) => { setLast({ day: m.day, tickInDay: m.tickInDay }); });
  }, [source]);

  // 即使没有新 tick 也要刷新「距今秒数」——延迟增长本身就是信息。
  useEffect(() => {
    if (last === null) return;
    const t = setInterval(() => force(v => v + 1), refreshMs);
    return () => clearInterval(t);
  }, [last, refreshMs]);

  if (last === null) return { seconds: null, tone: 'ok', seen: false };
  const seconds = lagSecondsFrom(last, Date.now(), TICKS_PER_DAY, TICK_MS);
  return { seconds, tone: lagTone(seconds), seen: true };
}

/**
 * 延迟角标的显示文案。`null`（未收到 tick）时返回"连接中…"。
 *
 * 单独抽成纯函数以便测试，也便于 `AppShell` 只接收字符串。
 */
export function lagBadgeText(state: LagState): string | null {
  if (!state.seen || state.seconds === null) return '连接中…';
  if (state.tone === 'ok') return null;      // 正常时不占位，避免长期占用标题栏
  return `延迟 ${state.seconds}s`;
}
