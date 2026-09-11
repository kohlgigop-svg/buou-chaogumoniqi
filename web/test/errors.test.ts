import { describe, it, expect } from 'vitest';
import { errorText } from '../src/errors.js';

// 服务端错误码 → 中文提示。未知码必须回落原文，绝不能显示空白或 undefined，
// 否则用户遇到未覆盖的错误时只会看到一片空白。
describe('errorText', () => {
  it('已知鉴权码 → 中文提示', () => {
    expect(errorText('BAD_CREDENTIALS')).toBe('用户名或密码错误');
    expect(errorText('UNAUTHORIZED')).toBe('请先登录');
    expect(errorText('BANNED')).toBe('账号已被封禁');
    expect(errorText('LOCKED')).toBe('尝试次数过多，请稍后再试');
    expect(errorText('REG_LIMIT')).toBe('今日注册名额已用完');
    expect(errorText('RATE_LIMIT')).toBe('操作过于频繁，请稍后再试');
    expect(errorText('USERNAME_TAKEN')).toBe('用户名已被占用');
  });

  it('交易类码 → 中文提示', () => {
    expect(errorText('PHASE_CLOSED')).toBe('当前时段不可交易');
    expect(errorText('MARKET_IN_AUCTION')).toBe('集合竞价时段不可下市价单');
    expect(errorText('INSUFFICIENT_CASH')).toBe('可用资金不足');
    expect(errorText('INSUFFICIENT_POSITION')).toBe('持仓不足');
    expect(errorText('BAD_QTY')).toBe('委托数量不合法');
    expect(errorText('BAD_PRICE')).toBe('委托价格不合法');
    expect(errorText('STOCK_HALTED')).toBe('该标的已停牌');
    expect(errorText('UNKNOWN_STOCK')).toBe('标的不存在');
    expect(errorText('NOT_CANCELLABLE')).toBe('该委托不可撤销');
  });

  it('借贷/打工/管理码 → 中文提示', () => {
    // 四个借款闸门，文案必须能指向「该去哪改」，不能是笼统的「不合法」：
    expect(errorText('CREDIT_LOW')).toBe('信誉分不足，暂无法借款');
    expect(errorText('OVERDUE_EXISTS')).toBe('有逾期贷款未结清，暂无法借新贷');
    expect(errorText('LOAN_LIMIT')).toBe('超出授信额度上限');
    expect(errorText('LEVERAGE')).toBe('超出杠杆上限');
    expect(errorText('LOAN_CLOSED')).toBe('该笔贷款已结清');
    expect(errorText('JOB_REQUIREMENT')).toBe('能力或信誉未达标');
    expect(errorText('SHIFT_CAP')).toBe('今日排班已达上限');
    expect(errorText('COURSE_MAX')).toBe('该项能力已满级');
    expect(errorText('FORBIDDEN')).toBe('无权限执行此操作');
    expect(errorText('CONFIG_KEY')).toBe('该配置项不可热改');
    expect(errorText('VALIDATION')).toBe('输入不合法，请检查后重试');
  });

  it('⚠️ 闸门码不得回落成英文码原文（那等于没翻译）', () => {
    for (const code of ['CREDIT_LOW', 'OVERDUE_EXISTS', 'LOAN_LIMIT', 'LEVERAGE']) {
      const t = errorText(code);
      expect(t).not.toBe(code);
      expect(t).not.toBe('');
    }
  });

  it('未知码 → 回落原文（不返回空串）', () => {
    expect(errorText('SOME_BRAND_NEW_CODE')).toBe('SOME_BRAND_NEW_CODE');
  });

  it('网关回落码 HTTP_502 也有可读文案', () => {
    expect(errorText('HTTP_502')).toMatch(/服务/);
  });

  it('空码 → 通用兜底文案', () => {
    expect(errorText('')).toBe('操作失败，请稍后重试');
  });
});
