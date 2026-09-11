// pages/Work.tsx —— 打工：职业列表（资格/工资）+ 我的排班（可取消）。
//
// 数据源：GET /api/jobs、GET /api/shifts、POST /api/shifts、DELETE /api/shifts/:id
//        + GET /healthz（推导 gmin，用于班次进度与「是否可取消」）
//
// 单位提醒：`base_pay` / `wage` / `pay` 都是**分**；`start_gmin`/`end_gmin` 是**游戏分钟**。
import { useCallback, useEffect, useState } from 'react';
import {
  workApi, metaApi, gminFromHealth,
  type JobRow, type ShiftRow,
} from '../api.js';
import { fmtMoney, fmtPct } from '../format.js';
import Card from '../components/Card.js';
import { Spinner, Empty } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import ProgressBar from '../components/ProgressBar.js';
import { errorText } from '../errors.js';
import { shiftProgress, fmtRemaining } from './homeLogic.js';
import {
  requirementGap, wageBonusPct, shiftBlockReason, shiftStatusLabel,
  shiftTone, shiftHours, shiftCancellable,
} from './lifeLogic.js';

interface Loaded { jobs: JobRow[]; shifts: ShiftRow[]; gmin: number }

export default function Work(): React.JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busyJob, setBusyJob] = useState<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const [jobsRes, shiftsRes, health] = await Promise.all([
        workApi.jobs(),
        workApi.shifts(),
        metaApi.health().catch(() => null),
      ]);
      setData({
        jobs: jobsRes.jobs,
        shifts: shiftsRes.shifts,
        gmin: health === null ? 0 : gminFromHealth(health),
      });
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function schedule(job: JobRow): Promise<void> {
    setMsg(null);
    setBusyJob(job.id);
    try {
      const r = await workApi.schedule(job.id);
      setMsg({ tone: 'ok', text: `已排班「${job.name}」，班次 #${r.shiftId}。` });
      await load();
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : '';
      setMsg({ tone: 'err', text: errorText(code) });
    } finally {
      setBusyJob(null);
    }
  }

  async function cancel(s: ShiftRow): Promise<void> {
    setMsg(null);
    try {
      await workApi.cancelShift(s.id);
      setMsg({ tone: 'ok', text: `已取消班次 #${s.id}。` });
      await load();
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : '';
      setMsg({ tone: 'err', text: errorText(code) });
    }
  }

  if (loading) return <Spinner />;
  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (data === null) return <Spinner />;

  const { jobs, shifts, gmin } = data;

  return (
    <div className="work">
      {msg !== null ? (
        <div className={`order__result order__result--${msg.tone}`} role="status">{msg.text}</div>
      ) : null}

      <Card title="职业列表" flush>
        {jobs.length === 0 ? (
          <Empty text="暂无可选职业" />
        ) : (
          <ul className="joblist" data-testid="job-list">
            {jobs.map(j => (
              <JobItem
                key={j.id}
                job={j}
                busy={busyJob === j.id}
                onSchedule={() => void schedule(j)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card title="我的排班" flush>
        {shifts.length === 0 ? (
          <Empty text="还没有排班，从上面挑一份工作吧" />
        ) : (
          <ul className="shiftlist" data-testid="shift-list">
            {shifts.map(s => {
              const jobName = jobs.find(j => j.id === s.job_id)?.name ?? `职业 #${s.job_id}`;
              const cancellable = shiftCancellable(s, gmin);
              const tone = shiftTone(s.status);
              return (
                <li key={s.id} className="shift" data-testid="shift-row">
                  <div className="shift__main">
                    <span className="shift__name">{jobName}</span>
                    <span className={`badge badge--${tone}`} data-testid="shift-status">
                      {shiftStatusLabel(s.status)}
                    </span>
                  </div>
                  <div className="shift__meta">
                    <span>第 {Math.floor(s.start_gmin / 1440) + 1} 日</span>
                    <span>{shiftHours(s)} 小时</span>
                    {s.pay !== null ? <span className="num">薪酬 {fmtMoney(s.pay)}</span> : null}
                  </div>
                  {s.status === 'working' ? (
                    <ProgressBar
                      kind="进行中"
                      testId="shift-progress"
                      pct={shiftProgress(s.start_gmin, s.end_gmin, gmin)}
                      time={fmtRemaining(s.end_gmin - gmin)}
                    />
                  ) : null}
                  <div className="shift__actions">
                    <span className="shift__order num">#{s.id}</span>
                    {cancellable ? (
                      <button
                        type="button"
                        className="btn btn--sm"
                        data-testid="cancel-shift"
                        onClick={() => void cancel(s)}
                      >
                        取消
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function JobItem({ job, busy, onSchedule }: {
  job: JobRow; busy: boolean; onSchedule: () => void;
}): React.JSX.Element {
  const gap = shiftBlockReason(job);
  const bonus = wageBonusPct(job);
  return (
    <li
      className={`job ${job.eligible ? '' : 'is-locked'}`.trim()}
      data-testid="job-row"
      data-eligible={job.eligible ? '1' : '0'}
    >
      <div className="job__main">
        <span className="job__name">{job.name}</span>
        <span className="job__wage num">
          {fmtMoney(job.wage)}
          {bonus !== null && bonus > 0 ? (
            <span className="job__bonus down num" data-testid="wage-bonus">{fmtPct(bonus)}</span>
          ) : null}
        </span>
      </div>
      <div className="job__meta">
        <span className="job__base num">基准 {fmtMoney(job.base_pay)}</span>
        {/* 不合格时「需 …」只在按钮旁显示一次（见下方 job__gap）：
            两处都渲染会让同一句要求在一行里出现两遍。 */}
      </div>
      <div className="job__actions">
        {job.eligible ? (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            data-testid="schedule-job"
            disabled={busy}
            onClick={onSchedule}
          >
            {busy ? '排班中…' : '排班'}
          </button>
        ) : (
          <>
            <span className="job__gap" data-testid="job-gap">{gap}</span>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="schedule-job"
              disabled
              title={gap ?? '资格不足'}
            >
              排班
            </button>
          </>
        )}
      </div>
    </li>
  );
}
