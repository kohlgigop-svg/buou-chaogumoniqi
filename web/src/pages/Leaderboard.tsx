// pages/Leaderboard.tsx —— 榜单：总资产 / 收益率两榜切换。
//
// 数据源：`GET /api/leaderboard?by=total|return`（返回前 100 名）。
//
// 三点口径（都已在测试里锁死）：
// - 服务端榜单**不回 id**（构建时被剥掉），故「高亮自己」只能按 username 匹配。
// - `bankrupt` 是 `bankrupt_count > 0` 的派生布尔；标注只在该字段为 true 时出现，
//   不能只看 `bankruptCount`（防御未来后端语义分叉）。
// - 名次由**下标**决定（服务端不回名次字段），前三名给徽标。
import { useCallback, useEffect, useState } from 'react';
import { leaderboardApi, type Leaderboard, type LeaderboardRow } from '../api.js';
import { fmtMoney, fmtPct } from '../format.js';
import Card from '../components/Card.js';
import { Spinner, Empty } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import { useSession } from '../session.js';
import { rankBadge, isSelf } from './meLogic.js';

type By = 'total' | 'return';

const TABS: { by: By; label: string }[] = [
  { by: 'total', label: '总资产' },
  { by: 'return', label: '收益率' },
];

export default function Leaderboard(): React.JSX.Element {
  const session = useSession();
  const me = session.user?.username;
  const [by, setBy] = useState<By>('total');
  const [data, setData] = useState<Leaderboard | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (which: By): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      setData(await leaderboardApi.get(which));
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(by); }, [load, by]);

  return (
    <div className="lb">
      <div className="lb__tabs" role="tablist">
        {TABS.map(t => (
          <button
            key={t.by}
            type="button"
            role="tab"
            aria-selected={by === t.by}
            className={`seg__btn ${by === t.by ? 'is-active' : ''}`}
            data-testid={`lb-by-${t.by}`}
            onClick={() => setBy(t.by)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card title={by === 'total' ? '总资产榜' : '收益率榜'} flush>
        {loading && data === null ? (
          <Spinner />
        ) : err !== null ? (
          <ErrorBox error={err} onRetry={() => void load(by)} />
        ) : data === null || data.rows.length === 0 ? (
          <Empty text="榜单还没有数据" />
        ) : (
          <ul className="lb__list" data-testid="lb-list">
            {data.rows.map((r, i) => (
              <Row key={`${r.username}-${i}`} row={r} index={i} me={me} />
            ))}
          </ul>
        )}
      </Card>

      {/* 说明要跟着当前榜单走：切到收益率榜还写着总资产公式会误导 */}
      <p className="page-hint">
        {by === 'total'
          ? '榜单取前 100 名；总资产 = 可用 + 冻结 + 持仓市值 − 未偿贷款。'
          : '榜单取前 100 名；收益率 = (总资产 − 累计入金) ÷ 累计入金。'}
      </p>
    </div>
  );
}

function Row({ row, index, me }: {
  row: LeaderboardRow; index: number; me: string | undefined;
}): React.JSX.Element {
  const rank = rankBadge(index);
  const self = isSelf(row.username, me);
  const up = row.returnPct > 0;
  const down = row.returnPct < 0;

  return (
    <li
      className={`lb__row ${self ? 'is-me' : ''}`.trim()}
      data-testid="lb-row"
    >
      <span className={`lb__rank ${rank === null ? '' : `lb__rank--${rank}`}`.trim()}>
        {rank !== null ? <span data-testid="lb-rank">{rank}</span> : index + 1}
      </span>

      <span className="lb__name" data-testid="lb-name">
        {row.username}
        {self ? <span className="lb__me-tag">我</span> : null}
      </span>

      <span className="lb__nums">
        <span className="lb__assets num">{fmtMoney(row.totalAssets)}</span>
        <span className={`lb__ret num ${up ? 'up' : down ? 'down' : 'flat'}`}>
          {fmtPct(row.returnPct)}
        </span>
      </span>

      {row.bankrupt ? (
        <span className="badge badge--danger" data-testid="lb-bankrupt">已破产</span>
      ) : null}
    </li>
  );
}
