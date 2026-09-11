// pages/Bank.tsx —— 布偶银行：档位表 → 借款 → 我的贷款 → 还款 + 信誉流水。
//
// 数据源：GET /api/bank/products、GET /api/bank/loans、GET /api/credit
//        POST /api/bank/loans（借款）、POST /api/bank/loans/:id/repay（还款）
//
// 单位：所有金额是**分**；`rateE6` 是**日息 e6**（300 = 0.030%/日，不是年化）；
//      `termDays` 是**游戏日**；到期日 `dueDay` 是游戏日序号。
//
// 借款的四道服务端闸门（均 403，UI 必须能正确解释）：
//   CREDIT_LOW（信誉<500）、OVERDUE_EXISTS（有宽限/逾期贷在身）、
//   LOAN_LIMIT（超档位上限）、LEVERAGE（超净资产×信誉分÷300）
import { useCallback, useEffect, useState } from 'react';
import {
  bankApi, authApi,
  type BankProducts, type LoanRow, type LoanProduct, type CreditEvent, type MeView,
} from '../api.js';
import { fmtMoney, fmtSignedMoney } from '../format.js';
import Card from '../components/Card.js';
import { Spinner, Empty } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import { errorText } from '../errors.js';
import {
  remainingCredit, loanSummary, loanRateLabel, loanStatusLabel, loanTone,
  parseRepayInput, parseBorrowInput, creditDeltaTone, creditReasonLabel,
  repayable, borrowConditions, CREDIT_LOW_HINT, FORCED_LIQ_NOTICE,
} from './lifeLogic.js';

interface Loaded {
  products: BankProducts;
  loans: LoanRow[];
  events: CreditEvent[];
  credit: number;
  me: MeView;
}

export default function Bank(): React.JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const [products, loansRes, creditRes, me] = await Promise.all([
        bankApi.products(),
        bankApi.loans(),
        bankApi.credit(),
        authApi.me(),
      ]);
      setData({
        products, loans: loansRes.loans, events: creditRes.events,
        credit: creditRes.credit, me,
      });
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function borrow(amountCents: number, termDays: number): Promise<void> {
    setMsg(null);
    try {
      const r = await bankApi.borrow(amountCents, termDays);
      setMsg({ tone: 'ok', text: `借款成功，贷款 #${r.loanId}，${fmtMoney(amountCents)} 已到账。` });
      await load();
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : '';
      setMsg({ tone: 'err', text: errorText(code) });
    }
  }

  async function repay(loanId: number, amountCents: number): Promise<void> {
    setMsg(null);
    try {
      const r = await bankApi.repay(loanId, amountCents);
      const parts: string[] = [`已还利息 ${fmtMoney(r.interestPaid)}`, `本金 ${fmtMoney(r.principalPaid)}`];
      if (r.closed) parts.push('该笔贷款已结清');
      setMsg({ tone: 'ok', text: parts.join('，') + '。' });
      await load();
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : '';
      setMsg({ tone: 'err', text: errorText(code) });
    }
  }

  if (loading) return <Spinner />;
  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (data === null) return <Spinner />;

  const { products, loans, events, credit, me } = data;
  const summary = loanSummary(loans);
  const remaining = remainingCredit(products.products, loans);

  return (
    <div className="bank">
      {msg !== null ? (
        <div className={`order__result order__result--${msg.tone}`} role="status">{msg.text}</div>
      ) : null}

      {/* 授信总览 */}
      <Card title="授信概览">
        <div className="bank__stats">
          <div className="stat">
            <div className="stat__label">信誉分</div>
            <div className="stat__value num" data-testid="bank-credit">{credit}</div>
          </div>
          <div className="stat">
            <div className="stat__label">可用额度</div>
            <div className="stat__value num" data-testid="bank-remaining">{fmtMoney(remaining)}</div>
          </div>
          <div className="stat">
            <div className="stat__label">未偿本金</div>
            <div className="stat__value num">{fmtMoney(summary.outstandingPrincipal)}</div>
          </div>
          <div className="stat">
            <div className="stat__label">应还总额</div>
            <div className={`stat__value num ${summary.owedTotal > 0 ? 'warning' : ''}`.trim()}>
              {fmtMoney(summary.owedTotal)}
            </div>
          </div>
        </div>
        {summary.hasOverdue ? (
          <div className="bank__alert bank__alert--danger" role="alert" data-testid="overdue-alert">
            有贷款已逾期，无法再借新贷。{FORCED_LIQ_NOTICE}。
          </div>
        ) : summary.hasGrace ? (
          <div className="bank__alert bank__alert--warn" role="alert" data-testid="grace-alert">
            有贷款处于宽限期，逾期前请尽快还款。{FORCED_LIQ_NOTICE}。
          </div>
        ) : null}
      </Card>

      {/* 档位 / 借款 */}
      <Card title="借款" flush>
        {products.creditLow || products.products.length === 0 ? (
          <div className="bank__low" data-testid="credit-low">
            <p className="bank__low-title">暂不可借款</p>
            <p className="bank__low-hint">{CREDIT_LOW_HINT}</p>
          </div>
        ) : (
          <>
            <ul className="products" data-testid="product-list">
              {products.products.map(p => (
                <ProductRow
                  key={p.termDays}
                  product={p}
                  remaining={remaining}
                  onBorrow={(amount) => void borrow(amount, p.termDays)}
                />
              ))}
            </ul>
            <div className="bank__conditions">
              <div className="bank__conditions-title">借款条件</div>
              <ul>
                {borrowConditions(products.products).map(c => <li key={c}>{c}</li>)}
              </ul>
            </div>
          </>
        )}
      </Card>

      {/* 我的贷款 */}
      <Card title="我的贷款" flush>
        {loans.length === 0 ? (
          <Empty text="暂无贷款记录" />
        ) : (
          <ul className="loanlist" data-testid="loan-list">
            {loans.map(l => (
              <LoanItem key={l.id} loan={l} onRepay={(cents) => void repay(l.id, cents)} />
            ))}
          </ul>
        )}
      </Card>

      {/* 信誉流水 */}
      <Card title="信誉流水" flush>
        {events.length === 0 ? (
          <Empty text="暂无信誉变动" />
        ) : (
          <ul className="credits" data-testid="credit-list">
            {events.map((e, i) => (
              <li key={`${e.day}-${e.reason}-${i}`} className="credit" data-testid="credit-row">
                <span className="credit__day">第 {e.day} 日</span>
                <span className="credit__reason">{creditReasonLabel(e.reason)}</span>
                <span className={`credit__delta num ${creditDeltaTone(e.delta)}`}>
                  {fmtSignedMoney(e.delta)}
                </span>
                <span className="credit__after num">{e.scoreAfter}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** 单档位：期限 + 日息 + 额度，含金额输入与借款按钮。 */
function ProductRow({ product, remaining, onBorrow }: {
  product: LoanProduct; remaining: number; onBorrow: (cents: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [localErr, setLocalErr] = useState<string | null>(null);

  const cap = Math.min(product.capCents, remaining);

  function submit(): void {
    const r = parseBorrowInput(text === '' ? String(cap / 100) : text);
    if ('error' in r) { setLocalErr(r.error); return; }
    if (r.cents > cap) { setLocalErr(`超过可用额度 ${fmtMoney(cap)}`); return; }
    setLocalErr(null);
    onBorrow(r.cents);
  }

  return (
    <li className="product" data-testid="product-row">
      <div className="product__head">
        <span className="product__term">{product.termDays} 日</span>
        <span className="product__rate num" data-testid="product-rate">
          {loanRateLabel(product.rateE6)}
        </span>
      </div>
      <div className="product__meta">
        <span className="num">额度上限 {fmtMoney(product.capCents)}</span>
        <span className="num">当前可用 {fmtMoney(cap)}</span>
      </div>
      <div className="product__actions">
        <input
          className="order__input num"
          type="number"
          inputMode="decimal"
          aria-label={`${product.termDays} 日借款金额（元）`}
          data-testid="borrow-amount"
          placeholder={(cap / 100).toFixed(2)}
          value={text}
          onChange={e => setText(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="borrow"
          disabled={cap <= 0}
          title={cap <= 0 ? '可用额度为 0' : undefined}
          onClick={submit}
        >
          借款
        </button>
      </div>
      {localErr !== null ? <div className="product__err" role="alert">{localErr}</div> : null}
    </li>
  );
}

/** 单笔贷款：应还、到期、状态徽标、还款输入。 */
function LoanItem({ loan, onRepay }: {
  loan: LoanRow; onRepay: (cents: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [localErr, setLocalErr] = useState<string | null>(null);
  const tone = loanTone(loan.status);
  const canRepay = repayable(loan);

  function submit(): void {
    const r = parseRepayInput(text === '' ? String(loan.owedTotal / 100) : text);
    if ('error' in r) { setLocalErr(r.error); return; }
    // 超额还款服务端会截断到应还额（多余不收），这里不拦，只提示实际扣款
    setLocalErr(null);
    onRepay(r.cents);
  }

  return (
    <li className={`loan loan--${tone}`} data-testid="loan-row" data-status={loan.status}>
      <div className="loan__head">
        <span className="loan__id num">#{loan.id}</span>
        <span className={`badge badge--${tone === 'flat' ? 'flat' : tone}`} data-testid="loan-status">
          {loanStatusLabel(loan.status)}
        </span>
        <span className="loan__rate num">{loanRateLabel(loan.rateE6)}</span>
      </div>
      <div className="loan__grid">
        <span className="loan__k">应还总额</span>
        <span className="loan__v num" data-testid="loan-owed">{fmtMoney(loan.owedTotal)}</span>
        <span className="loan__k">未偿本金</span>
        <span className="loan__v num">{fmtMoney(loan.outstanding)}</span>
        <span className="loan__k">已计提利息</span>
        <span className="loan__v num">{fmtMoney(loan.accruedInterest)}</span>
        <span className="loan__k">到期日</span>
        <span className="loan__v num">第 {loan.dueDay} 日</span>
      </div>
      {tone === 'danger' ? (
        <div className="loan__notice" role="alert">{FORCED_LIQ_NOTICE}</div>
      ) : null}
      {canRepay ? (
        <div className="loan__actions">
          <input
            className="order__input num"
            type="number"
            inputMode="decimal"
            aria-label={`贷款 #${loan.id} 还款金额（元）`}
            data-testid="repay-amount"
            placeholder={(loan.owedTotal / 100).toFixed(2)}
            value={text}
            onChange={e => setText(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--sm"
            data-testid="repay-full"
            onClick={() => onRepay(loan.owedTotal)}
          >
            全额还清
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            data-testid="repay"
            onClick={submit}
          >
            还款
          </button>
        </div>
      ) : (
        <div className="loan__done">该笔贷款已结清</div>
      )}
      {localErr !== null ? <div className="product__err" role="alert">{localErr}</div> : null}
    </li>
  );
}
