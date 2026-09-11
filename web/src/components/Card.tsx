// components/Card.tsx —— 通用卡片容器 + 少量排版原语。
import type { ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 去掉内边距（表格类内容自己控制留白）。 */
  flush?: boolean;
}

export default function Card({ title, extra, children, className = '', flush = false }: CardProps): React.JSX.Element {
  return (
    <section className={`card ${className}`.trim()}>
      {title !== undefined || extra !== undefined ? (
        <header className="card__head">
          <span className="card__title">{title}</span>
          {extra !== undefined ? <span className="card__extra">{extra}</span> : null}
        </header>
      ) : null}
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
    </section>
  );
}

/** 键值对一行（用于资产概览等）。 */
export function KeyValue({ label, value, tone = '' }: {
  label: ReactNode; value: ReactNode; tone?: '' | 'up' | 'down' | 'flat';
}): React.JSX.Element {
  return (
    <div className="kv">
      <span className="kv__label">{label}</span>
      <span className={`kv__value num ${tone}`.trim()}>{value}</span>
    </div>
  );
}
