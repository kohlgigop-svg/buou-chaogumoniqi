// components/Confirm.tsx —— 二次确认弹窗 + 轻量 toast。
//
// 为什么自己写而不是引第三方：项目一直是手写 CSS + 零 UI 依赖（见 theme.css 的设计令牌）。
// 引一个 modal 库会带进它自己的样式体系，与设计令牌分叉。
//
// 无障碍：`role="dialog"` + `aria-modal`，Esc 取消，打开时焦点移到主按钮。
import { useEffect, useRef, type ReactNode } from 'react';

export interface ConfirmProps {
  /** 标题（一句话说明要做什么）。 */
  title: string;
  /** 正文：说清后果，不只是重复标题。 */
  body?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（封禁、重置密码）用红色确认按钮。 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({
  title, body, confirmText = '确认', cancelText = '取消', danger = false,
  onConfirm, onCancel,
}: ConfirmProps): React.JSX.Element {
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="overlay" role="presentation" onClick={onCancel}>
      <div
        className="dialog" role="dialog" aria-modal="true" aria-label={title}
        data-testid="confirm-dialog"
        onClick={e => e.stopPropagation()}
      >
        <div className="dialog__title">{title}</div>
        {body !== undefined ? <div className="dialog__body">{body}</div> : null}
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" data-testid="confirm-cancel"
            onClick={onCancel}>{cancelText}</button>
          <button ref={okRef} type="button"
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            data-testid="confirm-ok" onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}

export interface ToastProps {
  message: string;
  /** `ok` 绿色 / `error` 红色。 */
  tone?: 'ok' | 'error';
  onClose?: () => void;
}

export function Toast({ message, tone = 'ok', onClose }: ToastProps): React.JSX.Element {
  return (
    <div className={`toast toast--${tone}`} role="status" data-testid="admin-toast">
      <span className="toast__text">{message}</span>
      {onClose !== undefined
        ? <button type="button" className="toast__close" aria-label="关闭" onClick={onClose}>×</button>
        : null}
    </div>
  );
}
