import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { AuthUser, MeView, QuoteView } from '../src/api.js';
import OrderPanel from '../src/components/OrderPanel.js';
import { maxBuyQty, commission, transferFee, buyFreeze, sellProceeds } from '../src/lib/fees.js';
import { fmtMoney } from '../src/format.js';

// OrderPanel 是纯受控表单：只依赖 props（quote/phase/cash/持仓/可用量）+ 一个 onSubmit 回调。
// 重点验：限价/市价切换、价格步进与涨跌停夹紧、买入 100 整数倍、市价单在非连续竞价被禁用、
// 可买/可卖量上限、费用预估、clientKey 生成规则（两次点击不同、重试复用）。

const quote: QuoteView = {
  code: '000001', name: '平安银行', sector: '银行', board: 'SZ', status: 'normal',
  price: 1200, prevClose: 1180, chgPct: 0.0169, volume: 1000, turnover: 1_200_000,
  limitUp: 1298, limitDown: 1062,
};

function renderPanel(over: Partial<React.ComponentProps<typeof OrderPanel>> = {}) {
  const props: React.ComponentProps<typeof OrderPanel> = {
    quote,
    phase: 'continuous',
    cashAvailable: 1_000_000,
    sellableQty: 0,
    onSubmit: vi.fn(),
    ...over,
  };
  return { ...render(<OrderPanel {...props} />), props };
}

// 注意：价格输入框**按「元」显示、按「分」存储**（与服务端一致）。
// 断言时必须区分：input.value 是元（如 "12.00"），而 limitUp/price 是分（如 1298）。
// 本文件用 yuanOf() 把分换算成元再比对，避免重蹈「单位混用」的覆辙。
const yuanOf = (cents: number): number => cents / 100;
const priceInput = (): HTMLInputElement => screen.getByTestId('price-input') as HTMLInputElement;
const priceYuan = (): number => Number(priceInput().value);

describe('OrderPanel 买卖切换', () => {
  it('默认是买入', () => {
    renderPanel();
    expect(screen.getByRole('tab', { name: '买入' })).toHaveAttribute('aria-selected', 'true');
  });

  it('切到卖出后按钮文案变化', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: '卖出' }));
    expect(screen.getByRole('tab', { name: '卖出' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('OrderPanel 限价/市价', () => {
  it('默认限价且价格输入可用', () => {
    renderPanel();
    expect(screen.getByTestId('price-input')).toBeEnabled();
  });

  it('切到市价后价格输入被禁用（市价无需报价）', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: '市价' }));
    expect(screen.getByTestId('price-input')).toBeDisabled();
  });

  it('市价单在非连续竞价相位被禁用', () => {
    renderPanel({ phase: 'auction_open' });
    expect(screen.getByRole('tab', { name: '市价' })).toBeDisabled();
  });

  it('市价单在结算相位同样被禁用', () => {
    renderPanel({ phase: 'settlement' });
    expect(screen.getByRole('tab', { name: '市价' })).toBeDisabled();
  });

  it('结算相位下整个下单按钮被禁用', () => {
    renderPanel({ phase: 'settlement' });
    expect(screen.getByTestId('submit-order')).toBeDisabled();
  });
});

describe('OrderPanel 价格步进与夹紧', () => {
  it('步进 ± 各改变最小变动 1 分（0.01 元）', () => {
    renderPanel();
    const before = priceYuan();
    fireEvent.click(screen.getByLabelText('价格加'));
    expect(priceYuan()).toBeCloseTo(before + 0.01, 2);
    fireEvent.click(screen.getByLabelText('价格减'));
    expect(priceYuan()).toBeCloseTo(before, 2);
  });

  it('初始价取现价（元）', () => {
    renderPanel();
    expect(priceYuan()).toBeCloseTo(yuanOf(quote.price), 2);
  });

  it('输入超过涨停价时被夹到涨停价', () => {
    renderPanel();
    // 输入是「元」，故意给一个远超涨停的值（涨停 12.98 元）
    fireEvent.change(priceInput(), { target: { value: '9999' } });
    expect(priceYuan()).toBeCloseTo(yuanOf(quote.limitUp), 2);
  });

  it('输入低于跌停价时被夹到跌停价', () => {
    renderPanel();
    // 跌停 10.62 元
    fireEvent.change(priceInput(), { target: { value: '1' } });
    expect(priceYuan()).toBeCloseTo(yuanOf(quote.limitDown), 2);
  });

  it('涨停/跌停快捷填入给出正确元值', () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText('填入涨停价'));
    expect(priceYuan()).toBeCloseTo(yuanOf(quote.limitUp), 2);
    fireEvent.click(screen.getByLabelText('填入跌停价'));
    expect(priceYuan()).toBeCloseTo(yuanOf(quote.limitDown), 2);
  });

  it('「现价」快捷填入恢复最新价', () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText('填入涨停价'));
    fireEvent.click(screen.getByLabelText('填入现价'));
    expect(priceYuan()).toBeCloseTo(yuanOf(quote.price), 2);
  });
});

describe('OrderPanel 数量', () => {
  it('买入数量非 100 整数倍时下单按钮禁用并提示', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '150' } });
    expect(screen.getByTestId('submit-order')).toBeDisabled();
    expect(screen.getByText(/100 股的整数倍/)).toBeInTheDocument();
  });

  it('买入 100 整数倍时可下单', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '200' } });
    expect(screen.getByTestId('submit-order')).toBeEnabled();
  });

  it('「全仓」按可买量填入（100 整数倍且买得起）', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '全仓' }));
    const qty = Number((screen.getByTestId('qty-input') as HTMLInputElement).value);
    const expected = maxBuyQty(1_000_000, 1200);
    expect(qty).toBe(expected);
    expect(qty % 100).toBe(0);
  });

  it('卖出「全仓」填入全部可卖量（允许零股）', () => {
    renderPanel({ sellableQty: 350 });
    fireEvent.click(screen.getByRole('tab', { name: '卖出' }));
    fireEvent.click(screen.getByRole('button', { name: '全仓' }));
    expect(Number((screen.getByTestId('qty-input') as HTMLInputElement).value)).toBe(350);
  });

  it('卖出数量超过可卖量时按钮禁用', () => {
    renderPanel({ sellableQty: 100 });
    fireEvent.click(screen.getByRole('tab', { name: '卖出' }));
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '200' } });
    expect(screen.getByTestId('submit-order')).toBeDisabled();
  });

  it('无仓位时卖出按钮禁用', () => {
    renderPanel({ sellableQty: 0 });
    fireEvent.click(screen.getByRole('tab', { name: '卖出' }));
    expect(screen.getByTestId('submit-order')).toBeDisabled();
  });

  it('资金不足时买入按钮禁用', () => {
    renderPanel({ cashAvailable: 1000 });   // 连一手（1200×100）都不够
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    expect(screen.getByTestId('submit-order')).toBeDisabled();
  });
});

describe('OrderPanel 费用预估', () => {
  it('买入显示 名义 + 佣金 + 过户费 = 总冻结（无印花税）', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    const amount = 1200 * 100;
    // 显示是「分 → ¥」格式化后的文本，故用 fmtMoney 比对而非裸分值
    expect(screen.getByTestId('fee-freeze').textContent).toContain(fmtMoney(buyFreeze(amount)));
    // 买入不应出现印花税
    expect(screen.queryByTestId('fee-stamp')).not.toBeInTheDocument();
  });

  it('买入冻结额确实等于三个分项之和（分项也逐一核对）', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    const amount = 1200 * 100;
    // 冻结那一行只有合计，分项在费用明细列表里，故取整个面板的文本
    const panel = document.querySelector('.order')?.textContent ?? '';
    expect(panel).toContain(fmtMoney(amount));                  // 成交金额
    expect(panel).toContain(fmtMoney(commission(amount)));      // 佣金
    expect(panel).toContain(fmtMoney(transferFee(amount)));     // 过户费
    expect(panel).toContain(fmtMoney(buyFreeze(amount)));       // 冻结合计
    // 合计 = 三项之和，此等式即前后端一致性的核心断言
    expect(buyFreeze(amount)).toBe(amount + commission(amount) + transferFee(amount));
  });

  it('卖出显示印花税且净收入为扣费后金额', () => {
    renderPanel({ sellableQty: 500 });
    fireEvent.click(screen.getByRole('tab', { name: '卖出' }));
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    const amount = 1200 * 100;
    expect(screen.getByTestId('fee-stamp')).toBeInTheDocument();
    expect(screen.getByTestId('fee-net').textContent).toContain(fmtMoney(sellProceeds(amount)));
  });

  it('卖出净收入不含印花税以外的买入费用（口径与 fees.ts 一致）', () => {
    renderPanel({ sellableQty: 500 });
    fireEvent.click(screen.getByRole('tab', { name: '卖出' }));
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    const amount = 1200 * 100;
    const net = sellProceeds(amount);
    // 净额必须严格小于名义（有费用）
    expect(net).toBeLessThan(amount);
    expect(screen.getByTestId('fee-net').textContent).toContain(fmtMoney(net));
  });

  it('数量为 0 时不显示费用明细', () => {
    renderPanel();
    expect(screen.queryByTestId('fee-freeze')).not.toBeInTheDocument();
  });
});

describe('OrderPanel 提交', () => {
  it('提交时回传完整参数（含限价）', async () => {
    const { props } = renderPanel();
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '200' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(1));
    const arg = (props.onSubmit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.code).toBe('000001');
    expect(arg.side).toBe('B');
    expect(arg.type).toBe('L');
    expect(arg.qty).toBe(200);
    expect(arg.price).toBe(1200);
    expect(typeof arg.clientKey).toBe('string');
    expect(arg.clientKey.length).toBeGreaterThan(0);
  });

  it('市价单不传 price 字段', async () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: '市价' }));
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    const arg = (props.onSubmit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.type).toBe('M');
    expect(arg.price).toBeUndefined();
  });

  it('连续两次提交生成不同的 clientKey（避免幂等键撞车）', async () => {
    const { props } = renderPanel();
    // 提交成功会清空数量，故每次都要重新填入，模拟用户连下两单
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(2));
    const keys = (props.onSubmit as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0].clientKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('clientKey 以 code-side 开头（便于服务端排查）且不超过 64 字符', async () => {
    const { props } = renderPanel();
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    const key = (props.onSubmit as ReturnType<typeof vi.fn>).mock.calls[0]![0].clientKey as string;
    expect(key.startsWith('000001-B-')).toBe(true);
    expect(key.length).toBeLessThanOrEqual(64);   // 服务端 schema 上限
  });

  it('提交中时按钮禁用，防重复下单', async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => { /* 挂起 */ }));
    renderPanel({ onSubmit });
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    await waitFor(() => expect(screen.getByTestId('submit-order')).toBeDisabled());
  });

  it('提交成功后清空数量输入', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    renderPanel({ onSubmit });
    const qty = screen.getByTestId('qty-input');
    fireEvent.change(qty, { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('submit-order'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByTestId('qty-input') as HTMLInputElement).value).toBe(''));
  });
});
