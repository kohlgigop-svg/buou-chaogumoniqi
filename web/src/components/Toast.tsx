// components/Toast.tsx —— 成交通知（规格 §4.4「成交回报经 WebSocket 即时推送」）。
//
// 为什么需要它：成交是**异步**发生的（限价单要等现价穿越、竞价单要等开盘/收盘清算），
// 玩家下单后页面不会自动变。若没有任何提示，用户会认为"我的单没生效"而反复下单。
// 服务端已经通过 `fill` 私有消息推送逐笔回报，前端只差一个可见的落点。
//
// ⚠️ **类名用 `filltoast*` 而不是 `toast*`**：`components/Confirm.tsx` 已有一个
// 管理后台用的 `Toast`（类名 `toast`，固定居中、圆角胶囊、单条）。两者视觉与布局诉求
// 完全不同（那边是做完一件事的确认，这边是可能堆叠的成交流水），共用一套类名会互相
// 覆盖样式。这里独立命名，不去动那边。
//
// 设计取舍：
// - **不引入 UI 库**：本项目全程手写 CSS，toast 也保持同样做法。
// - **自动消隐 + 手动关闭**：成交提示是低优先级信息，不该长期占据屏幕；
//   但允许手动关（用户可能想立刻清屏）。
// - **同 orderId 合并**：部分成交会连续推多条同单消息，逐条弹会刷屏；
//   按 orderId 去重更新，后到的明细覆盖先到的。
// - **定时器要在条目移除/卸载时清掉**，否则会在组件消失后仍 setState。
import { useEffect, useRef, useState } from 'react';
import { fmtMoney } from '../format.js';
import { useFillFeed } from '../lib/realtime.js';
import type { FillMessage } from '../lib/ws.js';

export interface ToastItem {
  /** 稳定 key：同一订单的部分成交应合并为一条。 */
  key: string;
  title: string;
  detail: string;
  tone: 'up' | 'down';
}

/** 成交消息 → 提示条目（纯函数，便于单测）。 */
export function fillToToast(m: FillMessage): ToastItem {
  const sideLabel = m.side === 'B' ? '买入' : '卖出';
  const done = m.orderStatus === 'done';
  return {
    key: `fill-${m.orderId}`,
    title: `${sideLabel}成交 ${m.code}`,
    // 费用明细逐笔给出（规格 §4.4 要求"含逐笔费用明细"）
    detail: `${m.qty} 股 @ ${fmtMoney(m.price)}｜佣金 ${fmtMoney(m.commission)}`
      + `｜印花税 ${fmtMoney(m.stamp)}｜过户费 ${fmtMoney(m.transfer)}`
      + (done ? '｜已全部成交' : '｜部分成交'),
    tone: m.side === 'B' ? 'up' : 'down',
  };
}

export interface ToastHostProps {
  items: ToastItem[];
  onDismiss: (key: string) => void;
  /** 自动消隐毫秒数；测试可传 0 关闭。 */
  autoHideMs?: number;
}

export function ToastHost({ items, onDismiss, autoHideMs = 6000 }: ToastHostProps): React.JSX.Element | null {
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // 每个条目各自一个定时器；条目集合变化时重建、卸载时清掉，避免悬空 setState。
  // 依赖用 `keys` 字符串而不是 `items` 数组：调用方每次渲染都新建数组，
  // 直接依赖 `items` 会让定时器每帧重建，自动消隐永远不会到点。
  const keys = items.map(i => i.key).join(',');
  useEffect(() => {
    if (autoHideMs <= 0 || keys === '') return;
    const timers = itemsRef.current.map(it => setTimeout(() => onDismiss(it.key), autoHideMs));
    return () => { for (const t of timers) clearTimeout(t); };
  }, [keys, autoHideMs, onDismiss]);

  if (items.length === 0) return null;
  return (
    <div className="filltoast-host" role="status" aria-live="polite" data-testid="toast-host">
      {items.map(it => (
        <div key={it.key} className={`filltoast filltoast--${it.tone}`} data-testid="toast">
          <div className="filltoast__title">{it.title}</div>
          <div className="filltoast__detail num">{it.detail}</div>
          <button type="button" className="filltoast__close" aria-label="关闭"
            onClick={() => onDismiss(it.key)}>×</button>
        </div>
      ))}
    </div>
  );
}

/**
 * 把成交流接到 toast 列表上：同 `key` 合并（部分成交覆盖为一条）。
 * 返回 `[items, push, dismiss]` —— 拆出 `push` 是为了让合并逻辑留在 Hook 里，
 * `FillToasts` 只负责订阅与渲染。
 */
export function useFillToasts(): [ToastItem[], (it: ToastItem) => void, (key: string) => void] {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = (it: ToastItem): void => {
    setItems(prev => {
      const i = prev.findIndex(p => p.key === it.key);
      if (i === -1) return [...prev, it];
      const next = [...prev];
      next[i] = it;   // 同单部分成交：用最新一条覆盖（qty/费用已是该笔的明细）
      return next;
    });
  };
  const dismiss = (key: string): void => { setItems(prev => prev.filter(i => i.key !== key)); };
  return [items, push, dismiss];
}

/**
 * 挂在应用外壳里的成品：订阅 `fill` 私有消息 → 转成 toast → 渲染。
 * 放在 AppShell 而不是各页面：成交可能发生在任何页面（限价单是异步成交的），
 * 用户可能早就离开个股页了，提示必须跨页可见。
 */
export function FillToasts({ autoHideMs = 6000 }: { autoHideMs?: number }): React.JSX.Element | null {
  const [items, push, dismiss] = useFillToasts();
  useFillFeed((m) => { push(fillToToast(m)); });
  return <ToastHost items={items} onDismiss={dismiss} autoHideMs={autoHideMs} />;
}
