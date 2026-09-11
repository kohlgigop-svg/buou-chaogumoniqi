// pages/admin/EnginePanel.tsx —— 引擎状态 + 总账审计。
//
// 两块都放一起是因为它们是**同一件事的两个视角**：引擎状态说明「在不在跑」，
// 审计说明「跑得对不对」。值班时看一眼就够，不该来回切页。
import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminAuditView, type AdminEngineView } from '../../api.js';
import { lagTone } from '../../lib/ws.js';
import { Spinner } from '../../components/Spinner.js';
import ErrorBox from '../../components/ErrorBox.js';

/**
 * tick 计数器的显示。
 *
 * ⚠️ 刻意**不用** `fmtQty`：那个是给"股数/数量"用的（带千分位），
 * 而 `lastTick` / `tickInDay` 是**递增的序数**（索引、游标），不是可数物量。
 * 用 `3,012` 这种写法会让人误以为它是金额或股数；序数保持裸数字更好读，
 * 也便于直接和日志里的 tick 号对照。
 */
function fmtTick(n: number): string {
  return Number.isFinite(n) ? String(n) : '—';
}

export default function EnginePanel(): React.JSX.Element {
  const [engine, setEngine] = useState<AdminEngineView | null>(null);
  const [audit, setAudit] = useState<AdminAuditView | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    try {
      // 审计要逐用户对账，可能慢；不该拖住引擎状态显示，故分别 catch。
      // 两者都做字段防御：缺字段时退化为"未知/空"，不能让整页白屏
      // （`audit.failures.map` 对 undefined 会抛，React 会卸载整棵树）。
      const [e, a] = await Promise.all([
        adminApi.engine(),
        adminApi.audit().catch(() => null),
      ]);
      setEngine(e);
      setAudit(a === null ? null : {
        ...a,
        failures: Array.isArray(a.failures) ? a.failures : [],
      });
    } catch (e) { setErr(e); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (engine === null) return <Spinner />;

  // 用语义色（good/warning/danger），不是方向色（tone-up/tone-down）——
  // 延迟高是「坏」，不能用 tone-up（那是红=涨）。
  // `lagTone` 的 ok/warn/danger 与 CSS 类名不同名（ok≠good），故显式映射，
  // 不能靠字符串拼接撞运气。
  const LAG_CLASS: Record<ReturnType<typeof lagTone>, string> = {
    ok: 'tone-good', warn: 'tone-warning', danger: 'tone-danger',
  };
  const lagClass = LAG_CLASS[lagTone(engine.lagSeconds)];

  return (
    <div className="apanel">
      <section className="apanel__card" data-testid="admin-engine">
        <h3 className="apanel__sub">引擎状态</h3>
        <div className="kv">
          <div className="kv__row">
            <span className="kv__label">游戏日</span>
            <span className="kv__value num" data-testid="engine-day">{engine.day}</span>
          </div>
          <div className="kv__row">
            <span className="kv__label">当日 tick</span>
            <span className="kv__value num" data-testid="engine-tick">{fmtTick(engine.tickInDay)} / 1200</span>
          </div>
          <div className="kv__row">
            <span className="kv__label">全局 lastTick</span>
            <span className="kv__value num" data-testid="engine-lasttick">{fmtTick(engine.lastTick)}</span>
          </div>
          <div className="kv__row">
            <span className="kv__label">延迟</span>
            <span className={`kv__value num ${lagClass}`} data-testid="engine-lag">
              {engine.lagSeconds}s
            </span>
          </div>
        </div>
        <p className="apanel__hint">
          延迟是「最近一次完成的 tick 距今秒数」。正常约 0–6s（推送每 2 tick 一次）；
          持续 &gt;10s 说明引擎定时器被阻塞。
        </p>
      </section>

      <section className="apanel__card" data-testid="admin-audit">
        <h3 className="apanel__sub">总账审计</h3>
        {audit === null ? <Spinner text="对账中…" /> : (
          <>
            <div className="kv">
              <div className="kv__row">
                <span className="kv__label">全局平衡</span>
                <span className={`kv__value ${audit.globalOk ? 'tone-good' : 'tone-danger'}`}
                  data-testid="audit-global">
                  {audit.globalOk ? '正常' : '异常'}
                </span>
              </div>
              <div className="kv__row">
                <span className="kv__label">已核对用户</span>
                <span className="kv__value num">{audit.checkedUsers}</span>
              </div>
              <div className="kv__row">
                <span className="kv__label">用户对账</span>
                <span className={`kv__value ${audit.usersOk ? 'tone-good' : 'tone-danger'}`}>
                  {audit.usersOk ? '全部通过' : `${audit.failures.length} 个失败`}
                </span>
              </div>
            </div>

            {audit.globalError !== null ? (
              <div className="audit__error tone-danger">{audit.globalError}</div>
            ) : null}

            {audit.failures.length > 0 ? (
              // 用 tone-danger（红，语义色）：账实不符是必须立刻处理的问题，不能只靠文字提示。
              // 注意不能用 tone-up —— 那是「涨」的方向色，读起来会以为是行情。
              <ul className="audit__failures tone-danger" data-testid="audit-failures">
                {audit.failures.map(f => (
                  <li key={f.id} className="audit__failure">
                    <span className="audit__who">{f.username}</span>
                    <span className="audit__why">{f.error}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
        <button type="button" className="btn btn--sm" onClick={() => void load()}>重新对账</button>
      </section>
    </div>
  );
}
