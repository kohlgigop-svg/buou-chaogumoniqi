import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser, LoanRow, LoanProduct, CreditEvent, MeView } from '../src/api.js';
import { SessionProvider } from '../src/session.js';
import Bank from '../src/pages/Bank.js';

// Bank 页数据源：GET /api/bank/products、GET /api/bank/loans、GET /api/credit、GET /api/me
//              POST /api/bank/loans（借款）、POST /api/bank/loans/:id/repay（还款）
//
// 重点验：
// 1. 四个借款闸门的错误码中文映射（CREDIT_LOW / OVERDUE_EXISTS / LOAN_LIMIT / LEVERAGE）
// 2. rate_e6 是**日息**（不是年化），且不得显示成 `/日/日`
// 3. overdue 渲染红色告警 + 强平提示
// 4. 超额还款不拦（服务端截断），UI 展示实际扣款
// 5. 额度用的是「未偿本金」口径（与服务端 borrow 一致）

const alice: AuthUser = { id: 1, username: 'alice', credit: 600, isAdmin: false, bankruptCount: 0 };

const product = (over: Partial<LoanProduct> = {}): LoanProduct =>
  ({ termDays: 20, rateE6: 500, capCents: 5_000_000, ...over });

const loan = (over: Partial<LoanRow> = {}): LoanRow => ({
  id: 1, principal: 2_000_000, outstanding: 2_000_000, accruedInterest: 24_000,
  owedTotal: 2_024_000, rateE6: 500, termDays: 20, startDay: 1, dueDay: 21,
  status: 'active', ...over,
});

const event = (over: Partial<CreditEvent> = {}): CreditEvent =>
  ({ day: 3, delta: 1, reason: 'WAGE_SHIFT', scoreAfter: 601, ...over });

const me: MeView = {
  user: alice,
  valuation: { cashAvailable: 5_000_000, cashFrozen: 0, positionsValue: 0,
    loansOutstanding: 0, totalAssets: 5_000_000, totalInflow: 5_000_000, returnPct: 0 },
  positions: [], work: { busyUntil: 0, shift: null, course: null },
};

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function route(over: {
  credit?: number; creditLow?: boolean; products?: LoanProduct[];
  loans?: LoanRow[]; events?: CreditEvent[];
  borrow?: unknown; borrowStatus?: number;
  repay?: unknown; repayStatus?: number;
} = {}) {
  const credit = over.credit ?? 600;
  // ⚠️ `GET /api/bank/loans`（我的贷款列表）与 `POST /api/bank/loans`（借款）
  // 是**同一路径的两个语义**，stub 必须按 method 分派。若只按 URL 匹配，
  // 传了 `borrowStatus: 403` 会让首屏的 GET 也 403，`Promise.all` 整体 reject，
  // 页面直接进错误态 —— 症状是「找不到 product-list」，极易误判为组件坏了。
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url === '/api/bank/products') {
      const ps = over.products ?? [product({ termDays: 20 }), product({ termDays: 60 }), product({ termDays: 120 })];
      return Promise.resolve(json({
        credit, creditLow: over.creditLow ?? false,
        products: over.creditLow === true ? [] : ps,
      }));
    }
    if (url.startsWith('/api/bank/loans/') && url.endsWith('/repay')) {
      return Promise.resolve(json(over.repay ?? { interestPaid: 24_000, principalPaid: 2_000_000, closed: true, loans: [] },
        over.repayStatus ?? 200));
    }
    if (url === '/api/bank/loans' && method === 'POST') {
      return Promise.resolve(json(over.borrow ?? { loanId: 9, loans: [] }, over.borrowStatus ?? 200));
    }
    if (url === '/api/bank/loans') {
      return Promise.resolve(json({ credit, loans: over.loans ?? [] }));
    }
    if (url === '/api/credit') return Promise.resolve(json({ credit, events: over.events ?? [] }));
    if (url === '/api/me') return Promise.resolve(json(me));
    return Promise.resolve(json({ code: 'NOT_FOUND', message: `no stub for ${method} ${url}` }, 404));
  });
}

function renderBank() {
  return render(
    <SessionProvider initial={{ status: 'authed', user: alice }}>
      <MemoryRouter initialEntries={['/life/bank']}>
        <Routes><Route path="/life/bank" element={<Bank />} /></Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('Bank 授信概览', () => {
  it('渲染信誉分与可用额度', async () => {
    route({ credit: 600, products: [product({ capCents: 5_000_000 })] });
    renderBank();
    expect(await screen.findByTestId('bank-credit')).toHaveTextContent('600');
    // 无贷款 → 可用额度 = 上限
    expect(screen.getByTestId('bank-remaining')).toHaveTextContent('¥50,000.00');
  });

  it('⚠️ 可用额度扣的是「未偿本金」而非「应还总额」', async () => {
    route({
      products: [product({ capCents: 5_000_000 })],
      loans: [loan({ outstanding: 2_000_000, accruedInterest: 999_999, owedTotal: 2_999_999 })],
    });
    renderBank();
    // 5,000,000 − 2,000,000 = 3,000,000 分 = ¥30,000.00（不是 ¥20,000.01）
    expect(await screen.findByTestId('bank-remaining')).toHaveTextContent('¥30,000.00');
  });

  it('无贷款时额度用满', async () => {
    route({ products: [product({ capCents: 2_000_000 })], loans: [] });
    renderBank();
    expect(await screen.findByTestId('bank-remaining')).toHaveTextContent('¥20,000.00');
  });

  it('额度用尽显示 ¥0.00 而非负数', async () => {
    route({ products: [product({ capCents: 2_000_000 })], loans: [loan({ outstanding: 3_000_000 })] });
    renderBank();
    expect(await screen.findByTestId('bank-remaining')).toHaveTextContent('¥0.00');
  });
});

describe('Bank 借款', () => {
  it('渲染三档期限与日息（rate_e6 → %/日，不得出现 /日/日）', async () => {
    route({ products: [product({ termDays: 20, rateE6: 500 }), product({ termDays: 60, rateE6: 500 })] });
    renderBank();
    await screen.findByTestId('product-list');
    expect(screen.getByText('20 日')).toBeInTheDocument();
    expect(screen.getByText('60 日')).toBeInTheDocument();
    const rates = screen.getAllByTestId('product-rate').map(e => e.textContent);
    expect(rates[0]).toBe('0.050%/日');
    expect(rates[0]).not.toContain('/日/日');
  });

  it('⚠️ 日息不得标成「年化」（500 e6 = 0.05%/日）', async () => {
    route({ products: [product({ rateE6: 500 })] });
    renderBank();
    await screen.findByTestId('product-list');
    const panel = document.querySelector('.bank')?.textContent ?? '';
    expect(panel).toContain('0.050%/日');
    expect(panel).not.toContain('年化');
    expect(panel).not.toContain('%/年');
  });

  it('信誉 <500 时不显示档位，改为提额路径提示', async () => {
    route({ credit: 420, creditLow: true });
    renderBank();
    expect(await screen.findByTestId('credit-low')).toBeInTheDocument();
    expect(screen.queryByTestId('product-list')).toBeNull();
    expect(screen.getByTestId('credit-low').textContent).toContain('信誉分低于 500');
  });

  it('借款条件列出量化门槛（含额度与日息）', async () => {
    route({ products: [product({ capCents: 5_000_000, rateE6: 500 })] });
    renderBank();
    await screen.findByTestId('product-list');
    const t = document.querySelector('.bank__conditions')?.textContent ?? '';
    expect(t).toContain('¥50,000.00');
    expect(t).toContain('0.050%/日');
    expect(t).toContain('无宽限 / 逾期中的贷款');
  });

  it('按元输入借款金额，提交时转成分', async () => {
    route({ products: [product({ capCents: 5_000_000 })] });
    renderBank();
    await screen.findByTestId('product-list');
    fireEvent.change(screen.getAllByTestId('borrow-amount')[0] as Element, { target: { value: '20000' } });
    fireEvent.click(screen.getAllByTestId('borrow')[0] as Element);
    const call = await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find(x =>
        String(x[0]) === '/api/bank/loans' && (x[1] as RequestInit)?.method === 'POST');
      expect(c).toBeTruthy();
      return c as NonNullable<typeof c>;
    });
    const body = JSON.parse(String((call![1] as RequestInit).body));
    expect(body.amount).toBe(2_000_000);       // 20,000 元 → 2,000,000 分
    expect(body.termDays).toBe(20);
  });

  it('借款成功提示到账金额', async () => {
    route({ products: [product({ capCents: 5_000_000 })], borrow: { loanId: 9, loans: [] } });
    renderBank();
    await screen.findByTestId('product-list');
    fireEvent.change(screen.getAllByTestId('borrow-amount')[0] as Element, { target: { value: '10000' } });
    fireEvent.click(screen.getAllByTestId('borrow')[0] as Element);
    expect(await screen.findByText(/贷款 #9.*¥10,000\.00 已到账/)).toBeInTheDocument();
  });

  it('超过可用额度时本地拦截（不发请求）', async () => {
    route({ products: [product({ capCents: 5_000_000 })] });
    renderBank();
    await screen.findByTestId('product-list');
    fireEvent.change(screen.getAllByTestId('borrow-amount')[0] as Element, { target: { value: '999999' } });
    fireEvent.click(screen.getAllByTestId('borrow')[0] as Element);
    expect(await screen.findByText(/超过可用额度/)).toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(x =>
      String(x[0]) === '/api/bank/loans' && (x[1] as RequestInit)?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('非整元借款被本地拦截', async () => {
    route({ products: [product({ capCents: 5_000_000 })] });
    renderBank();
    await screen.findByTestId('product-list');
    fireEvent.change(screen.getAllByTestId('borrow-amount')[0] as Element, { target: { value: '200.5' } });
    fireEvent.click(screen.getAllByTestId('borrow')[0] as Element);
    expect(await screen.findByText('借款金额须为整元')).toBeInTheDocument();
  });
});

describe('Bank 借款闸门错误码映射', () => {
  const gates = [
    ['CREDIT_LOW', '信誉分不足，暂无法借款'],
    ['OVERDUE_EXISTS', '有逾期贷款未结清，暂无法借新贷'],
    ['LOAN_LIMIT', '超出授信额度上限'],
    ['LEVERAGE', '超出杠杆上限'],
  ] as const;

  for (const [code, expected] of gates) {
    it(`${code} → 中文`, async () => {
      route({ products: [product({ capCents: 5_000_000 })],
        borrow: { code, message: 'x' }, borrowStatus: 403 });
      renderBank();
      await screen.findByTestId('product-list');
      fireEvent.change(screen.getAllByTestId('borrow-amount')[0] as Element, { target: { value: '1000' } });
      fireEvent.click(screen.getAllByTestId('borrow')[0] as Element);
      const t = await screen.findByRole('status');
      expect(t.textContent).toBe(expected);
      expect(t.textContent).not.toContain(code);
    });
  }
});

describe('Bank 我的贷款', () => {
  it('空贷款显示空态', async () => {
    route({ loans: [] });
    renderBank();
    expect(await screen.findByText('暂无贷款记录')).toBeInTheDocument();
  });

  it('渲染应还总额 = outstanding + accruedInterest', async () => {
    route({ loans: [loan({ outstanding: 2_000_000, accruedInterest: 24_000, owedTotal: 2_024_000 })] });
    renderBank();
    expect(await screen.findByTestId('loan-owed')).toHaveTextContent('¥20,240.00');
  });

  it('六种状态徽标文案正确', async () => {
    route({ loans: [
      loan({ id: 1, status: 'active' }),
      loan({ id: 2, status: 'grace' }),
      loan({ id: 3, status: 'overdue' }),
      loan({ id: 4, status: 'repaid' }),
      loan({ id: 5, status: 'liquidated' }),
      loan({ id: 6, status: 'forgiven' }),
    ] });
    renderBank();
    await screen.findByTestId('loan-list');
    const labels = screen.getAllByTestId('loan-status').map(e => e.textContent);
    expect(labels).toEqual(['正常', '宽限期', '已逾期', '已还清', '已强平', '已豁免']);
  });

  it('⚠️ overdue 渲染告警并提示强平', async () => {
    route({ loans: [loan({ status: 'overdue' })] });
    renderBank();
    expect(await screen.findByTestId('overdue-alert')).toBeInTheDocument();
    const t = document.querySelector('.bank')?.textContent ?? '';
    expect(t).toContain('逾期第 10 交易日将强制平仓');
  });

  it('grace 渲染较轻的警示（不报 red 告警）', async () => {
    route({ loans: [loan({ status: 'grace' })] });
    renderBank();
    expect(await screen.findByTestId('grace-alert')).toBeInTheDocument();
    expect(screen.queryByTestId('overdue-alert')).toBeNull();
  });

  it('无逾期/宽限时不显示任何告警', async () => {
    route({ loans: [loan({ status: 'active' })] });
    renderBank();
    await screen.findByTestId('loan-row');
    expect(screen.queryByTestId('overdue-alert')).toBeNull();
    expect(screen.queryByTestId('grace-alert')).toBeNull();
  });

  it('已结清贷款不显示还款按钮', async () => {
    route({ loans: [loan({ id: 4, status: 'repaid', outstanding: 0, owedTotal: 0 })] });
    renderBank();
    await screen.findByTestId('loan-row');
    expect(screen.queryByTestId('repay')).toBeNull();
    expect(screen.queryByTestId('repay-full')).toBeNull();
    expect(screen.getByText('该笔贷款已结清')).toBeInTheDocument();
  });

  it('未结清贷款给还款按钮', async () => {
    route({ loans: [loan({ status: 'active' })] });
    renderBank();
    expect(await screen.findByTestId('repay')).toBeInTheDocument();
  });
});

describe('Bank 还款', () => {
  it('全额还清按应还总额（分）提交', async () => {
    route({ loans: [loan({ owedTotal: 2_024_000 })] });
    renderBank();
    fireEvent.click(await screen.findByTestId('repay-full'));
    const call = await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find(x => String(x[0]).endsWith('/repay'));
      expect(c).toBeTruthy();
      return c as NonNullable<typeof c>;
    });
    expect(JSON.parse(String((call![1] as RequestInit).body)).amount).toBe(2_024_000);
  });

  it('部分还款按元输入转分', async () => {
    route({ loans: [loan()] });
    renderBank();
    await screen.findByTestId('repay');
    fireEvent.change(screen.getByTestId('repay-amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('repay'));
    const call = await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find(x => String(x[0]).endsWith('/repay'));
      expect(c).toBeTruthy();
      return c as NonNullable<typeof c>;
    });
    expect(JSON.parse(String((call![1] as RequestInit).body)).amount).toBe(10_000);
  });

  it('成功提示区分利息与本金，结清时明确说明', async () => {
    route({ loans: [loan()],
      repay: { interestPaid: 24_000, principalPaid: 2_000_000, closed: true, loans: [] } });
    renderBank();
    await screen.findByTestId('repay');
    fireEvent.click(screen.getByTestId('repay-full'));
    const t = await screen.findByRole('status');
    expect(t.textContent).toContain('已还利息 ¥240.00');
    expect(t.textContent).toContain('本金 ¥20,000.00');
    expect(t.textContent).toContain('已结清');
  });

  it('⚠️ 超额还款不本地拦截（服务端截断，UI 展示实际扣款）', async () => {
    route({ loans: [loan({ owedTotal: 2_024_000 })],
      repay: { interestPaid: 24_000, principalPaid: 2_000_000, closed: true, loans: [] } });
    renderBank();
    await screen.findByTestId('repay');
    // 输入远超应还的金额
    fireEvent.change(screen.getByTestId('repay-amount'), { target: { value: '99999' } });
    fireEvent.click(screen.getByTestId('repay'));
    // 请求应发出（不被前端拦下）
    const call = await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find(x => String(x[0]).endsWith('/repay'));
      expect(c).toBeTruthy();
      return c as NonNullable<typeof c>;
    });
    expect(JSON.parse(String((call![1] as RequestInit).body)).amount).toBe(9_999_900);
    // 且提示的是服务端**实际**扣款（本金只扣了 2,000,000）
    const t = await screen.findByRole('status');
    expect(t.textContent).toContain('本金 ¥20,000.00');
  });

  it('空输入回落到全额还清', async () => {
    route({ loans: [loan({ owedTotal: 2_024_000 })] });
    renderBank();
    await screen.findByTestId('repay');
    fireEvent.click(screen.getByTestId('repay'));
    const call = await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find(x => String(x[0]).endsWith('/repay'));
      expect(c).toBeTruthy();
      return c as NonNullable<typeof c>;
    });
    expect(JSON.parse(String((call![1] as RequestInit).body)).amount).toBe(2_024_000);
  });

  it('还款失败映射中文', async () => {
    route({ loans: [loan()], repay: { code: 'BAD_AMOUNT', message: 'x' }, repayStatus: 400 });
    renderBank();
    await screen.findByTestId('repay');
    fireEvent.click(screen.getByTestId('repay'));
    const t = await screen.findByRole('status');
    expect(t.textContent).not.toContain('BAD_AMOUNT');
    expect(t.textContent).not.toBe('');
  });
});

describe('Bank 信誉流水', () => {
  it('空流水显示空态', async () => {
    route({ events: [] });
    renderBank();
    expect(await screen.findByText('暂无信誉变动')).toBeInTheDocument();
  });

  it('渲染事件并按「升绿降红」着色（信誉分越高越好，与股价相反）', async () => {
    route({ events: [
      event({ day: 5, delta: 20, reason: 'REPAY_EARLY', scoreAfter: 620 }),
      event({ day: 4, delta: -8, reason: 'OVERDUE', scoreAfter: 600 }),
    ] });
    renderBank();
    await screen.findByTestId('credit-list');
    const rows = screen.getAllByTestId('credit-row');
    expect(rows[0]?.textContent).toContain('第 5 日');
    expect(rows[0]?.textContent).toContain('提前还清');
    expect(rows[0]?.querySelector('.credit__delta')?.className).toContain('down');  // 上升 → 绿
    expect(rows[1]?.textContent).toContain('贷款逾期');
    expect(rows[1]?.querySelector('.credit__delta')?.className).toContain('up');    // 下降 → 红
  });

  it('未收录原因回原文，不丢信息', async () => {
    route({ events: [event({ reason: 'SOME_NEW' })] });
    renderBank();
    expect(await screen.findByText('SOME_NEW')).toBeInTheDocument();
  });

  it('金额带正负号', async () => {
    route({ events: [event({ delta: 15 }), event({ day: 1, delta: -8, scoreAfter: 592 })] });
    renderBank();
    await screen.findByTestId('credit-list');
    const deltas = screen.getAllByTestId('credit-row').map(r => r.querySelector('.credit__delta')?.textContent);
    expect(deltas[0]).toContain('+');
    expect(deltas[1]).toContain('-');
  });
});

describe('Bank 错误态', () => {
  it('接口失败显示错误页与重试', async () => {
    fetchMock.mockResolvedValue(json({ code: 'INTERNAL', message: 'boom' }, 500));
    renderBank();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
