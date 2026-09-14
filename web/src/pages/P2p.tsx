// pages/P2p.tsx —— 玩家间借贷：找对手方 → 协商条款 → 双方同意 → 到期自动扣款。
//
// 数据源：GET /api/p2p/limits、GET /api/p2p/loans、GET /api/p2p/players?q=
//        POST /api/p2p/loans（发起）、/accept、/reject、/{id}/repay
//
// 单位：金额全是**分**；`termDays` / `dueDay` / `daysLeft` 是**游戏日**。
//
// ⚠️ 与银行页最重要的差别：**发起时不动钱，只有对手方点「同意」才划款**。
// 界面上必须把这件事说清楚，否则用户会以为点了发起就已经借到了。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  p2pApi, authApi,
  type P2pLoan, type P2pLimits, type P2pPlayer, type P2pLoansView,
} from '../api.js';
import { fmtMoney } from '../format.js';
import Card from '../components/Card.js';
import { Spinner, Empty } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import ProgressBar from '../components/ProgressBar.js';
import { errorText } from '../errors.js';
import {
  p2pStatusLabel, p2pTone, canRepayP2p,
  relationLine, interestLabel, rateMultLabel, annualizedRate,
  dueLabel, repayPct, multFromRepay, validatePropose,
  bucketLoans, summarizeP2p, parseYuanInput,
  type ProposeDraft,
} from './p2pLogic.js';

interface Loaded {
  loans: P2pLoan[];
  debt: number;
  credit: number;
  limits: P2pLimits;
  meId: number;
}

export default function P2p(): React.JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [proposing, setProposing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const [view, limits, me] = await Promise.all([
        p2pApi.loans(),
        p2pApi.limits(),
        authApi.me(),
      ]);
      setData({ loans: view.loans, debt: view.debt, credit: view.credit,
        limits, meId: me.user.id });
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** 统一把错误码转成中文提示（与 Bank 页同一套做法）。 */
  function fail(e: unknown): void {
    const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : '';
    setMsg({ tone: 'err', text: errorText(code) });
  }

  async function propose(input: Parameters<typeof p2pApi.propose>[0]): Promise<boolean> {
    setMsg(null);
    setProposing(true);
    try {
      const r = await p2pApi.propose(input);
      setMsg({
        tone: 'ok',
        text: `借款请求 #${r.id} 已发出，等待对手方确认后才会划款。`,
      });
      await load();
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setProposing(false);
    }
  }

  async function act(kind: 'accept' | 'reject', loan: P2pLoan): Promise<void> {
    setMsg(null);
    setBusyId(loan.id);
    try {
      if (kind === 'accept') {
        await p2pApi.accept(loan.id);
        setMsg({ tone: 'ok', text: `借据 #${loan.id} 已生效，${fmtMoney(loan.principal)} 已划转。` });
      } else {
        await p2pApi.reject(loan.id);
        setMsg({ tone: 'ok', text: `借据 #${loan.id} 已拒绝。` });
      }
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusyId(null);
    }
  }

  async function repay(loan: P2pLoan, amountCents: number): Promise<void> {
    setMsg(null);
    setBusyId(loan.id);
    try {
      const r = await p2pApi.repay(loan.id, amountCents);
      setMsg({
        tone: 'ok',
        text: r.closed
          ? `已还 ${fmtMoney(r.paid)}，借据 #${loan.id} 结清。`
          : `已还 ${fmtMoney(r.paid)}，剩余 ${fmtMoney(loan.owedTotal - r.paid)}。`,
      });
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <Spinner />;
  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (data === null) return <Spinner />;

  const { loans, limits, meId } = data;
  const sum = summarizeP2p(loans, meId);
  const buckets = bucketLoans(loans, meId);

  return (
    <div className="p2p">
      {msg !== null ? (
        <div className={`order__result order__result--${msg.tone}`} role="status">{msg.text}</div>
      ) : null}

      {/* 概览：我欠的 / 别人欠我的 / 待我回话 */}
      <Card title="我的借据">
        <div className="p2p__stats">
          <div className="stat">
            <div className="stat__label">我欠他人本金</div>
            <div className="stat__value num" data-testid="p2p-debt">{fmtMoney(sum.borrowedPrincipal)}</div>
          </div>
          <div className="stat">
            <div className="stat__label">他人欠我本金</div>
            <div className="stat__value num" data-testid="p2p-credit">{fmtMoney(sum.lentPrincipal)}</div>
          </div>
          <div className="stat">
            <div className="stat__label">待我确认</div>
            <div className={`stat__value num ${sum.pendingIn > 0 ? 'warning' : ''}`.trim()}
              data-testid="p2p-pending">
              {sum.pendingIn} 笔
            </div>
          </div>
        </div>
        {sum.hasOverdue ? (
          <div className="bank__alert bank__alert--danger" role="alert" data-testid="p2p-overdue-alert">
            我有 P2P 借款已逾期，正在按日扣减信誉分，请尽快还款。
          </div>
        ) : sum.hasGrace ? (
          <div className="bank__alert bank__alert--warn" role="alert" data-testid="p2p-grace-alert">
            我有 P2P 借款处于宽限期，逾期前还款不会扣信誉。
          </div>
        ) : null}
      </Card>

      {/* 等我回话 —— 放在最前，因为这是唯一「别人在等我」的事 */}
      {buckets.awaitingMe.length > 0 ? (
        <Card title="待我确认" flush>
          <ul className="p2plist" data-testid="p2p-awaiting-me">
            {buckets.awaitingMe.map(l => (
              <ProposalItem
                key={l.id}
                loan={l}
                busy={busyId === l.id}
                onAccept={() => void act('accept', l)}
                onReject={() => void act('reject', l)}
              />
            ))}
          </ul>
        </Card>
      ) : null}

      <NewProposal
        limits={limits}
        proposing={proposing}
        onSubmit={propose}
      />

      {/* 等对方回话（我发起的） */}
      {buckets.awaitingThem.length > 0 ? (
        <Card title="等待对方确认" flush>
          <ul className="p2plist" data-testid="p2p-awaiting-them">
            {buckets.awaitingThem.map(l => (
              <li key={l.id} className="p2p p2p--flat" data-testid="p2p-sent" data-status={l.status}>
                <div className="p2p__head">
                  <span className="p2p__id num">#{l.id}</span>
                  <span className="badge badge--flat" data-testid="p2p-status">待确认</span>
                </div>
                <div className="p2p__relation">{relationLine(l)}</div>
                <div className="p2p__meta">
                  <span>周期 {l.termDays} 日</span>
                  <span>{interestLabel(l)}</span>
                  <span>等待 {l.awaitingName ?? '对方'} 确认</span>
                </div>
                <div className="p2p__actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    data-testid="p2p-reject"
                    disabled={busyId === l.id}
                    onClick={() => void act('reject', l)}
                  >
                    撤回
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* 进行中 */}
      <Card title="进行中" flush>
        {buckets.open.length === 0 ? (
          <Empty text="暂无进行中的借款" />
        ) : (
          <ul className="p2plist" data-testid="p2p-open">
            {buckets.open.map(l => (
              <OpenLoanItem
                key={l.id}
                loan={l}
                busy={busyId === l.id}
                onRepay={(cents) => void repay(l, cents)}
              />
            ))}
          </ul>
        )}
      </Card>

      {/* 历史 */}
      {buckets.closed.length > 0 ? (
        <Card title="历史记录" flush>
          <ul className="p2plist" data-testid="p2p-closed">
            {buckets.closed.map(l => (
              <li key={l.id} className={`p2p p2p--${p2pTone(l.status)}`}
                data-testid="p2p-history" data-status={l.status}>
                <div className="p2p__head">
                  <span className="p2p__id num">#{l.id}</span>
                  <span className={`badge badge--${p2pTone(l.status)}`} data-testid="p2p-status">
                    {p2pStatusLabel(l.status)}
                  </span>
                </div>
                <div className="p2p__relation">{relationLine(l)}</div>
                <div className="p2p__meta">
                  <span>第 {l.dayCreated} 日发起</span>
                  <span>周期 {l.termDays} 日</span>
                  <span>{dueLabel(l)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <p className="page-hint">
        玩家间借款与银行无关：发起时**不划款**，对手方点「同意」后资金才从出借方转入借款方；
        到期日由系统自动从借款方可用资金扣划给出借方，余额不足则进入宽限期，逾期按日扣减借款人信誉分。
        逾期不会强制平仓 —— 私债的处置由双方自行协商。
      </p>
    </div>
  );
}

// ---------- 发起表单 ----------

/** 发起协商：选对手方 → 填条款 → 提交。发起方可以是「我要借」或「我要放贷」。 */
function NewProposal({ limits, proposing, onSubmit }: {
  limits: P2pLimits; proposing: boolean;
  onSubmit: (input: Parameters<typeof p2pApi.propose>[0]) => Promise<boolean>;
}): React.JSX.Element {
  const [role, setRole] = useState<'borrow' | 'lend'>('borrow');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<P2pPlayer[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<P2pPlayer | null>(null);
  const [draft, setDraft] = useState<ProposeDraft>({
    counterpartyId: null, principalText: '', repayText: '', termText: '30',
  });
  const [localErr, setLocalErr] = useState<string | null>(null);
  const seq = useRef(0);

  // 搜索防抖：250ms 内连续输入只发最后一次请求，避免每敲一个字打一次接口。
  useEffect(() => {
    const q = query.trim();
    if (q === '') { setFound([]); setSearching(false); return; }
    const my = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const r = await p2pApi.players(q);
          if (seq.current === my) setFound(r.players);
        } catch {
          if (seq.current === my) setFound([]);
        } finally {
          if (seq.current === my) setSearching(false);
        }
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  function pick(p: P2pPlayer): void {
    setPicked(p);
    setDraft(d => ({ ...d, counterpartyId: p.id }));
    setQuery('');
    setFound([]);
    setLocalErr(null);
  }

  function submit(): void {
    const r = validatePropose(draft, limits);
    if (!r.ok) { setLocalErr(r.error); return; }
    setLocalErr(null);
    void onSubmit({
      role, counterpartyId: r.counterpartyId, principal: r.principal,
      repayAmount: r.repayAmount, termDays: r.termDays,
    }).then(sent => {
      if (!sent) return;
      // 成功后清空条款但**保留对手方**，方便连续协商第二笔。
      setDraft(d => ({ ...d, principalText: '', repayText: '' }));
    });
  }

  // 应还额的实时提示：把用户填的绝对金额换算成百分比，并给出年化量级感。
  const principalCents = Number(draft.principalText) > 0 ? Math.round(Number(draft.principalText) * 100) : 0;
  const repayCents = Number(draft.repayText) > 0 ? Math.round(Number(draft.repayText) * 100) : 0;
  const termDays = Number(draft.termText);
  const mult = principalCents > 0 && repayCents > 0 ? multFromRepay(principalCents, repayCents) : 1;
  const annual = principalCents > 0 && repayCents > 0 && Number.isInteger(termDays) && termDays > 0
    ? annualizedRate({ principal: principalCents, repayAmount: repayCents, termDays })
    : null;

  return (
    <Card title="发起协商">
      <div className="p2p__role" role="group" aria-label="我的角色">
        <button
          type="button"
          className={`p2p__role-btn ${role === 'borrow' ? 'is-active' : ''}`}
          data-testid="role-borrow"
          aria-pressed={role === 'borrow'}
          onClick={() => setRole('borrow')}
        >
          我要借钱
        </button>
        <button
          type="button"
          className={`p2p__role-btn ${role === 'lend' ? 'is-active' : ''}`}
          data-testid="role-lend"
          aria-pressed={role === 'lend'}
          onClick={() => setRole('lend')}
        >
          我要放贷
        </button>
      </div>

      <div className="p2p__field">
        <span className="p2p__field-label">对手方（{role === 'borrow' ? '出借人' : '借款人'}）</span>
        {picked !== null ? (
          <div className="p2p__picked" data-testid="picked-player">
            <span className="p2p__picked-name">{picked.username}</span>
            <span className="p2p__picked-credit num">信誉 {picked.credit}</span>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="clear-player"
              onClick={() => { setPicked(null); setDraft(d => ({ ...d, counterpartyId: null })); }}
            >
              换人
            </button>
          </div>
        ) : (
          <>
            <input
              className="order__input num"
              type="search"
              aria-label="搜索玩家用户名"
              data-testid="player-search"
              placeholder="输入对方用户名"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            {searching ? <div className="p2p__searching">搜索中…</div> : null}
            {found.length > 0 ? (
              <ul className="p2p__results" data-testid="player-results">
                {found.map(p => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="p2p__result"
                      data-testid="player-result"
                      onClick={() => pick(p)}
                    >
                      <span className="p2p__result-name">{p.username}</span>
                      <span className="p2p__result-credit num">信誉 {p.credit}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {!searching && query.trim() !== '' && found.length === 0 ? (
              <div className="p2p__searching" data-testid="no-player">没有匹配的玩家</div>
            ) : null}
          </>
        )}
      </div>

      <div className="p2p__grid">
        <label className="p2p__field">
          <span className="p2p__field-label">本金（元）</span>
          <input
            className="order__input num"
            type="number"
            inputMode="decimal"
            data-testid="principal-input"
            placeholder="10000"
            value={draft.principalText}
            onChange={e => setDraft(d => ({ ...d, principalText: e.target.value }))}
          />
        </label>
        <label className="p2p__field">
          <span className="p2p__field-label">到期应还（元）</span>
          <input
            className="order__input num"
            type="number"
            inputMode="decimal"
            data-testid="repay-input"
            placeholder="11000"
            value={draft.repayText}
            onChange={e => setDraft(d => ({ ...d, repayText: e.target.value }))}
          />
        </label>
        <label className="p2p__field">
          <span className="p2p__field-label">还款周期（游戏日）</span>
          <input
            className="order__input num"
            type="number"
            inputMode="numeric"
            data-testid="term-input"
            placeholder="30"
            value={draft.termText}
            onChange={e => setDraft(d => ({ ...d, termText: e.target.value }))}
          />
        </label>
      </div>

      {/* 条款预览：把「应还」翻译成利率，用户才知道自己谈的是什么价 */}
      {principalCents > 0 && repayCents > 0 ? (
        <div className="p2p__preview" data-testid="terms-preview">
          <span>利率 {rateMultLabel(mult)}</span>
          {annual !== null ? <span className="num">约合年化 {(annual * 100).toFixed(1)}%（简单利率）</span> : null}
          {repayCents < principalCents ? <span className="p2p__preview-warn">应还低于本金</span> : null}
        </div>
      ) : null}

      <div className="p2p__limits">
        单笔本金上限 {fmtMoney(limits.maxPrincipal)} · 利息上限 {((limits.maxRateMult - 1) * 100).toFixed(0)}%
        （应还 ≤ 本金 × {limits.maxRateMult}）· 周期 {limits.minTermDays}~{limits.maxTermDays} 游戏日 ·
        宽限 {limits.graceDays} 日
      </div>

      <div className="p2p__submit">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="propose"
          disabled={proposing || draft.counterpartyId === null}
          title={draft.counterpartyId === null ? '请先选择对手方' : undefined}
          onClick={submit}
        >
          {proposing ? '发送中…' : '发出借款请求'}
        </button>
      </div>

      {localErr !== null ? <div className="product__err" role="alert" data-testid="propose-err">{localErr}</div> : null}
    </Card>
  );
}

// ---------- 条目 ----------

/** 别人发给我、等我点头的那笔：把条款摊开讲清「我会出多少 / 收回多少」。 */
function ProposalItem({ loan, busy, onAccept, onReject }: {
  loan: P2pLoan; busy: boolean;
  onAccept: () => void; onReject: () => void;
}): React.JSX.Element {
  // 从我的视角说清这笔交易 —— 角色不同，动作方向完全相反。
  const iAmLender = loan.myRole === 'lender';
  const interest = loan.repayAmount - loan.principal;
  return (
    <li className="p2p p2p--warning" data-testid="p2p-proposal" data-status={loan.status}>
      <div className="p2p__head">
        <span className="p2p__id num">#{loan.id}</span>
        <span className="badge badge--warning" data-testid="p2p-status">待我确认</span>
        <span className="p2p__from">
          来自 {loan.proposedBy === 'borrow' ? loan.borrowerName : loan.lenderName}
        </span>
      </div>
      <div className="p2p__relation" data-testid="p2p-relation">
        {iAmLender
          ? `对方想向我借 ${fmtMoney(loan.principal)}，${loan.termDays} 日后还我 ${fmtMoney(loan.repayAmount)}`
          : `对方愿意借我 ${fmtMoney(loan.principal)}，${loan.termDays} 日后我还 ${fmtMoney(loan.repayAmount)}`}
      </div>
      <div className="p2p__meta">
        <span>{interestLabel(loan)}</span>
        <span>{rateMultLabel(multFromRepay(loan.principal, loan.repayAmount))}</span>
        {iAmLender ? <span className="warning">同意后将从我的可用资金划出 {fmtMoney(loan.principal)}</span> : null}
      </div>
      <div className="p2p__actions">
        <button type="button" className="btn btn--sm" data-testid="p2p-reject"
          disabled={busy} onClick={onReject}>
          拒绝
        </button>
        <button type="button" className="btn btn--sm btn--primary" data-testid="p2p-accept"
          disabled={busy} onClick={onAccept}>
          {busy ? '处理中…' : '同意'}
        </button>
      </div>
    </li>
  );
}

/** 生效中的借据：进度、到期、还款。 */
function OpenLoanItem({ loan, busy, onRepay }: {
  loan: P2pLoan; busy: boolean; onRepay: (cents: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [localErr, setLocalErr] = useState<string | null>(null);
  const tone = p2pTone(loan.status);
  const iAmBorrower = loan.myRole === 'borrower';
  const leftover = loan.owedTotal;

  function submit(): void {
    const r = parseYuanInput(text === '' ? String(leftover / 100) : text, '还款金额');
    if ('error' in r) { setLocalErr(r.error); return; }
    // 超额还款由服务端截断到应还额（多余不收），这里不拦，只展示实际扣款。
    setLocalErr(null);
    onRepay(r.cents);
  }

  return (
    <li className={`p2p p2p--${tone}`} data-testid="p2p-row" data-status={loan.status}>
      <div className="p2p__head">
        <span className="p2p__id num">#{loan.id}</span>
        <span className={`badge badge--${tone}`} data-testid="p2p-status">
          {p2pStatusLabel(loan.status)}
        </span>
        <span className="p2p__role-tag">{iAmBorrower ? '我借入' : '我借出'}</span>
      </div>

      <div className="p2p__relation" data-testid="p2p-relation">{relationLine(loan)}</div>

      <ProgressBar
        kind={iAmBorrower ? '已还' : '已收回'}
        testId="p2p-progress"
        pct={repayPct(loan)}
        time={`${fmtMoney(loan.repaid)} / ${fmtMoney(loan.repayAmount)}`}
      />

      <div className="p2p__grid2">
        <span className="p2p__k">未偿余额</span>
        <span className="p2p__v num" data-testid="p2p-owed">{fmtMoney(loan.owedTotal)}</span>
        <span className="p2p__k">{iAmBorrower ? '应还总额' : '应收总额'}</span>
        <span className="p2p__v num">{fmtMoney(loan.repayAmount)}</span>
        <span className="p2p__k">到期</span>
        <span className={`p2p__v num ${tone === 'danger' ? 'up' : ''}`.trim()}
          data-testid="p2p-due">{dueLabel(loan)}</span>
      </div>

      {tone === 'danger' ? (
        <div className="p2p__notice" role="alert">
          已逾期，正按日扣减借款人信誉分。P2P 不会强制平仓。
        </div>
      ) : null}
      {tone === 'warning' ? (
        <div className="p2p__notice p2p__notice--warn">宽限期内还款不扣信誉，逾期后将按日扣分。</div>
      ) : null}

      {canRepayP2p(loan) ? (
        <div className="p2p__actions">
          <input
            className="order__input num"
            type="number"
            inputMode="decimal"
            aria-label={`借据 #${loan.id} 还款金额（元）`}
            data-testid="p2p-repay-amount"
            placeholder={(leftover / 100).toFixed(2)}
            value={text}
            onChange={e => setText(e.target.value)}
          />
          <button type="button" className="btn btn--sm" data-testid="p2p-repay-full"
            disabled={busy} onClick={() => onRepay(leftover)}>
            全额还清
          </button>
          <button type="button" className="btn btn--sm btn--primary" data-testid="p2p-repay"
            disabled={busy} onClick={submit}>
            还款
          </button>
        </div>
      ) : (
        <div className="p2p__waiting">
          {iAmBorrower ? '等待系统到期自动扣款' : '等待借款方还款（到期自动扣划）'}
        </div>
      )}
      {localErr !== null ? <div className="product__err" role="alert">{localErr}</div> : null}
    </li>
  );
}
