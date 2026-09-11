// pages/Stock.tsx —— 个股页：行情头 + K 线（分时/日K）+ 五档盘口 + 买卖面板 + 财报 + 相关新闻。
//
// 数据源：GET /stocks/:code（quote + reports + dividends + news + fundamental）
//       + GET /stocks/:code/candles?type=tick|day
//       + GET /me（可用资金、可卖量、当前相位所需）
//       + GET /healthz（推导 phase —— WS 未接（Task 8）前用轮询式刷新）
//
// ⚠️ 本页只做「读取 + 下单」，不做撮合。**限价单只冻结不成交**（撮合属原计划 T5），
// 故下单成功后持仓不会立刻变化，这是正确行为，界面上以「已冻结」提示说明。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  authApi, marketApi, tradeApi, metaApi, gminFromHealth,
  type MeView, type StockDetail, type CandlesResult,
} from '../api.js';
import { fmtMoney, fmtPct, fmtCompactMoney, fmtQty } from '../format.js';
import Card, { KeyValue } from '../components/Card.js';
import { Spinner, Empty } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import DepthBook from '../components/DepthBook.js';
import OrderPanel, { type OrderPhase, type OrderSubmit } from '../components/OrderPanel.js';
import FinancePanel from '../components/FinancePanel.js';
import CandleChart from '../components/CandleChart.js';
import { errorText } from '../errors.js';

const TICKS_PER_DAY = 1200;

/**
 * 由 `GET /healthz` 的 lastTick 推导当前相位，与 `core/clock.ts` 的 `phaseOfTick` 对齐：
 * `<60` 开盘竞价、`<1160` 连续竞价、`<1180` 收盘竞价、其余结算。
 * ⚠️ 必须用 `lastTick + 1`（「将处理本单的 tick」），与 `engineNow` 同口径。
 */
function phaseFromHealth(lastTick: number): OrderPhase {
  const tickInDay = (lastTick + 1) % TICKS_PER_DAY;
  if (tickInDay < 60) return 'auction_open';
  if (tickInDay < 1160) return 'continuous';
  if (tickInDay < 1180) return 'auction_close';
  return 'settlement';
}

type ChartType = 'tick' | 'day';

interface Loaded {
  detail: StockDetail;
  me: MeView;
  phase: OrderPhase;
}

export default function Stock(): React.JSX.Element {
  const { code = '' } = useParams();
  const [data, setData] = useState<Loaded | null>(null);
  const [candles, setCandles] = useState<CandlesResult | null>(null);
  const [chartType, setChartType] = useState<ChartType>('tick');
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [orderMsg, setOrderMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const [detail, me, health] = await Promise.all([
        marketApi.stock(code),
        authApi.me(),
        metaApi.health().catch(() => null),
      ]);
      setData({ detail, me, phase: health === null ? 'continuous' : phaseFromHealth(health.lastTick) });
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => { void load(); }, [load]);

  // K 线单独加载：切换类型时不应整页重载
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await marketApi.candles(code, chartType);
        if (alive) setCandles(r);
      } catch {
        if (alive) setCandles(null);
      }
    })();
    return () => { alive = false; };
  }, [code, chartType]);

  // 当前持仓（用于可卖量）
  const holding = useMemo(
    () => data?.me.positions.find(p => p.code === code) ?? null,
    [data, code],
  );

  if (loading) return <Spinner />;
  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (data === null) return <Spinner />;

  const { detail, me, phase } = data;
  const q = detail.quote;
  const tone = q.chgPct > 0 ? 'up' : q.chgPct < 0 ? 'down' : 'flat';

  async function submitOrder(o: OrderSubmit): Promise<void> {
    setOrderMsg(null);
    try {
      const r = await tradeApi.place(o);
      setOrderMsg({
        tone: 'ok',
        text: r.reused
          ? `委托已存在（幂等命中），单号 #${r.orderId}`
          : `委托已提交，单号 #${r.orderId}。资金已冻结，等待撮合成交。`,
      });
      // 下单成功会改变可用资金与冻结额，刷新一次
      await load();
    } catch (e) {
      // 错误码走统一中文映射（如 INSUFFICIENT_CASH / BAD_PRICE / MARKET_IN_AUCTION）
      const code2 = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : '';
      setOrderMsg({ tone: 'err', text: errorText(code2) });
    }
  }

  return (
    <div className="stock">
      {/* 行情头 */}
      <Card>
        <div className="stock__head">
          <div className="stock__id">
            <span className="stock__name">{q.name}</span>
            <span className="stock__code num">{q.code}</span>
            {q.status === 'st' ? <span className="tag tag--st">ST</span> : null}
            <span className="stock__sector">{q.sector} · {q.board}</span>
          </div>
          <div className="stock__px">
            <span className={`stock__price num ${tone}`}>{fmtMoney(q.price)}</span>
            <span className={`stock__chg num ${tone}`}>{fmtPct(q.chgPct)}</span>
          </div>
        </div>
        <div className="stock__meta">
          <KeyValue label="昨收" value={fmtMoney(q.prevClose)} />
          {/* 服务端 QuoteView 无 open 字段（只有 prevClose/price），故不展示「今开」以免编造数据。 */}
          <KeyValue label="成交量" value={`${fmtQty(q.volume)} 股`} />
          <KeyValue label="成交额" value={fmtCompactMoney(q.turnover)} />
          <KeyValue label="涨停" value={fmtMoney(q.limitUp)} tone="up" />
          <KeyValue label="跌停" value={fmtMoney(q.limitDown)} tone="down" />
        </div>
        {q.status === 'delisting' ? (
          <div className="stock__warn" role="alert">该股票处于退市整理期，风险极高。</div>
        ) : null}
      </Card>

      {/* K 线 */}
      <Card
        title="走势"
        extra={
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={chartType === 'tick'}
              className={`seg__btn ${chartType === 'tick' ? 'is-active' : ''}`}
              onClick={() => setChartType('tick')}>分时</button>
            <button type="button" role="tab" aria-selected={chartType === 'day'}
              className={`seg__btn ${chartType === 'day' ? 'is-active' : ''}`}
              onClick={() => setChartType('day')}>日K</button>
          </div>
        }
      >
        {/* candles 为 null 说明请求失败；空数组由 CandleChart 自己展示空态 */}
        {candles === null ? <Empty text="走势数据加载失败" /> : <CandleChart data={candles} />}
      </Card>

      {/* 盘口 + 下单 */}
      <Card title="盘口（示意）">
        <DepthBook quote={q} />
      </Card>

      <Card title="交易">
        <OrderPanel
          quote={q}
          phase={phase}
          cashAvailable={me.valuation.cashAvailable}
          sellableQty={holding?.qtySellable ?? 0}
          onSubmit={submitOrder}
        />
        {orderMsg !== null ? (
          <div className={`order__result order__result--${orderMsg.tone}`} role="status">
            {orderMsg.text}
          </div>
        ) : null}
        {holding !== null ? (
          <div className="order__holding">
            持仓 {fmtQty(holding.qtyTotal)} 股（可卖 {fmtQty(holding.qtySellable)}）
            · 浮动盈亏 <span className={`num ${holding.pnl > 0 ? 'up' : holding.pnl < 0 ? 'down' : 'flat'}`}>
              {fmtMoney(holding.pnl)}
            </span>
          </div>
        ) : (
          <div className="order__holding">当前无持仓</div>
        )}
      </Card>

      {/* 财报 */}
      <Card title="财务">
        <FinancePanel
          reports={detail.reports}
          dividends={detail.dividends}
          fundamental={detail.fundamental}
        />
      </Card>

      {/* 相关新闻 */}
      <Card title="相关新闻" flush>
        {detail.news.length === 0 ? (
          <Empty text="暂无相关新闻" />
        ) : (
          <ul className="news__list">
            {detail.news.map(n => (
              <li key={n.id} className="news__item">
                <div className="news__head">
                  <span className="news__day">第 {n.day} 日</span>
                  {n.impactE6 !== 0 ? (
                    <span className={`news__impact num ${n.impactE6 > 0 ? 'up' : 'down'}`}>
                      {fmtPct(n.impactE6 / 1e6)}
                    </span>
                  ) : null}
                </div>
                <div className="news__title">{n.title}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="stock__back">
        <Link to="/market" className="link">← 返回行情</Link>
      </div>
    </div>
  );
}
