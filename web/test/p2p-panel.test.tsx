import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser, MeView, P2pLoan, P2pLimits, P2pStatus, P2pPlayer } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import P2p from '../src/pages/P2p.js';

// P2p 页面数据源：GET /api/p2p/loans、/api/p2p/limits、/api/me
//                GET /api/p2p/players?q=
//                POST /api/p2p/loans、/{id}/accept、/{id}/reject、/{id}/repay
//
// 重点验（都是「写错了用户会误解钱的状态」的点）：
// 1. 发起借款**不划款**，只有 accepts 才划 —— 文案必须说清，别让用户以为已经借到了；
// 2. 「待我确认」与「等对方确认」两组必须分开渲染，按钮也不同（同意/拒绝 vs 撤回）；
// 3. 出借方点同意前要看到「钱会从我这里划走」，借款方看到的是「钱会到我这儿」；
// 4. 只有借款方能还款（出借方不该出现还款输入框）；
// 5. pending 一律按中性色渲染，不得看起来像「已生效」；
// 6. 本地校验拦下的请求不应发出去（少跑一趟服务端）。

const ME = 10;
const alice: AuthUser = { id: ME, username: 'alice', credit: 600, isAdmin: false, bankruptCount: 0 };

const LIMITS: P2pLimits = {
  maxPrincipal: 500_000_000, minRateMult: 1, maxRateMult: 2,
  minTermDays: 1, maxTermDays: 120, graceDays: 3,
};

const me: MeView = {
  user: alice,
  valuation: { cashAvailable: 100_000_000, cashFrozen: 0, positionsValue: 0,
    loansOutstanding: 0, totalAssets: 100_000_000, totalInflow: 100_000_000, returnPct: 0 },
  positions: [], work: { busyUntil: 0, shift: null, course: null },
};

const loan = (over: Partial<P2pLoan> = {}): P2pLoan => ({
  id: 1, borrowerId: ME, borrowerName: 'alice', lenderId: 11, lenderName: 'bob',
  principal: 1_000_000, repayAmount: 1_100_000, repaid: 0, owedTotal: 1_100_000,
  termDays: 30, proposedBy: 'borrow', awaitingId: 11, awaitingName: 'bob',
  dayCreated: 1, startDay: null, dueDay: null,
  status: 'pending' as P2pStatus, note: '',
  myRole: 'borrower', daysLeft: null,
  ...over,
});

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 从 fetch 调用记录里找某个 method+url 的请求体。 */
function bodyOf(method: string, urlPart: string): unknown {
  const call = fetchMock.mock.calls.find(x =>
    String(x[0]).includes(urlPart) && ((x[1] as RequestInit)?.method ?? 'GET').toUpperCase() === method);
  expect(call, `${method} ${urlPart} 未发出`).toBeTruthy();
  return JSON.parse(String((call![1] as RequestInit).body ?? '{}'));
}

function calls(method: string, urlPart: string): number {
  return fetchMock.mock.calls.filter(x =>
    String(x[0]).includes(urlPart) && ((x[1] as RequestInit)?.method ?? 'GET').toUpperCase() === method).length;
}

function route(over: {
  loans?: P2pLoan[]; players?: P2pPlayer[];
  propose?: unknown; proposeStatus?: number;
  accept?: unknown; acceptStatus?: number;
  reject?: unknown; rejectStatus?: number;
  repay?: unknown; repayStatus?: number;
} = {}) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.startsWith('/api/p2p/players')) {
      return Promise.resolve(json({ players: over.players ?? [] }));
    }
    if (url === '/api/p2p/limits' && method === 'GET') {
      return Promise.resolve(json(LIMITS));
    }
    // ⚠️ GET（列表）与 POST（发起）同路径，必须按 method 分派 ——
    // 只匹配 URL 的话，`proposeStatus: 403` 会让首屏的 GET 也 403，
    // Promise.all 整体 reject，页面直接进错误态（症状是「找不到表单」，易误判为组件坏了）。
    if (url === '/api/p2p/loans' && method === 'POST') {
      return Promise.resolve(json(over.propose ?? { id: 9, loans: [] }, over.proposeStatus ?? 200));
    }
    if (url === '/api/p2p/loans' && method === 'GET') {
      const ls = over.loans ?? [];
      return Promise.resolve(json({
        loans: ls,
        debt: ls.filter(l => l.myRole === 'borrower' && l.status === 'active')
          .reduce((s, l) => s + l.repayAmount - l.repaid, 0),
        credit: ls.filter(l => l.myRole === 'lender' && l.status === 'active')
          .reduce((s, l) => s + l.repayAmount - l.repaid, 0),
      }));
    }
    if (url.endsWith('/accept')) {
      return Promise.resolve(json(over.accept ?? { loans: [] }, over.acceptStatus ?? 200));
    }
    if (url.endsWith('/reject')) {
      return Promise.resolve(json(over.reject ?? { loans: [] }, over.rejectStatus ?? 200));
    }
    if (url.endsWith('/repay')) {
      return Promise.resolve(json(over.repay ?? { paid: 1_100_000, closed: true, loans: [] },
        over.repayStatus ?? 200));
    }
    if (url === '/api/me') return Promise.resolve(json(me));
    return Promise.resolve(json({ code: 'NOT_FOUND', message: `no stub for ${method} ${url}` }, 404));
  });
}

function renderP2p() {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={['/life/p2p']}>
        <Routes><Route path="/life/p2p" element={<P2p />} /></Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}

/** 填一份完整的合法条款并点提交。 */
async function fillAndPropose(opts: { principal?: string; repay?: string; term?: string } = {}) {
  fireEvent.change(await screen.findByTestId('principal-input'), { target: { value: opts.principal ?? '10000' } });
  fireEvent.change(screen.getByTestId('repay-input'), { target: { value: opts.repay ?? '11000' } });
  fireEvent.change(screen.getByTestId('term-input'), { target: { value: opts.term ?? '30' } });
  fireEvent.click(screen.getByTestId('propose'));
}

describe('P2p 概览', () => {
  it('渲染负债 / 债权 / 待我确认三项', async () => {
    route({ loans: [loan({ status: 'active', repaid: 0, owedTotal: 1_100_000 })] });
    renderP2p();
    expect(await screen.findByTestId('p2p-debt')).toHaveTextContent('¥10,000.00');
    expect(screen.getByTestId('p2p-credit')).toHaveTextContent('¥0.00');
    expect(screen.getByTestId('p2p-pending')).toHaveTextContent('0 笔');
  });

  it('⚠️ pending 不计入负债（钱还没动过，计进去会虚增）', async () => {
    route({ loans: [loan({ status: 'pending', awaitingId: 11 })] });
    renderP2p();
    expect(await screen.findByTestId('p2p-debt')).toHaveTextContent('¥0.00');
    expect(screen.getByTestId('p2p-pending')).toHaveTextContent('0 笔');
  });

  it('待我确认的条数单独计数（用于提醒我有人等我回话）', async () => {
    route({ loans: [loan({ id: 1, status: 'pending', awaitingId: ME })] });
    renderP2p();
    expect(await screen.findByTestId('p2p-pending')).toHaveTextContent('1 笔');
  });

  it('逾期给出红色告警', async () => {
    route({ loans: [loan({ status: 'overdue', startDay: 1, dueDay: 31, daysLeft: -2 })] });
    renderP2p();
    expect(await screen.findByTestId('p2p-overdue-alert')).toBeInTheDocument();
  });

  it('宽限期给出较轻提示（不报红色告警）', async () => {
    route({ loans: [loan({ status: 'grace', startDay: 1, dueDay: 31, daysLeft: -1 })] });
    renderP2p();
    expect(await screen.findByTestId('p2p-grace-alert')).toBeInTheDocument();
    expect(screen.queryByTestId('p2p-overdue-alert')).toBeNull();
  });
});

describe('P2p 分组', () => {
  it('⚠️「待我确认」与「等对方确认」分开渲染，不混在一组', async () => {
    route({ loans: [
      loan({ id: 1, status: 'pending', awaitingId: ME, awaitingName: 'alice' }),
      loan({ id: 2, status: 'pending', awaitingId: 11, awaitingName: 'bob' }),
    ] });
    renderP2p();
    const mine = await screen.findByTestId('p2p-awaiting-me');
    const theirs = screen.getByTestId('p2p-awaiting-them');
    expect(mine.textContent).toContain('#1');
    expect(mine.textContent).not.toContain('#2');
    expect(theirs.textContent).toContain('#2');
    expect(theirs.textContent).not.toContain('#1');
  });

  it('⚠️ 待我确认给「同意/拒绝」，等对方确认给「撤回」', async () => {
    route({ loans: [loan({ id: 1, status: 'pending', awaitingId: ME })] });
    renderP2p();
    await screen.findByTestId('p2p-proposal');
    expect(screen.getByTestId('p2p-accept')).toBeInTheDocument();
    expect(screen.getByTestId('p2p-reject')).toBeInTheDocument();
    // 「等对方」那组不存在时，页面上不该出现撤回按钮
    expect(screen.queryByTestId('p2p-awaiting-them')).toBeNull();
  });

  it('宽限 / 逾期仍归「进行中」（还要还，不是历史）', async () => {
    route({ loans: [
      loan({ id: 1, status: 'grace', startDay: 1, dueDay: 31, daysLeft: -1 }),
      loan({ id: 2, status: 'overdue', startDay: 1, dueDay: 31, daysLeft: -3 }),
    ] });
    renderP2p();
    const open = await screen.findByTestId('p2p-open');
    expect(open.textContent).toContain('#1');
    expect(open.textContent).toContain('#2');
    expect(screen.queryByTestId('p2p-closed')).toBeNull();
  });

  it('终止态进历史列表', async () => {
    route({ loans: [
      loan({ id: 7, status: 'repaid', startDay: 1, dueDay: 31, repaid: 1_100_000, owedTotal: 0 }),
      loan({ id: 8, status: 'forgiven', startDay: 1, dueDay: 31 }),
    ] });
    renderP2p();
    const hist = await screen.findByTestId('p2p-closed');
    expect(hist.textContent).toContain('#7');
    expect(hist.textContent).toContain('#8');
    expect(hist.textContent).toContain('已还清');
    expect(hist.textContent).toContain('已豁免');
  });

  it('⚠️ pending 状态徽标为中性色，不得渲染成已生效', async () => {
    route({ loans: [loan({ id: 2, status: 'pending', awaitingId: 11 })] });
    renderP2p();
    const badge = await screen.findByTestId('p2p-status');
    expect(badge.className).toContain('badge--flat');
    expect(badge.className).not.toContain('badge--active');
  });

  it('空态提示不出现任何列表', async () => {
    route({ loans: [] });
    renderP2p();
    expect(await screen.findByText('暂无进行中的借款')).toBeInTheDocument();
    expect(screen.queryByTestId('p2p-open')).toBeNull();
    expect(screen.queryByTestId('p2p-closed')).toBeNull();
  });
});

describe('P2p 待我确认的文案', () => {
  it('⚠️ 我是出借方 → 明确提示「同意后会从我这里划走多少」', async () => {
    route({ loans: [loan({ status: 'pending', awaitingId: ME, myRole: 'lender',
      borrowerId: 11, borrowerName: 'carol', lenderId: ME, lenderName: 'alice' })] });
    renderP2p();
    const row = await screen.findByTestId('p2p-proposal');
    expect(row.textContent).toContain('对方想向我借 ¥10,000.00');
    expect(row.textContent).toContain('从我的可用资金划出 ¥10,000.00');
  });

  it('我是借款方 → 说清「对方借我多少、我到时还多少」', async () => {
    route({ loans: [loan({ status: 'pending', awaitingId: ME, myRole: 'borrower' })] });
    renderP2p();
    const row = await screen.findByTestId('p2p-proposal');
    expect(row.textContent).toContain('对方愿意借我 ¥10,000.00');
    expect(row.textContent).toContain('¥11,000.00');
  });

  it('零息提案显示「仅还本」，不显示利率百分比', async () => {
    route({ loans: [loan({ status: 'pending', awaitingId: ME, repayAmount: 1_000_000 })] });
    renderP2p();
    const row = await screen.findByTestId('p2p-proposal');
    expect(row.textContent).toContain('零息（仅还本）');
    expect(row.textContent).not.toContain('+');
  });

  it('点「同意」发 accept 请求并提示已划转', async () => {
    route({ loans: [loan({ id: 5, status: 'pending', awaitingId: ME })],
      accept: { loans: [] } });
    renderP2p();
    fireEvent.click(await screen.findByTestId('p2p-accept'));
    await waitFor(() => expect(calls('POST', '/api/p2p/loans/5/accept')).toBe(1));
    expect((await screen.findByRole('status')).textContent).toContain('已生效');
  });

  it('点「拒绝」发 reject 请求', async () => {
    route({ loans: [loan({ id: 5, status: 'pending', awaitingId: ME })], reject: { loans: [] } });
    renderP2p();
    fireEvent.click(await screen.findByTestId('p2p-reject'));
    await waitFor(() => expect(calls('POST', '/api/p2p/loans/5/reject')).toBe(1));
  });

  it('⚠️ accept 失败（出借方余额已不足）映射成中文，不回显错误码', async () => {
    route({ loans: [loan({ id: 5, status: 'pending', awaitingId: ME })],
      accept: { code: 'P2P_INSUFFICIENT_CASH', message: 'x' }, acceptStatus: 400 });
    renderP2p();
    fireEvent.click(await screen.findByTestId('p2p-accept'));
    const t = await screen.findByRole('status');
    expect(t.textContent).toBe('出借方可用资金不足');
    expect(t.textContent).not.toContain('P2P_INSUFFICIENT_CASH');
  });
});

describe('P2p 发起协商', () => {
  it('⚠️ 未选对手方时提交按钮禁用（避免发一趟必然被拒的请求）', async () => {
    route();
    renderP2p();
    const btn = await screen.findByTestId('propose');
    expect(btn).toBeDisabled();
  });

  it('搜索玩家并按 method+URL 打到 /api/p2p/players', async () => {
    route({ players: [{ id: 11, username: 'bob', credit: 620 },
      { id: 12, username: 'bobby', credit: 590 }] });
    renderP2p();
    fireEvent.change(await screen.findByTestId('player-search'), { target: { value: 'bob' } });
    await waitFor(() => expect(calls('GET', '/api/p2p/players')).toBe(1), { timeout: 2000 });
    const results = await screen.findAllByTestId('player-result');
    expect(results.map(r => r.textContent)).toEqual(['bob信誉 620', 'bobby信誉 590']);
  });

  it('选中对手方后显示姓名与信誉，并出现「换人」', async () => {
    route({ players: [{ id: 11, username: 'bob', credit: 620 }] });
    renderP2p();
    fireEvent.change(await screen.findByTestId('player-search'), { target: { value: 'bob' } });
    fireEvent.click((await screen.findAllByTestId('player-result'))[0] as Element);
    const picked = await screen.findByTestId('picked-player');
    expect(picked.textContent).toContain('bob');
    expect(picked.textContent).toContain('信誉 620');
    expect(screen.getByTestId('clear-player')).toBeInTheDocument();
    // 选完人后提交按钮可用
    expect(screen.getByTestId('propose')).not.toBeDisabled();
  });

  it('⚠️ 金额按「元」输入、提交时转「分」', async () => {
    route({ players: [{ id: 11, username: 'bob', credit: 620 }] });
    renderP2p();
    fireEvent.change(await screen.findByTestId('player-search'), { target: { value: 'bob' } });
    fireEvent.click((await screen.findAllByTestId('player-result'))[0] as Element);
    await fillAndPropose({ principal: '10000', repay: '11000', term: '30' });
    await waitFor(() => expect(calls('POST', '/api/p2p/loans')).toBe(1));
    expect(bodyOf('POST', '/api/p2p/loans')).toEqual({
      role: 'borrow', counterpartyId: 11,
      principal: 1_000_000, repayAmount: 1_100_000, termDays: 30,
    });
  });

  it('⚠️ 默认角色是「我要借钱」，切到「我要放贷」会带上 role=lend', async () => {
    route({ players: [{ id: 11, username: 'bob', credit: 620 }] });
    renderP2p();
    expect(await screen.findByTestId('role-borrow')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('role-lend'));
    fireEvent.change(screen.getByTestId('player-search'), { target: { value: 'bob' } });
    fireEvent.click((await screen.findAllByTestId('player-result'))[0] as Element);
    await fillAndPropose();
    await waitFor(() => expect(calls('POST', '/api/p2p/loans')).toBe(1));
    expect((bodyOf('POST', '/api/p2p/loans') as { role: string }).role).toBe('lend');
  });

  it('⚠️ 发起成功的提示必须说明「确认后才划款」', async () => {
    route({ players: [{ id: 11, username: 'bob', credit: 620 }], propose: { id: 9, loans: [] } });
    renderP2p();
    fireEvent.change(await screen.findByTestId('player-search'), { target: { value: 'bob' } });
    fireEvent.click((await screen.findAllByTestId('player-result'))[0] as Element);
    await fillAndPropose();
    const t = await screen.findByRole('status');
    expect(t.textContent).toContain('#9');
    expect(t.textContent).toContain('等待对手方确认后才会划款');
  });

  it('本地校验：应还低于本金时不发请求', async () => {
    route({ players: [{ id: 11, username: 'bob', credit: 620 }] });
    renderP2p();
    fireEvent.change(await screen.findByTestId('player-search'), { target: { value: 'bob' } });
    fireEvent.click((await screen.findAllByTestId('player-result'))[0] as Element);
    await fillAndPropose({ principal: '10000', repay: '9000' });
    expect(await screen.findByTestId('propose-err')).toHaveTextContent('不得低于本金');
    expect(calls('POST', '/api/p2p/loans')).toBe(0);
  });

  it('本地校验：周期超上限时不发请求，提示含区间', async () => {
    route({ players: [{ id: 11, username: 'bob', credit: 620 }] });
    renderP2p();
    fireEvent.change(await screen.findByTestId('player-search'), { target: { value: 'bob' } });
    fireEvent.click((await screen.findAllByTestId('player-result'))[0] as Element);
    await fillAndPropose({ term: '200' });
    expect(await screen.findByTestId('propose-err')).toHaveTextContent('1~120 日');
    expect(calls('POST', '/api/p2p/loans')).toBe(0);
  });

  it('本地校验：本金超单笔上限时不发请求，提示含上限金额', async () => {
    route({ players: [{ id: 11, username: 'bob', credit: 620 }] });
    renderP2p();
    fireEvent.change(await screen.findByTestId('player-search'), { target: { value: 'bob' } });
    fireEvent.click((await screen.findAllByTestId('player-result'))[0] as Element);
    await fillAndPropose({ principal: '6000000', repay: '6000000' });
    expect(await screen.findByTestId('propose-err')).toHaveTextContent('¥5,000,000.00');
    expect(calls('POST', '/api/p2p/loans')).toBe(0);
  });

  it('条款预览把应还额翻译成利率与年化', async () => {
    route();
    renderP2p();
    fireEvent.change(await screen.findByTestId('principal-input'), { target: { value: '10000' } });
    fireEvent.change(screen.getByTestId('repay-input'), { target: { value: '11000' } });
    const preview = await screen.findByTestId('terms-preview');
    expect(preview.textContent).toContain('+10.0%');
    expect(preview.textContent).toContain('年化');
  });

  it('零息条款预览显示「零息」而不是 +0%', async () => {
    route();
    renderP2p();
    fireEvent.change(await screen.findByTestId('principal-input'), { target: { value: '10000' } });
    fireEvent.change(screen.getByTestId('repay-input'), { target: { value: '10000' } });
    expect((await screen.findByTestId('terms-preview')).textContent).toContain('零息');
  });

  it('服务端拒绝时映射中文（单笔上限）', async () => {
    route({ players: [{ id: 11, username: 'bob', credit: 620 }],
      propose: { code: 'P2P_PAIR_BUSY', message: 'x' }, proposeStatus: 409 });
    renderP2p();
    fireEvent.change(await screen.findByTestId('player-search'), { target: { value: 'bob' } });
    fireEvent.click((await screen.findAllByTestId('player-result'))[0] as Element);
    await fillAndPropose();
    const t = await screen.findByRole('status');
    expect(t.textContent).toBe('你们之间已有一笔未结清的借款');
    expect(t.textContent).not.toContain('P2P_PAIR_BUSY');
  });
});

describe('P2p 还款', () => {
  it('⚠️ 只有借款方出现还款控件（出借方不该有）', async () => {
    route({ loans: [loan({ id: 1, status: 'active', myRole: 'lender',
      borrowerId: 11, borrowerName: 'carol', lenderId: ME, lenderName: 'alice',
      startDay: 1, dueDay: 31, daysLeft: 20 })] });
    renderP2p();
    await screen.findByTestId('p2p-row');
    expect(screen.queryByTestId('p2p-repay')).toBeNull();
    expect(screen.queryByTestId('p2p-repay-amount')).toBeNull();
    expect(screen.getByText('等待借款方还款（到期自动扣划）')).toBeInTheDocument();
  });

  it('借款方「全额还清」按未偿余额（分）提交', async () => {
    route({ loans: [loan({ id: 3, status: 'active', startDay: 1, dueDay: 31, daysLeft: 20,
      repaid: 100_000, owedTotal: 1_000_000 })] });
    renderP2p();
    fireEvent.click(await screen.findByTestId('p2p-repay-full'));
    await waitFor(() => expect(calls('POST', '/api/p2p/loans/3/repay')).toBe(1));
    expect(bodyOf('POST', '/api/p2p/loans/3/repay')).toEqual({ amount: 1_000_000 });
  });

  it('部分还款按元输入转分', async () => {
    route({ loans: [loan({ id: 3, status: 'active', startDay: 1, dueDay: 31, daysLeft: 20 })] });
    renderP2p();
    fireEvent.change(await screen.findByTestId('p2p-repay-amount'), { target: { value: '200' } });
    fireEvent.click(screen.getByTestId('p2p-repay'));
    await waitFor(() => expect(calls('POST', '/api/p2p/loans/3/repay')).toBe(1));
    expect(bodyOf('POST', '/api/p2p/loans/3/repay')).toEqual({ amount: 20_000 });
  });

  it('结清时提示明确说「结清」，未结清时给出剩余额', async () => {
    route({ loans: [loan({ id: 3, status: 'active', startDay: 1, dueDay: 31, daysLeft: 20 })],
      repay: { paid: 1_100_000, closed: true, loans: [] } });
    renderP2p();
    fireEvent.click(await screen.findByTestId('p2p-repay-full'));
    expect((await screen.findByRole('status')).textContent).toContain('结清');
  });

  it('未结清时提示剩余额（按服务端实际扣款算）', async () => {
    route({ loans: [loan({ id: 3, status: 'active', startDay: 1, dueDay: 31, daysLeft: 20 })],
      repay: { paid: 100_000, closed: false, loans: [] } });
    renderP2p();
    fireEvent.click(await screen.findByTestId('p2p-repay-full'));
    const t = await screen.findByRole('status');
    expect(t.textContent).toContain('已还 ¥1,000.00');
    expect(t.textContent).toContain('剩余 ¥10,000.00');
  });

  it('空输入回落到全额还清', async () => {
    route({ loans: [loan({ id: 3, status: 'active', startDay: 1, dueDay: 31, daysLeft: 20,
      owedTotal: 1_100_000 })] });
    renderP2p();
    fireEvent.click(await screen.findByTestId('p2p-repay'));
    await waitFor(() => expect(calls('POST', '/api/p2p/loans/3/repay')).toBe(1));
    expect(bodyOf('POST', '/api/p2p/loans/3/repay')).toEqual({ amount: 1_100_000 });
  });

  it('还款失败映射中文', async () => {
    route({ loans: [loan({ id: 3, status: 'active', startDay: 1, dueDay: 31, daysLeft: 20 })],
      repay: { code: 'P2P_INSUFFICIENT_CASH', message: 'x' }, repayStatus: 400 });
    renderP2p();
    fireEvent.click(await screen.findByTestId('p2p-repay-full'));
    const t = await screen.findByRole('status');
    expect(t.textContent).toBe('出借方可用资金不足');
  });
});

describe('P2p 进行中详情', () => {
  it('渲染进度（已还/应还）与到期文案', async () => {
    route({ loans: [loan({ id: 3, status: 'active', startDay: 1, dueDay: 31, daysLeft: 20,
      repaid: 550_000, owedTotal: 550_000 })] });
    renderP2p();
    const row = await screen.findByTestId('p2p-row');
    expect(row.textContent).toContain('¥5,500.00 / ¥11,000.00');
    expect(screen.getByTestId('p2p-due').textContent).toContain('还有 20 日');
  });

  it('⚠️ 逾期提示明确「不会强制平仓」（P2P 是私债，规则不同于银行贷款）', async () => {
    route({ loans: [loan({ id: 3, status: 'overdue', startDay: 1, dueDay: 31, daysLeft: -5 })] });
    renderP2p();
    const row = await screen.findByTestId('p2p-row');
    expect(row.textContent).toContain('不会强制平仓');
    expect(row.textContent).toContain('扣减借款人信誉分');
  });

  it('宽限期提示说明「逾期后才扣信誉」', async () => {
    route({ loans: [loan({ id: 3, status: 'grace', startDay: 1, dueDay: 31, daysLeft: -1 })] });
    renderP2p();
    const row = await screen.findByTestId('p2p-row');
    expect(row.textContent).toContain('宽限期内还款不扣信誉');
  });

  it('历史条目不显示进度条与还款控件', async () => {
    route({ loans: [loan({ id: 7, status: 'repaid', startDay: 1, dueDay: 31,
      repaid: 1_100_000, owedTotal: 0 })] });
    renderP2p();
    await screen.findByTestId('p2p-history');
    expect(screen.queryByTestId('p2p-progress')).toBeNull();
    expect(screen.queryByTestId('p2p-repay')).toBeNull();
  });
});

describe('P2p 错误态', () => {
  it('接口失败显示错误页与重试', async () => {
    fetchMock.mockResolvedValue(json({ code: 'INTERNAL', message: 'boom' }, 500));
    renderP2p();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
