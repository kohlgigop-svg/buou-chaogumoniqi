// pages/Market.tsx —— 行情 Tab：指数卡片 + 板块热力图 + 涨跌家数 + 涨跌幅榜 + 搜索 + 新闻流。
//
// 数据源：GET /market/overview（指数/板块/家数/成交额/涨跌幅前 5）
//       + GET /stocks（全量，供本地搜索）
//       + GET /news（首页一批，更多在 /news 子页）
//       + WS tick（指数涨跌 / 榜单 / 股票列表的实时价叠加）
//
// 设计取舍：
// - 搜索**不做后端端点**：`GET /stocks` 一次返回全市场（数百条，量级很小），
//   本地过滤即时响应且无网络往返（计划明确如此）。
// - 热力图颜色走 CSS 变量而非 JS 拼色串，亮/暗主题只改 CSS。
// - 涨跌幅榜用 `topGainers`/`topLosers`（服务端已排好序取前 5），前端不再排序。
//   ⚠️ 榜单**只叠加实时价，不重排**：实时价变化理论上会改变排名，但这里刻意不重排——
//   重排会让行在用户眼前跳动（每次 tick 都可能换位），难以阅读；且榜单口径由服务端
//   在快照时刻定下，前端擅自重排会与 `GET /market/overview` 的语义分叉。
// - 指数实时涨跌用 WS 的 `chgBp`（见 `applyLiveIndex`），**不用**它的 `price`
//   （那是 `10000 + chgBp`，不是点位）。
// - 涨跌家数/板块/成交额**不做实时叠加**：WS 不推这些聚合量，凭空推算会与服务端口径分叉。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { marketApi, type MarketOverview, type NewsRow, type StockRow } from '../api.js';
import { fmtMoney, fmtPct, fmtCompactMoney, fmtIndex } from '../format.js';
import Card from '../components/Card.js';
import { Spinner, Empty } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import SearchBox from '../components/SearchBox.js';
import SectorHeatmap from '../components/SectorHeatmap.js';
import StockRowItem from '../components/StockRow.js';
import { advancerRatio, filterStocks, moverRows, heatTone } from './marketLogic.js';
import { useRealtimeQuotes } from '../lib/realtime.js';
import { applyLiveIndex, applyLiveMover, applyLiveRow, liveOf, subCodesOf } from '../lib/liveQuote.js';

interface Loaded { overview: MarketOverview; stocks: StockRow[]; news: NewsRow[] }

type MoverTab = 'gainers' | 'losers';

export default function Market(): React.JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<MoverTab>('gainers');
  const [query, setQuery] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      // 新闻失败不该让整个行情页白屏（只是少一块），故单独兜底为空列表。
      const [overview, stocksRes, newsRes] = await Promise.all([
        marketApi.overview(),
        marketApi.stocks(),
        marketApi.news(20).catch(() => ({ items: [] as NewsRow[], nextBefore: null })),
      ]);
      setData({ overview, stocks: stocksRes.stocks, news: newsRes.items });
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ⚠️ hook 必须在 early return 之前无条件调用。
  // 订阅全市场：行情页要显示每只股票的实时价，且订阅集在加载完成后才确定。
  // 空数组期间 `useQuotes` 不会发订阅（服务端 index 行恒推，无需订阅）。
  const codes = useMemo(() => (data === null ? [] : subCodesOf(data.stocks)), [data]);
  const quotes = useRealtimeQuotes(codes);

  const filtered = useMemo(
    () => (data === null ? [] : filterStocks(data.stocks, query)),
    [data, query],
  );

  if (loading) return <Spinner />;
  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (data === null) return <Spinner />;

  const { overview, news } = data;
  // 指数只叠涨跌（`level` 由快照给），见 applyLiveIndex 的说明。
  const index = applyLiveIndex(overview.index, quotes.get(overview.index.code));
  const idxTone = heatTone(index.chgPct);
  const ratio = advancerRatio(overview.advancers, overview.decliners);
  const movers = moverRows(tab === 'gainers' ? overview.topGainers : overview.topLosers)
    .map(m => ({ ...m, live: applyLiveMover(m, liveOf(quotes, m.code)) }));
  const searching = query.trim() !== '';

  return (
    <div className="market">
      <Card title="大盘指数">
        <div className="market__index">
          <div className="market__index-level num">{fmtIndex(index.level)}</div>
          <div className={`market__index-chg num ${idxTone}`} data-testid="index-chg">
            {fmtPct(index.chgPct)}
          </div>
        </div>
        <div className="market__breadth">
          <div className="market__breadth-head">
            <span className="up num" data-testid="advancers">上涨 {overview.advancers}</span>
            <span className="down num" data-testid="decliners">下跌 {overview.decliners}</span>
            <span className="market__turnover num">成交额 {fmtCompactMoney(overview.turnover)}</span>
          </div>
          <div className="market__breadth-track" role="img"
            aria-label={`上涨 ${overview.advancers} 家，下跌 ${overview.decliners} 家`}>
            <div className="market__breadth-up" data-testid="advancers-bar"
              style={{ width: `${ratio * 100}%` }} />
          </div>
        </div>
      </Card>

      <Card title="板块热力图">
        <SectorHeatmap sectors={overview.sectors} />
      </Card>

      <Card
        title="涨跌幅榜"
        extra={
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'gainers'}
              className={`seg__btn ${tab === 'gainers' ? 'is-active' : ''}`}
              onClick={() => setTab('gainers')}>涨幅</button>
            <button type="button" role="tab" aria-selected={tab === 'losers'}
              className={`seg__btn ${tab === 'losers' ? 'is-active' : ''}`}
              onClick={() => setTab('losers')}>跌幅</button>
          </div>
        }
        flush
      >
        {movers.length === 0 ? (
          <Empty text="暂无数据" />
        ) : (
          <ul className="movers" data-testid="movers">
            {movers.map(m => (
              <li key={m.code} className="movers__row">
                <span className="movers__rank num" data-testid="mover-rank">{m.rank}</span>
                <span className="movers__name">
                  <Link to={`/market/${m.code}`} className="link">{m.name}</Link>
                  <span className="movers__code num">{m.code}</span>
                </span>
                <span className="movers__price num">{fmtMoney(m.live.price)}</span>
                <span className={`movers__chg num ${heatTone(m.live.chgPct)}`}>{fmtPct(m.live.chgPct)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="股票列表" extra={<span className="card__hint">{filtered.length} 只</span>}>
        <SearchBox value={query} onChange={setQuery} />
        {filtered.length === 0 ? (
          <Empty text={searching ? `没有匹配「${query.trim()}」的股票` : '暂无股票'} />
        ) : (
          <ul className="slist" data-testid="stock-list">
            {filtered.map(s => (
              <StockRowItem key={s.code} stock={applyLiveRow(s, liveOf(quotes, s.code))} />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="最新新闻"
        extra={<Link to="/news" className="link">查看全部</Link>}
        flush
      >
        {news.length === 0 ? (
          <Empty text="暂无新闻" />
        ) : (
          <ul className="news__list">
            {news.map(n => (
              <li key={n.id} className="news__item">
                <div className="news__head">
                  <span className="news__day">第 {n.day} 日</span>
                  {n.impactE6 !== 0 ? (
                    <span className={`news__impact num ${heatTone(n.impactE6)}`}>{fmtPct(n.impactE6 / 1e6)}</span>
                  ) : null}
                </div>
                <div className="news__title">{n.title}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
