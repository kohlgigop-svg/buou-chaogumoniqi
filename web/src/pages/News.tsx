// pages/News.tsx —— 新闻流：倒序分页 + 触底/按钮加载更多。
//
// 服务端 `GET /api/news?limit&before` 用 `id < before` 取下一批，`nextBefore` 是末条 id，
// 因此相邻两页在边界上**必然重叠一条**，合并时按 id 去重（见 marketLogic.mergeNews）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { marketApi, type NewsRow } from '../api.js';
import Card from '../components/Card.js';
import { Spinner, Empty } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import { mergeNews } from './marketLogic.js';
import { fmtPct } from '../format.js';

const PAGE = 30;

/** 影响幅度阈值：|impactE6| 换算成百分比后，用于给标题加涨/跌色。 */
function impactPct(impactE6: number): number { return impactE6 / 1e6; }

export default function News(): React.JSX.Element {
  const [items, setItems] = useState<NewsRow[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  /** 防止重复触发（快速连点 / 触底抖动）。 */
  const busy = useRef(false);

  const loadFirst = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const r = await marketApi.news(PAGE);
      setItems(mergeNews([], r.items));
      setNextBefore(r.nextBefore);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    if (busy.current || nextBefore === null || nextBefore === undefined) return;
    busy.current = true;
    setMore(true);
    try {
      const r = await marketApi.news(PAGE, nextBefore);
      setItems(prev => mergeNews(prev, r.items));
      setNextBefore(r.nextBefore);
    } catch (e) {
      setErr(e);
    } finally {
      busy.current = false;
      setMore(false);
    }
  }, [nextBefore]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);

  if (loading) return <Spinner />;
  if (err !== null && items.length === 0) return <ErrorBox error={err} onRetry={() => void loadFirst()} />;

  return (
    <div className="news">
      <Card title="市场新闻" flush>
        {items.length === 0 ? (
          <Empty text="暂无新闻" />
        ) : (
          <ul className="news__list">
            {items.map(n => {
              const p = impactPct(n.impactE6);
              const tone = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
              return (
                <li key={n.id} className="news__item" data-testid="news-item">
                  <div className="news__head">
                    <span className="news__day">第 {n.day} 日</span>
                    <span className="news__scope">{scopeLabel(n.scope)}</span>
                    {p !== 0 ? <span className={`news__impact num ${tone}`}>{fmtPct(p)}</span> : null}
                  </div>
                  <div className="news__title">{n.title}</div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {nextBefore !== null && nextBefore !== undefined ? (
        <button type="button" className="btn btn--ghost news__more" disabled={more}
          onClick={() => void loadMore()}>
          {more ? '加载中…' : '加载更多'}
        </button>
      ) : null}
    </div>
  );
}

function scopeLabel(scope: string): string {
  if (scope === 'MKT') return '全市场';
  if (scope === 'SEC') return '板块';
  if (scope === 'STK') return '个股';
  return scope;
}
