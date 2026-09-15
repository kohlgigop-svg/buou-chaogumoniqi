// pages/Margin.tsx —— 融资融券（信用交易）：开通引导 → 账户概览 → 开仓 → 仓位了结 → 直接还款。
//
// 数据源：GET /api/margin（账户全景 + 阈值）、GET /api/me（可用现金，用于数量上限）
//        POST /api/margin/{open,finance,short,sell-repay,buy-cover,repay}
//
// 单位：金额一律**分**；比例一律 **e6**（1_500_000 = 150%）；数量是**股**。
//
// ⚠️ 三条不许违反的约定：
//   ① 维持担保比例 `ratioE6 === null` 表示**没有负债**，必须显示「—」。渲染成 0% 会被读成
//      「马上爆仓」（见 marginLogic.ratioPct）。
//   ② 数量上限一律用服务端下发的 `maxFinanceCents` / `maxShortCents` 换算，
//      页面里**不要**自己按「现金 ÷ 价格 ÷ 2」重算 —— 那是把服务端的公式抄第二遍，
//      漂移的后果是「UI 说能买、点下去 403」。
//   ③ 阈值（150%/130%）随 `limits` 下发，文案不要写死 —— 它们可以热改。
import { useCallback, useEffect, useState } from 'react';
import {
  marginApi, marketApi, authApi,
  type MarginView, type MarginState, type MarginPositionView,
} from '../api.js';
import { fmtMoney, fmtQty, fmtRate, fmtSignedMoney } from '../format.js';
import Card from '../components/Card.js';
import { Spinner, Empty } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import { errorText } from '../errors.js';
import {
  ratioPct, statusLabel, statusTone, alertText, kindLabel, closeActionLabel,
  parseQty, maxQtyFromCents, capacityNote,
} from './marginLogic.js';

interface Loaded { view: MarginView; cashAvailable: number }

export default function Margin(): React.JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const [view, me] = await Promise.all([marginApi.view(), authApi.me()]);
      setData({ view, cashAvailable: me.valuation.cashAvailable });
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** 统一跑一个写操作：成功 → 提示 + 重载（state 与现金都会变）；失败 → 把错误码翻成中文。 */
  async function act(fn: () => Promise<unknown>, okText: string): Promise<void> {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'ok', text: okText });
      await load();
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : '';
      setMsg({ tone: 'err', text: errorText(code) });
    }
  }

  if (loading && data === null) return <Spinner />;
  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (data === null) return <Spinner />;

  const { view, cashAvailable } = data;
  const { state, limits } = view;

  return (
    <div className="margin">
      {msg !== null ? (
        <div className={`order__result order__result--${msg.tone}`} role="status">{msg.text}</div>
      ) : null}

      {state.open ? (
        <>
          <Overview state={state} limits={limits} />
          {alertText(state, limits.warnRatioE6, limits.liqRatioE6) !== null ? (
            <div
              className={`bank__alert bank__alert--${state.status === 'call' ? 'danger' : 'warn'}`}
              role="alert"
              data-testid="margin-alert"
            >
              {alertText(state, limits.warnRatioE6, limits.liqRatioE6)}
            </div>
          ) : null}

          <OpenPositions
            state={state}
            cashAvailable={cashAvailable}
            onFinance={(code, qty) => void act(
              () => marginApi.finance(code, qty), `融资买入 ${code} ${fmtQty(qty)} 股已成交。`)}
            onShort={(code, qty) => void act(
              () => marginApi.short(code, qty), `融券卖出 ${code} ${fmtQty(qty)} 股已成交。`)}
          />

          <Positions
            state={state}
            onSellRepay={(code, qty) => void act(
              () => marginApi.sellRepay(code, qty), `已卖出 ${code} ${fmtQty(qty)} 股并冲抵负债。`)}
            onBuyCover={(code, qty) => void act(
              () => marginApi.buyCover(code, qty), `已买回 ${code} ${fmtQty(qty)} 股还券。`)}
          />

          <RepayCard
            state={state}
            cashAvailable={cashAvailable}
            onRepay={(amount) => void act(
              () => marginApi.repay(amount), `已还款 ${fmtMoney(amount)}。`)}
          />
        </>
      ) : (
        <OpenCard state={state} onOpen={() => void act(
          () => marginApi.open(), '信用账户已开通。')} />
      )}
    </div>
  );
}

/** 账户概览：维持担保比例（含两条线）、负债构成、担保物构成、可用额度。 */
function Overview({ state, limits }: {
  state: MarginState;
  limits: MarginView['limits'];
}): React.JSX.Element {
  return (
    <Card title="信用账户">
      <div className="margin__ratio">
        <div className="margin__ratio-main">
          <span className="margin__ratio-label">维持担保比例</span>
          <span
            className={`margin__ratio-value num ${statusTone(state.status)}`}
            data-testid="margin-ratio"
          >
            {ratioPct(state.ratioE6)}
          </span>
          <span className={`badge badge--${state.status === 'ok' ? 'flat' : 'danger'}`} data-testid="margin-status">
            {statusLabel(state.status)}
          </span>
        </div>
        <div className="margin__ratio-lines">
          <span className="num">警戒线 {ratioPct(limits.warnRatioE6)}</span>
          <span className="num">平仓线 {ratioPct(limits.liqRatioE6)}</span>
        </div>
      </div>

      <div className="bank__stats">
        <div className="stat">
          <div className="stat__label">融资负债</div>
          <div className="stat__value num" data-testid="margin-debt">{fmtMoney(state.debt)}</div>
        </div>
        <div className="stat">
          <div className="stat__label">已计利息</div>
          <div className="stat__value num" data-testid="margin-interest">{fmtMoney(state.interest)}</div>
        </div>
        <div className="stat">
          <div className="stat__label">融券市值</div>
          <div className="stat__value num" data-testid="margin-shortvalue">{fmtMoney(state.shortValue)}</div>
        </div>
        <div className="stat">
          <div className="stat__label">担保物</div>
          <div className="stat__value num" data-testid="margin-collateral">{fmtMoney(state.collateral)}</div>
        </div>
        <div className="stat">
          <div className="stat__label">可融资买入</div>
          <div className="stat__value num" data-testid="margin-room">{fmtMoney(state.maxFinanceCents)}</div>
        </div>
        <div className="stat">
          <div className="stat__label">已强平次数</div>
          <div className="stat__value num">{state.liquidatedCount}</div>
        </div>
      </div>

      <div className="margin__rules">
        <div className="bank__conditions-title">规则</div>
        <ul>
          <li>保证金比例 {ratioPct(limits.initRatioE6)}（融资买入金额中自有部分），即最高
            {limits.initRatioE6 > 0 ? ` ${(100 / (limits.initRatioE6 / 10_000)).toFixed(1)}` : '—'} 倍杠杆。</li>
          <li>融资日息 {fmtRate(limits.financeRateE6)}，融券日费率 {fmtRate(limits.shortRateE6)}（按融券市值计提）。</li>
          <li>维持担保比例 =（现金 + 证券市值）/（融资负债 + 融券市值 + 利息）。</li>
          <li>低于警戒线不能开新仓；低于平仓线进入追保，**下一交易日仍未补足即强制平仓**。</li>
        </ul>
      </div>
    </Card>
  );
}

/** 未开通时的引导卡（信誉分不够就说明门槛，而不是给一个点了必然失败的按钮）。 */
function OpenCard({ state, onOpen }: {
  state: MarginState; onOpen: () => void;
}): React.JSX.Element {
  return (
    <Card title="开通信用账户">
      <p className="margin__intro">
        信用账户可以用自有资金作担保向券商借钱买入（<strong>融资</strong>），
        或借入股票卖出、等跌了再买回（<strong>融券</strong>）。
        杠杆放大收益，也放大亏损；维持担保比例跌破平仓线会被强制平仓。
      </p>
      <div className="bank__stats">
        <div className="stat">
          <div className="stat__label">当前信誉分</div>
          <div className="stat__value num">{state.credit}</div>
        </div>
        <div className="stat">
          <div className="stat__label">开通门槛</div>
          <div className="stat__value num">{state.minCredit}</div>
        </div>
      </div>
      {state.eligible ? (
        <div className="margin__actions">
          <button type="button" className="btn btn--primary" data-testid="margin-open" onClick={onOpen}>
            开通信用账户
          </button>
        </div>
      ) : (
        <div className="bank__low" data-testid="margin-credit-low">
          <p className="bank__low-title">暂不可开通</p>
          <p className="bank__low-hint">信誉分需达到 {state.minCredit}，可通过按时还款、完成打工班次提升。</p>
        </div>
      )}
    </Card>
  );
}

/** 开仓：融资买入 / 融券卖出 两个表单。 */
function OpenPositions({ state, cashAvailable, onFinance, onShort }: {
  state: MarginState; cashAvailable: number;
  onFinance: (code: string, qty: number) => void;
  onShort: (code: string, qty: number) => void;
}): React.JSX.Element {
  const note = capacityNote(state);
  const disabled = !state.canOpen;
  return (
    <Card title="开仓" flush>
      {note !== null ? <div className="margin__note" role="status" data-testid="margin-capacity">{note}</div> : null}
      <div className="margin__forms">
        <TradeForm
          kind="long"
          state={state}
          cashAvailable={cashAvailable}
          disabled={disabled}
          onSubmit={onFinance}
        />
        <TradeForm
          kind="short"
          state={state}
          cashAvailable={cashAvailable}
          disabled={disabled}
          onSubmit={onShort}
        />
      </div>
    </Card>
  );
}

/**
 * 单个开仓表单。数量留空时提交**最大可买** —— 这是最常用的意图，
 * 且上限来自服务端，不会出现「留空 = 提交一个买不到的数」。
 */
function TradeForm({ kind, state, cashAvailable, disabled, onSubmit }: {
  kind: 'long' | 'short';
  state: MarginState;
  cashAvailable: number;
  disabled: boolean;
  onSubmit: (code: string, qty: number) => void;
}): React.JSX.Element {
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [price, setPrice] = useState<number | null>(null);

  const maxCents = kind === 'long' ? state.maxFinanceCents : state.maxShortCents;

  // 填够 6 位就去查一次现价，好把「金额上限」翻译成「最多几股」。
  // 查不到（代码不存在/停牌）就退回只显示金额上限 —— 不要因此拦住提交，
  // 服务端才是真正的闸门，这里只是让玩家少点一次「被拒」。
  useEffect(() => {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) { setPrice(null); return; }
    let alive = true;
    marketApi.stock(c)
      .then(d => { if (alive) setPrice(d.quote.price); })
      .catch(() => { if (alive) setPrice(null); });
    return () => { alive = false; };
  }, [code]);

  const maxQty = price === null || price <= 0
    ? 0
    : maxQtyFromCents(maxCents, price, kind === 'long' ? cashAvailable : undefined);

  function submit(): void {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) { setLocalErr('请输入 6 位股票代码'); return; }
    const r = parseQty(text);
    if ('error' in r) { setLocalErr(r.error); return; }
    if (maxQty > 0 && r.qty > maxQty) {
      setLocalErr(`超过可开仓上限，最多 ${fmtQty(maxQty)} 股`);
      return;
    }
    setLocalErr(null);
    onSubmit(c, r.qty);
  }

  const label = kindLabel(kind);
  return (
    <div className={`margin__form margin__form--${kind}`} data-testid={`margin-form-${kind}`}>
      <div className="margin__form-head">
        <span className="margin__form-title">{label}</span>
        <span className="margin__form-cap num" data-testid={`margin-cap-${kind}`}>
          上限 {fmtMoney(maxCents)}
          {maxQty > 0 ? ` · 最多 ${fmtQty(maxQty)} 股` : ''}
        </span>
      </div>
      <div className="margin__form-hint">
        {kind === 'long'
          ? '借钱买入，股票作为担保物，**不可直接卖出**，须走「卖券还款」。'
          : '借券卖出，卖出所得与自备保证金一并冻结作担保，须走「买券还券」了结。'}
      </div>
      <div className="margin__form-row">
        <input
          className="order__input num"
          type="text"
          inputMode="numeric"
          maxLength={6}
          aria-label={`${label}股票代码`}
          data-testid={`margin-code-${kind}`}
          placeholder="股票代码"
          value={code}
          onChange={e => setCode(e.target.value)}
        />
        <input
          className="order__input num"
          type="number"
          inputMode="numeric"
          step={100}
          min={100}
          aria-label={`${label}数量（股）`}
          data-testid={`margin-qty-${kind}`}
          placeholder="数量（100 股整数倍）"
          value={text}
          onChange={e => setText(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid={`margin-submit-${kind}`}
          disabled={disabled}
          onClick={submit}
        >
          {label}
        </button>
      </div>
      {localErr !== null ? <div className="product__err" role="alert">{localErr}</div> : null}
    </div>
  );
}

/** 信用持仓：多头可「卖券还款」，空头可「买券还券」。 */
function Positions({ state, onSellRepay, onBuyCover }: {
  state: MarginState;
  onSellRepay: (code: string, qty: number) => void;
  onBuyCover: (code: string, qty: number) => void;
}): React.JSX.Element {
  return (
    <Card title="信用持仓" flush>
      {state.positions.length === 0 ? (
        <Empty text="暂无信用持仓" />
      ) : (
        <ul className="loanlist" data-testid="margin-positions">
          {state.positions.map(p => (
            <PositionItem
              key={`${p.kind}-${p.code}`}
              pos={p}
              onClose={(qty) => (p.kind === 'long'
                ? onSellRepay(p.code, qty) : onBuyCover(p.code, qty))}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PositionItem({ pos, onClose }: {
  pos: MarginPositionView; onClose: (qty: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [localErr, setLocalErr] = useState<string | null>(null);
  const tone = pos.pnl > 0 ? 'down' : pos.pnl < 0 ? 'up' : 'flat';

  function submit(): void {
    const r = parseQty(text === '' ? String(pos.qty) : text);
    if ('error' in r) { setLocalErr(r.error); return; }
    if (r.qty > pos.qty) { setLocalErr(`超过持仓 ${fmtQty(pos.qty)} 股`); return; }
    setLocalErr(null);
    onClose(r.qty);
  }

  return (
    <li className="loan" data-testid="margin-position" data-kind={pos.kind}>
      <div className="loan__head">
        <span className="loan__id num">{pos.code}</span>
        <span className="margin__pos-name">{pos.name}</span>
        <span className={`badge badge--${pos.kind === 'long' ? 'flat' : 'danger'}`}>{kindLabel(pos.kind)}</span>
      </div>
      <div className="loan__grid">
        <span className="loan__k">数量</span>
        <span className="loan__v num" data-testid="pos-qty">{fmtQty(pos.qty)} 股</span>
        <span className="loan__k">现价</span>
        <span className="loan__v num">{fmtMoney(pos.price)}</span>
        <span className="loan__k">市值</span>
        <span className="loan__v num">{fmtMoney(pos.marketValue)}</span>
        <span className="loan__k">浮动盈亏</span>
        <span className={`loan__v num ${tone}`} data-testid="pos-pnl">{fmtSignedMoney(pos.pnl)}</span>
        {pos.kind === 'short' ? (
          <>
            <span className="loan__k">冻结担保金</span>
            <span className="loan__v num">{fmtMoney(pos.frozen)}</span>
          </>
        ) : null}
        <span className="loan__k">开仓日</span>
        <span className="loan__v num">第 {pos.openedDay} 日</span>
      </div>
      <div className="loan__actions">
        <input
          className="order__input num"
          type="number"
          inputMode="numeric"
          step={100}
          min={100}
          aria-label={`${pos.code} 了结数量（股）`}
          data-testid="close-qty"
          placeholder={String(pos.qty)}
          value={text}
          onChange={e => setText(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="close-position"
          onClick={submit}
        >
          {closeActionLabel(pos.kind)}
        </button>
      </div>
      {localErr !== null ? <div className="product__err" role="alert">{localErr}</div> : null}
    </li>
  );
}

/** 直接还款（现金 → 券商，先息后本）。 */
function RepayCard({ state, cashAvailable, onRepay }: {
  state: MarginState; cashAvailable: number; onRepay: (amount: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [localErr, setLocalErr] = useState<string | null>(null);

  function submit(): void {
    const t = text.trim();
    if (t === '') { setLocalErr('请填写还款金额'); return; }
    if (!/^\d+(\.\d{1,2})?$/.test(t)) { setLocalErr('金额格式不正确'); return; }
    const cents = Math.round(Number(t) * 100);
    if (cents <= 0) { setLocalErr('金额须大于 0'); return; }
    if (cents > cashAvailable) { setLocalErr(`超过可用资金 ${fmtMoney(cashAvailable)}`); return; }
    setLocalErr(null);
    onRepay(cents);
  }

  const owed = state.owedTotal;
  return (
    <Card title="还款">
      <div className="bank__stats">
        <div className="stat">
          <div className="stat__label">应还合计</div>
          <div className="stat__value num" data-testid="margin-owed">{fmtMoney(owed)}</div>
        </div>
        <div className="stat">
          <div className="stat__label">可用资金</div>
          <div className="stat__value num">{fmtMoney(cashAvailable)}</div>
        </div>
      </div>
      <div className="margin__actions">
        <input
          className="order__input num"
          type="number"
          inputMode="decimal"
          aria-label="还款金额（元）"
          data-testid="margin-repay-amount"
          placeholder={(Math.min(owed, cashAvailable) / 100).toFixed(2)}
          value={text}
          onChange={e => setText(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--sm"
          data-testid="margin-repay-full"
          disabled={owed <= 0}
          onClick={() => { setLocalErr(null); onRepay(Math.min(owed, cashAvailable)); }}
        >
          尽量还清
        </button>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="margin-repay"
          disabled={owed <= 0}
          onClick={submit}
        >
          还款
        </button>
      </div>
      {localErr !== null ? <div className="product__err" role="alert">{localErr}</div> : null}
    </Card>
  );
}
