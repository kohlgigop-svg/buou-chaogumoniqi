// pages/Abilities.tsx —— 能力：六维雷达图 + 逐维升级（报名课程）。
//
// 数据源：GET /api/abilities、POST /api/courses/enroll + GET /api/me（可用资金）+ /healthz（进度）
//
// 单位：`nextCourseCost` 是**分**；课程耗时是**游戏小时**（= (level+1) × 8）。
// 满级（10）时服务端给 `nextCourseCost[kind] = null`，此时不显示报名按钮。
import { useCallback, useEffect, useState } from 'react';
import {
  workApi, authApi, metaApi, gminFromHealth,
  type AbilitiesView, type MeView,
} from '../api.js';
import { fmtMoney } from '../format.js';
import Card from '../components/Card.js';
import { Spinner, Empty } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import Radar from '../components/Radar.js';
import ProgressBar from '../components/ProgressBar.js';
import { errorText } from '../errors.js';
import { abilityCells, MAX_LEVEL } from './lifeLogic.js';

interface Loaded { ab: AbilitiesView; me: MeView; gmin: number }

export default function Abilities(): React.JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const [ab, me, health] = await Promise.all([
        workApi.abilities(),
        authApi.me(),
        metaApi.health().catch(() => null),
      ]);
      setData({ ab, me, gmin: health === null ? 0 : gminFromHealth(health) });
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function enroll(kind: string, label: string): Promise<void> {
    setMsg(null);
    setBusy(kind);
    try {
      await workApi.enroll(kind);
      setMsg({ tone: 'ok', text: `已报名「${label}」课程，完成后等级 +1。` });
      await load();
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : '';
      setMsg({ tone: 'err', text: errorText(code) });
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Spinner />;
  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (data === null) return <Spinner />;

  const { ab, me, gmin } = data;
  const cells = abilityCells(ab.abilities, ab.nextCourseCost);
  const cash = me.valuation.cashAvailable;

  // 正在上的课（用于显示进度条）
  const course = me.work.course;
  const courseKind = typeof course?.['kind'] === 'string' ? course['kind'] : null;
  const courseStart = typeof course?.['start_gmin'] === 'number' ? course['start_gmin'] : 0;
  const courseEnd = typeof course?.['end_gmin'] === 'number' ? course['end_gmin'] : 0;

  return (
    <div className="abilities">
      {msg !== null ? (
        <div className={`order__result order__result--${msg.tone}`} role="status">{msg.text}</div>
      ) : null}

      <Card title="能力雷达">
        <div className="abilities__radar">
          <Radar abilities={ab.abilities} size={260} />
          <div className="abilities__summary">
            <span className="abilities__total num" data-testid="ability-total">
              {cells.reduce((s, c) => s + c.level, 0)}
            </span>
            <span className="abilities__total-label">总等级 / {MAX_LEVEL * 6}</span>
            <span className="abilities__cash num">可用 {fmtMoney(cash)}</span>
          </div>
        </div>
        {courseKind !== null ? (
          <ProgressBar
            kind={`学习中：${cells.find(c => c.kind === courseKind)?.label ?? courseKind}`}
            testId="course-progress"
            pct={Math.round(
              courseEnd > courseStart
                ? Math.min(100, Math.max(0, ((gmin - courseStart) / (courseEnd - courseStart)) * 100))
                : 100,
            )}
            time={gmin >= courseEnd ? '即将完成' : `剩余 ${courseEnd - gmin} 游戏分`}
          />
        ) : null}
      </Card>

      <Card title="六维详情" flush>
        <ul className="ablist" data-testid="ability-list">
          {cells.map(c => (
            <li key={c.kind} className="ab" data-testid="ability-row" data-kind={c.kind}>
              <div className="ab__head">
                <span className="ab__label">{c.label}</span>
                <span className="ab__lv num">
                  Lv {c.level}
                  {c.maxed ? '' : ` → ${c.level + 1}`}
                </span>
              </div>
              <div className="ab__bar">
                <ProgressBar
                  kind=""
                  pct={(c.level / MAX_LEVEL) * 100}
                  tone={c.maxed ? 'good' : 'default'}
                  ariaLabel={`${c.label} 等级 ${c.level} / ${MAX_LEVEL}`}
                />
              </div>
              <div className="ab__actions">
                {c.maxed ? (
                  <span className="ab__maxed" data-testid="ability-maxed">已满级</span>
                ) : (
                  <>
                    <span className="ab__cost num">
                      {c.nextCost === null ? '费用未知' : `费用 ${fmtMoney(c.nextCost)}`}
                      {c.nextHours !== null ? ` · 耗时 ${c.nextHours} 游戏小时` : ''}
                    </span>
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      data-testid="enroll"
                      disabled={busy === c.kind || (c.nextCost !== null && c.nextCost > cash)}
                      title={c.nextCost !== null && c.nextCost > cash ? '可用资金不足' : undefined}
                      onClick={() => void enroll(c.kind, c.label)}
                    >
                      {busy === c.kind ? '报名中…' : '报名'}
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <p className="page-hint">
        每级课程耗时 {8} 游戏小时 × 下一级序号；课程与班次共用时间线，同一时刻只能做一件事。
      </p>
    </div>
  );
}
