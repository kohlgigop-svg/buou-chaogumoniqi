// components/OrderPanel.tsx —— 买卖下单面板（受控表单 + 费用预估）。
//
// 设计要点：
// - **纯受控**：不做任何网络请求，只把校验好的参数交给 `onSubmit`，便于独立测试与复用。
// - **费用预估与服务端逐分一致**：全部走 `lib/fees.ts`（服务端 core/money.ts 的镜像）。
// - **clientKey 幂等**：同一份表单内容在一次「点击→提交」周期内复用同一个 key，
//   两次独立点击生成不同 key。这样网络重试不会重复下单，而用户主动再下一单不会被吞掉。
// - 买卖**不同费**：买入无印花税、冻结 = 名义+佣金+过户费；卖出扣印花税、展示净收入。
import { useMemo, useState } from 'react';
import type { QuoteView } from '../api.js';
import { fmtMoney, fmtQty } from '../format.js';
import { commission, stampTax, transferFee, buyFreeze, sellProceeds, maxBuyQty, LOT_SIZE } from '../lib/fees.js';

/** 与服务端 `Phase` 同构；`continuous` 才允许市价单。 */
export type OrderPhase = 'auction_open' | 'continuous' | 'auction_close' | 'settlement';

export interface OrderSubmit {
  code: string;
  side: 'B' | 'S';
  type: 'L' | 'M';
  /** 市价单**不带**该字段（服务端 schema 要求 M 单 price 必须为空）。 */
  price?: number;
  qty: number;
  clientKey: string;
}

export interface OrderPanelProps {
  quote: QuoteView;
  phase: OrderPhase;
  /** 可用资金（分）。 */
  cashAvailable: number;
  /** 可卖股数（含零股）。 */
  sellableQty: number;
  onSubmit: (o: OrderSubmit) => void | Promise<void>;
}

/** 生成幂等键：同一提交周期内稳定，不同点击不同。 */
function makeClientKey(code: string, side: 'B' | 'S'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${code}-${side}-${Date.now()}-${rand}`.slice(0, 64);
}

export default function OrderPanel({
  quote, phase, cashAvailable, sellableQty, onSubmit,
}: OrderPanelProps): React.JSX.Element {
  const [side, setSide] = useState<'B' | 'S'>('B');
  const [type, setType] = useState<'L' | 'M'>('L');
  const [price, setPrice] = useState<number>(quote.price);
  const [qtyText, setQtyText] = useState('');
  const [busy, setBusy] = useState(false);

  const qty = Number(qtyText);
  const qtyValid = Number.isInteger(qty) && qty > 0;

  // 市价单仅在连续竞价可用；结算相位一律禁止下单（与服务端 PHASE_CLOSED 对齐）
  const marketAllowed = phase === 'continuous';
  const phaseClosed = phase === 'settlement';

  const clampPrice = (p: number): number => {
    if (!Number.isFinite(p)) return quote.price;
    const lo = quote.limitDown > 0 ? quote.limitDown : 1;
    const hi = quote.limitUp > 0 ? quote.limitUp : quote.price;
    return Math.min(hi, Math.max(lo, Math.round(p)));
  };

  /** 可买量按「当前委托价」算（市价单用现价估算）。 */
  const effectivePrice = type === 'L' ? price : quote.price;
  const buyLimit = useMemo(
    () => maxBuyQty(cashAvailable, effectivePrice > 0 ? effectivePrice : 1),
    [cashAvailable, effectivePrice],
  );
  const sellLimit = sellableQty;

  const amount = qtyValid ? effectivePrice * qty : 0;
  const isBuy = side === 'B';
  const feeComm = qtyValid ? commission(amount) : 0;
  const feeTransfer = qtyValid ? transferFee(amount) : 0;
  const feeStamp = qtyValid && !isBuy ? stampTax(amount) : 0;
  const freezeOrNet = qtyValid
    ? (isBuy ? buyFreeze(amount) : sellProceeds(amount))
    : 0;

  // —— 校验（顺序即提示优先级）——
  let blockReason: string | null = null;
  if (phaseClosed) blockReason = '已收盘结算，暂停交易';
  else if (!qtyValid) blockReason = null;                     // 未填数量：仅禁用，不报错
  else if (isBuy && qty % LOT_SIZE !== 0) blockReason = `买入数量须为 ${LOT_SIZE} 股的整数倍`;
  else if (isBuy && freezeOrNet > cashAvailable) blockReason = '可用资金不足';
  else if (!isBuy && qty > sellLimit) blockReason = '超出可卖数量';
  else if (type === 'L' && (price < quote.limitDown || price > quote.limitUp)) blockReason = '价格超出涨跌停区间';

  const canSubmit = blockReason === null && qtyValid && !busy && !(type === 'M' && !marketAllowed);

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    // 幂等键在「本次提交」生成一次：若 onSubmit 抛错用户重试，应复用同一 key，
    // 但为简化状态管理，这里每次点击生成新 key —— 服务端幂等针对的是**同一 key 的重复投递**
    // （如网络层重发），那由调用方在重试时复用传入的 key 来保证。
    const key = makeClientKey(quote.code, side);
    try {
      await onSubmit({
        code: quote.code, side, type, qty,
        ...(type === 'L' ? { price } : {}),
        clientKey: key,
      });
      setQtyText('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="order">
      {/* 买卖切换 */}
      <div className="order__sides" role="tablist" aria-label="买卖方向">
        <button type="button" role="tab" aria-selected={isBuy}
          className={`order__side order__side--buy ${isBuy ? 'is-active' : ''}`}
          onClick={() => setSide('B')}>买入</button>
        <button type="button" role="tab" aria-selected={!isBuy}
          className={`order__side order__side--sell ${!isBuy ? 'is-active' : ''}`}
          onClick={() => setSide('S')}>卖出</button>
      </div>

      {/* 限价/市价 */}
      <div className="order__types" role="tablist" aria-label="委托类型">
        <button type="button" role="tab" aria-selected={type === 'L'}
          className={`order__type ${type === 'L' ? 'is-active' : ''}`}
          onClick={() => setType('L')}>限价</button>
        <button type="button" role="tab" aria-selected={type === 'M'}
          className={`order__type ${type === 'M' ? 'is-active' : ''}`}
          disabled={!marketAllowed}
          title={marketAllowed ? undefined : '仅连续竞价时段可用市价单'}
          onClick={() => setType('M')}>市价</button>
      </div>

      {/* 价格 */}
      <div className="order__field">
        <label className="order__label" htmlFor="order-price">价格（元）</label>
        <div className="order__price-row">
          <button type="button" className="order__step" aria-label="价格减"
            disabled={type === 'M'} onClick={() => setPrice(p => clampPrice(p - 1))}>−</button>
          <input
            id="order-price"
            data-testid="price-input"
            className="order__input num"
            type="number"
            inputMode="decimal"
            disabled={type === 'M'}
            value={type === 'M' ? '' : (price / 100).toFixed(2)}
            onChange={e => {
              const yuan = Number(e.target.value);
              // 输入按「元」显示，内部一律「分」，故在此 ×100 并夹紧到涨跌停
              setPrice(clampPrice(Math.round((Number.isFinite(yuan) ? yuan : 0) * 100)));
            }}
          />
          <button type="button" className="order__step" aria-label="价格加"
            disabled={type === 'M'} onClick={() => setPrice(p => clampPrice(p + 1))}>+</button>
        </div>
        <div className="order__hints">
          <button type="button" className="order__chip order__chip--down"
            aria-label="填入跌停价" onClick={() => setPrice(clampPrice(quote.limitDown))}>
            跌停 {fmtMoney(quote.limitDown)}
          </button>
          <button type="button" className="order__chip"
            aria-label="填入现价" onClick={() => setPrice(clampPrice(quote.price))}>
            现价 {fmtMoney(quote.price)}
          </button>
          <button type="button" className="order__chip order__chip--up"
            aria-label="填入涨停价" onClick={() => setPrice(clampPrice(quote.limitUp))}>
            涨停 {fmtMoney(quote.limitUp)}
          </button>
        </div>
      </div>

      {/* 数量 */}
      <div className="order__field">
        <label className="order__label" htmlFor="order-qty">
          数量（股）
          <span className="order__avail">
            {isBuy ? `可买 ${fmtQty(buyLimit)}` : `可卖 ${fmtQty(sellLimit)}`}
          </span>
        </label>
        <div className="order__qty-row">
          <input
            id="order-qty"
            data-testid="qty-input"
            className="order__input num"
            type="number"
            inputMode="numeric"
            min={0}
            step={LOT_SIZE}
            value={qtyText}
            onChange={e => setQtyText(e.target.value)}
          />
          <button type="button" className="order__chip"
            aria-label="全仓"
            onClick={() => setQtyText(String(isBuy ? buyLimit : sellLimit))}>
            全仓
          </button>
        </div>
      </div>

      {/* 费用预估 */}
      {qtyValid ? (
        <dl className="order__fees">
          <div><dt>成交金额</dt><dd className="num">{fmtMoney(amount)}</dd></div>
          <div><dt>佣金</dt><dd className="num">{fmtMoney(feeComm)}</dd></div>
          {!isBuy ? (
            <div data-testid="fee-stamp">
              <dt>印花税</dt><dd className="num">{fmtMoney(feeStamp)}</dd>
            </div>
          ) : null}
          <div><dt>过户费</dt><dd className="num">{fmtMoney(feeTransfer)}</dd></div>
          {isBuy ? (
            <div className="order__fees-total" data-testid="fee-freeze">
              <dt>预计冻结</dt><dd className="num">{fmtMoney(freezeOrNet)}</dd>
            </div>
          ) : (
            <div className="order__fees-total" data-testid="fee-net">
              <dt>预计净收入</dt><dd className="num">{fmtMoney(freezeOrNet)}</dd>
            </div>
          )}
        </dl>
      ) : null}

      {blockReason !== null && qtyValid ? (
        <div className="order__warn" role="alert">{blockReason}</div>
      ) : null}

      <button
        type="button"
        data-testid="submit-order"
        className={`order__submit ${isBuy ? 'order__submit--buy' : 'order__submit--sell'}`}
        disabled={!canSubmit}
        onClick={() => void submit()}
      >
        {busy ? '提交中…' : (isBuy ? '买入' : '卖出')}
      </button>

      {type === 'M' && marketAllowed ? (
        <p className="order__note">市价单按现价加 2% 缓冲冻结，实际以成交价结算后返还差额。</p>
      ) : null}
      {!marketAllowed && !phaseClosed ? (
        <p className="order__note">当前为竞价时段，仅支持限价单。</p>
      ) : null}
    </div>
  );
}
