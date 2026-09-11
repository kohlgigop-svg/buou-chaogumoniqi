// pages/Home.tsx —— 首页：资产概览 + 持仓 + 进行中的班次/课程。
//
// 数据源：GET /me（valuation / positions / work）+ GET /healthz（推导当前游戏时间，用于算进度）。
//
// ⚠️ 关于「资产曲线」：计划曾打算用 GET /ledger 的 balance_after 重建总资产历史曲线，
// 但**实测证明不可行且会误导**：
//   1. balance_after 是**分桶**余额（bucket 'A' 可用 / 'F' 冻结），不是总资产。
//      一笔挂单冻结会同时写 F:+x 与 A:-x，只看 A 会显示成"钱消失了"。
//   2. 借款 LOAN_DRAW 让可用现金上涨，画出来像赚了钱，而实际 totalAssets 不变（多的是负债）。
//   3. 新用户只有 1 条 GENESIS 记录，根本没有曲线可画。
// 故本页呈现**当前快照 + 当日盈亏**：
//   - 总资产 / 各分项来自 `valuation`（累计口径快照）。
//   - 当日盈亏来自服务端 `todayPnl`（= 持仓当日浮盈 + 当日现金净流）。
//     **关键**：早先版本想在客户端用 `GET /ledger` 累加算当日盈亏，被否掉了 ——
//     该接口分页 `limit` 上限 200 且**不支持按 day 过滤**，活跃用户一天就可能超过，
//     会**静默算错**。现改为服务端一条聚合 SQL 精确算（见 `domain/portfolio.ts`）。
//     两者口径不同（`returnPct` 是净资产收益率，`todayPnl` 含借入现金），故并列展示。
// 想要真实历史曲线，需要后端新增「按日快照」能力，属独立需求，不在本次范围。
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi, metaApi, gminFromHealth, type MeView } from '../api.js';
import { fmtMoney, fmtSignedMoney, fmtPct, fmtQty } from '../format.js';
import Card, { KeyValue } from '../components/Card.js';
import { Spinner, Empty } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import { creditTier, shiftProgress, fmtRemaining, pnlTone, pnlBreakdown } from './homeLogic.js';

interface Loaded { me: MeView; gmin: number }

export default function Home(): React.JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      // /healthz 失败不应阻断首页（只是拿不到进度条），故单独兜底为 0。
      const [me, health] = await Promise.all([
        authApi.me(),
        metaApi.health().catch(() => null),
      ]);
      setData({ me, gmin: health === null ? 0 : gminFromHealth(health) });
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Spinner />;
  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (data === null) return <Spinner />;

  const { me, gmin } = data;
  const v = me.valuation;
  const today = me.todayPnl;
  const tier = creditTier(me.user.credit);

  return (
    <div className="home">
      <Card title="资产总览">
        <div className="home__hero">
          <div className="home__hero-label">总资产</div>
          <div className="home__hero-value num">{fmtMoney(v.totalAssets)}</div>
          {/* 副标题：今日盈亏（口径 = 持仓浮盈 + 现金净流）。服务端未回 todayPnl 时
              回落显示累计收益率，避免老服务端下这行空白。 */}
          {today === undefined ? (
            <div className={`home__hero-sub num ${v.returnPct > 0 ? 'up' : v.returnPct < 0 ? 'down' : 'flat'}`}>
              累计收益 {fmtPct(v.returnPct)}
            </div>
          ) : (
            <>
              <div className={`home__hero-sub num ${pnlTone(today.total)}`} data-testid="today-pnl">
                今日 {fmtSignedMoney(today.total)}
              </div>
              {/* 拆解：买成后现金减少、持仓增加，两个数符号相反，只看总数会疑惑「钱去哪了」 */}
              <div className="home__hero-note num" data-testid="today-pnl-breakdown">
                {pnlBreakdown(today.positionPnl, today.cashFlow, fmtSignedMoney)}
              </div>
            </>
          )}
        </div>
        <div className="home__grid">
          <Stat label="持仓市值" value={fmtMoney(v.positionsValue)} />
          <Stat label="可用资金" value={fmtMoney(v.cashAvailable)} />
          <Stat label="负债" value={fmtMoney(v.loansOutstanding)}
            tone={v.loansOutstanding > 0 ? 'down' : ''} />
          <Stat label="信誉分" value={String(me.user.credit)} testId="credit-score"
            toneClass={tier} />
        </div>
        {v.cashFrozen > 0 ? (
          <div className="home__note">
            冻结 {fmtMoney(v.cashFrozen)}（挂单占用，成交或撤单后返还）
          </div>
        ) : null}
        {/* 累计收益率仍有价值（净资产口径），但降级为脚注，避免与「今日」抢焦点 */}
        {today === undefined ? null : (
          <div className="home__note">
            累计收益 <span className={`num ${v.returnPct > 0 ? 'up' : v.returnPct < 0 ? 'down' : 'flat'}`}>
              {fmtPct(v.returnPct)}
            </span>
            （= (总资产 − 累计入金) ÷ 累计入金）
          </div>
        )}
      </Card>

      <Card title="进行中">
        <Ongoing work={me.work} gmin={gmin} />
      </Card>

      <Card title="我的持仓" flush>
        {me.positions.length === 0 ? (
          <Empty text="暂无持仓" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>代码</th><th>名称</th><th className="ta-r">持仓</th>
                <th className="ta-r">现价</th><th className="ta-r">浮动盈亏</th>
              </tr>
            </thead>
            <tbody>
              {me.positions.map(p => (
                <tr key={p.code}>
                  <td className="num">
                    <Link to={`/market/${p.code}`} className="link">{p.code}</Link>
                  </td>
                  <td>{p.name}</td>
                  <td className="ta-r num">{fmtQty(p.qtyTotal)}</td>
                  <td className="ta-r num">{fmtMoney(p.price)}</td>
                  <td className={`ta-r num ${p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : 'flat'}`}>
                    {fmtSignedMoney(p.pnl)}
                    <span className="table__sub">{fmtPct(p.pnlPct)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, tone = '', toneClass = '', testId }: {
  label: string; value: string; tone?: '' | 'up' | 'down';
  toneClass?: 'danger' | 'warning' | 'good' | ''; testId?: string;
}): React.JSX.Element {
  const cls = [tone, toneClass].filter(x => x !== '').join(' ');
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value num ${cls}`.trim()} {...(testId !== undefined ? { 'data-testid': testId } : {})}>
        {value}
      </div>
    </div>
  );
}

/** 进行中的班次 / 课程；都没有则提示空闲。 */
function Ongoing({ work, gmin }: {
  work: MeView['work']; gmin: number;
}): React.JSX.Element {
  const shift = work.shift;
  const course = work.course;
  const courseAbility = typeof course?.['ability'] === 'string' ? course['ability'] : null;
  const courseStart = typeof course?.['start_gmin'] === 'number' ? course['start_gmin'] : 0;
  const courseEnd = typeof course?.['end_gmin'] === 'number' ? course['end_gmin'] : 0;

  if (shift === null && course === null) {
    return <Empty text="空闲中——去「生活」排班或报名课程" />;
  }
  return (
    <div className="ongoing">
      {shift !== null ? (
        <ProgressRow
          kind="工作中"
          testId="shift-progress"
          start={shift.start_gmin}
          end={shift.end_gmin}
          gmin={gmin}
          extra={shift.pay !== null ? `薪酬 ${fmtMoney(shift.pay)}` : null}
        />
      ) : null}
      {courseAbility !== null ? (
        <ProgressRow
          kind="学习中"
          testId="course-progress"
          start={courseStart}
          end={courseEnd}
          gmin={gmin}
          extra={courseAbility}
        />
      ) : null}
    </div>
  );
}

function ProgressRow({ kind, start, end, gmin, extra, testId }: {
  kind: string; start: number; end: number; gmin: number;
  extra: string | null; testId: string;
}): React.JSX.Element {
  const pct = shiftProgress(start, end, gmin);
  const remain = end - gmin;
  return (
    <div className="prog">
      <div className="prog__head">
        <span className="prog__kind">{kind}</span>
        {extra !== null ? <span className="prog__extra">{extra}</span> : null}
        <span className="prog__time">{fmtRemaining(remain)}</span>
      </div>
      <div className="prog__track" role="progressbar" data-testid={testId}
        aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="prog__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
