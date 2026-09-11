// components/ProgressBar.tsx —— 通用进度条（班次 / 课程 / 还款共用）。
//
// 复用首页已建立的 `.prog*` 样式与结构（`pages/Home.tsx` 的 `ProgressRow`），
// 不另起一套类名 —— 否则同一视觉模式会有两份 CSS，改一处忘一处。
// 本组件是「无副作用的那一半」：只负责画，比例与剩余文案由调用方算
// （比例用 `homeLogic.shiftProgress`，剩余用 `homeLogic.fmtRemaining`）。
export interface ProgressBarProps {
  /** 左侧标题（如「工作中」）。 */
  kind: string;
  /** 0..100 的进度百分比；越界夹紧，NaN 视为 0。 */
  pct: number;
  /** 右侧时间文案（如「剩余 3 小时」）。 */
  time?: string;
  /** 标题后的附注（如薪酬、课程名）。 */
  extra?: string | null;
  /** 色调修饰；默认主色。 */
  tone?: 'default' | 'good' | 'warn';
  testId?: string;
  /** 无障碍描述；缺省用 `kind` + 百分比拼出。 */
  ariaLabel?: string;
}

export default function ProgressBar({
  kind, pct, time, extra = null, tone = 'default', testId, ariaLabel,
}: ProgressBarProps): React.JSX.Element {
  const safe = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  const rounded = Math.round(safe);

  return (
    <div className="prog">
      <div className="prog__head">
        <span className="prog__kind">{kind}</span>
        {extra !== null && extra !== '' ? <span className="prog__extra">{extra}</span> : null}
        {time !== undefined ? <span className="prog__time">{time}</span> : null}
      </div>
      <div
        className="prog__track"
        role="progressbar"
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel ?? `${kind} ${rounded}%`}
        {...(testId !== undefined ? { 'data-testid': testId } : {})}
      >
        <div
          className={`prog__fill prog__fill--${tone}`}
          style={{ width: `${rounded}%` }}
          data-testid="progressbar-fill"
        />
      </div>
    </div>
  );
}
