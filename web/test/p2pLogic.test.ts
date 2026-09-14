import { describe, it, expect } from 'vitest';
import {
  p2pStatusLabel, p2pTone, p2pOpen, awaitsMe, awaitsThem, canRepayP2p,
  counterpartyOf, relationLine, interestOf, annualizedRate, interestLabel,
  dueLabel, repayPct, repayFromMult, multFromRepay, rateMultLabel,
  parseYuanInput, validatePropose, bucketLoans, summarizeP2p,
} from '../src/pages/p2pLogic.js';
import type { P2pLoan, P2pStatus } from '../src/api.js';

// p2pLogic 是玩家间借贷面板的纯函数层。这里锁死几件最容易写错的事：
// 1. 状态文案/色调九种齐全，且 `pending` **不得**被染成「进行中」的主色
//    —— 用户会以为钱已经划走了；
// 2. 「待我确认」的判定必须同时看 status 与 awaitingId（只看 status 会把
//    我自己发起的请求也显示成「等你回话」）；
// 3. 应还额上限用 floor（与服务端 validateTerms 同口径），用 round 会在边界
//    算出比服务端上限大 1 分的数，被 403 拒掉；
// 4. 汇总只计已生效借据 —— pending 的钱还没动，计进去会虚增负债。

const ME = 10;

const loan = (over: Partial<P2pLoan> = {}): P2pLoan => ({
  id: 1, borrowerId: ME, borrowerName: 'alice', lenderId: 11, lenderName: 'bob',
  principal: 1_000_000, repayAmount: 1_100_000, repaid: 0, owedTotal: 1_100_000,
  termDays: 30, proposedBy: 'borrow', awaitingId: 11, awaitingName: 'bob',
  dayCreated: 1, startDay: null, dueDay: null,
  status: 'pending' as P2pStatus, note: '',
  myRole: 'borrower', daysLeft: null,
  ...over,
});

describe('p2pStatusLabel', () => {
  it('九种状态 → 中文', () => {
    expect(p2pStatusLabel('pending')).toBe('待确认');
    expect(p2pStatusLabel('active')).toBe('进行中');
    expect(p2pStatusLabel('grace')).toBe('宽限期');
    expect(p2pStatusLabel('overdue')).toBe('已逾期');
    expect(p2pStatusLabel('repaid')).toBe('已还清');
    expect(p2pStatusLabel('settled')).toBe('已结清');
    expect(p2pStatusLabel('forgiven')).toBe('已豁免');
    expect(p2pStatusLabel('rejected')).toBe('已拒绝');
    expect(p2pStatusLabel('cancelled')).toBe('已撤回');
  });

  it('未知状态回落原文，不渲染空白', () => {
    expect(p2pStatusLabel('weird')).toBe('weird');
  });
});

describe('p2pTone', () => {
  it('⚠️ pending 是中性色，不得染成 active（钱还没划走）', () => {
    expect(p2pTone('pending')).toBe('flat');
  });

  it('逾期危险、宽限警示、生效为主色、还清为完成色', () => {
    expect(p2pTone('overdue')).toBe('danger');
    expect(p2pTone('grace')).toBe('warning');
    expect(p2pTone('active')).toBe('active');
    expect(p2pTone('repaid')).toBe('done');
    expect(p2pTone('settled')).toBe('done');
  });

  it('终止态（豁免/拒绝/撤回）为灰', () => {
    expect(p2pTone('forgiven')).toBe('flat');
    expect(p2pTone('rejected')).toBe('flat');
    expect(p2pTone('cancelled')).toBe('flat');
  });
});

describe('p2pOpen / awaitsMe / awaitsThem', () => {
  it('未结清四种状态为 open', () => {
    for (const s of ['pending', 'active', 'grace', 'overdue'] as const) {
      expect(p2pOpen({ status: s }), s).toBe(true);
    }
  });

  it('终止态不是 open', () => {
    for (const s of ['repaid', 'settled', 'forgiven', 'rejected', 'cancelled'] as const) {
      expect(p2pOpen({ status: s }), s).toBe(false);
    }
  });

  it('⚠️ 待我确认要看 awaitingId 是否是我（只看 status 会误判自己发起的）', () => {
    // 别人发给我 → awaitingId = 我 → 等我
    expect(awaitsMe(loan({ awaitingId: ME }), ME)).toBe(true);
    // 我发出去 → awaitingId = 对方 → 不是等我
    expect(awaitsMe(loan({ awaitingId: 11 }), ME)).toBe(false);
    // 已生效 → awaitingId 已被清空 → 谁都不等
    expect(awaitsMe(loan({ status: 'active', awaitingId: null }), ME)).toBe(false);
  });

  it('待对方确认：pending 且 awaitingId 不是我', () => {
    expect(awaitsThem(loan({ awaitingId: 11 }), ME)).toBe(true);
    expect(awaitsThem(loan({ awaitingId: ME }), ME)).toBe(false);
    expect(awaitsThem(loan({ status: 'active', awaitingId: null }), ME)).toBe(false);
  });
});

describe('canRepayP2p', () => {
  it('只有借款方能主动还款（出借方不该出现还款按钮）', () => {
    expect(canRepayP2p(loan({ status: 'active', myRole: 'borrower' }))).toBe(true);
    expect(canRepayP2p(loan({ status: 'active', myRole: 'lender' }))).toBe(false);
  });

  it('未生效（pending）不能还款', () => {
    expect(canRepayP2p(loan({ status: 'pending', myRole: 'borrower' }))).toBe(false);
  });

  it('宽限与逾期仍可还款', () => {
    expect(canRepayP2p(loan({ status: 'grace', myRole: 'borrower' }))).toBe(true);
    expect(canRepayP2p(loan({ status: 'overdue', myRole: 'borrower' }))).toBe(true);
  });

  it('已结清不能还款', () => {
    expect(canRepayP2p(loan({ status: 'repaid', myRole: 'borrower' }))).toBe(false);
    expect(canRepayP2p(loan({ status: 'forgiven', myRole: 'borrower' }))).toBe(false);
  });
});

describe('relationLine / counterpartyOf', () => {
  it('⚠️ 借款人视角说「我借」，出借人视角说「我借给」—— 不能只按 borrowerId 猜', () => {
    const asBorrower = loan({ myRole: 'borrower', borrowerId: ME, lenderName: 'bob' });
    expect(relationLine(asBorrower)).toBe('我向 bob 借 ¥10,000.00，到期还 ¥11,000.00');

    const asLender = loan({ myRole: 'lender', lenderId: ME, borrowerName: 'carol' });
    expect(relationLine(asLender)).toBe('我借给 carol ¥10,000.00，到期收 ¥11,000.00');
  });

  it('对手方按角色取另一侧的名字', () => {
    expect(counterpartyOf(loan({ myRole: 'borrower', lenderName: 'bob' }))).toBe('bob');
    expect(counterpartyOf(loan({ myRole: 'lender', borrowerName: 'carol' }))).toBe('carol');
  });
});

describe('interestOf / annualizedRate / interestLabel', () => {
  it('利息 = 应还 − 本金', () => {
    expect(interestOf({ principal: 1_000_000, repayAmount: 1_100_000 })).toBe(100_000);
  });

  it('脏数据（应还 < 本金）夹紧到 0，不出负数', () => {
    expect(interestOf({ principal: 1_000_000, repayAmount: 900_000 })).toBe(0);
  });

  it('零息借据年化为 0', () => {
    expect(annualizedRate({ principal: 1_000_000, repayAmount: 1_000_000, termDays: 30 })).toBe(0);
  });

  it('简单利率年化：10% / 30 日 ≈ 1.2167（不是复利）', () => {
    const r = annualizedRate({ principal: 1_000_000, repayAmount: 1_100_000, termDays: 30 })!;
    expect(r).toBeCloseTo(0.1 / 30 * 365, 10);
  });

  it('本金或期限为 0 时返回 null（避免除零）', () => {
    expect(annualizedRate({ principal: 0, repayAmount: 100, termDays: 30 })).toBeNull();
    expect(annualizedRate({ principal: 100, repayAmount: 100, termDays: 0 })).toBeNull();
  });

  it('零息给「仅还本」文案，不显示年化 0.00%', () => {
    expect(interestLabel(loan({ principal: 1_000_000, repayAmount: 1_000_000 }))).toBe('零息（仅还本）');
    expect(interestLabel(loan({ principal: 1_000_000, repayAmount: 1_100_000 }))).toBe('利息 ¥1,000.00');
  });
});

describe('dueLabel', () => {
  it('未生效时明确说「等待对方确认」，不显示到期日', () => {
    expect(dueLabel(loan({ status: 'pending', dueDay: null }))).toBe('尚未生效，等待对方确认');
  });

  it('已结清 / 已豁免 / 未生效各有专属文案', () => {
    expect(dueLabel(loan({ status: 'repaid' }))).toBe('已结清');
    expect(dueLabel(loan({ status: 'settled' }))).toBe('已结清');
    expect(dueLabel(loan({ status: 'forgiven' }))).toBe('已豁免（借款人破产）');
    expect(dueLabel(loan({ status: 'rejected' }))).toBe('未生效');
    expect(dueLabel(loan({ status: 'cancelled' }))).toBe('未生效');
  });

  it('生效后按剩余天数给「还有 N 日 / 明天 / 今天 / 已超期」四档', () => {
    expect(dueLabel(loan({ status: 'active', dueDay: 31, daysLeft: 5 }))).toBe('第 31 日到期（还有 5 日）');
    expect(dueLabel(loan({ status: 'active', dueDay: 31, daysLeft: 1 }))).toBe('第 31 日到期（明天）');
    expect(dueLabel(loan({ status: 'active', dueDay: 31, daysLeft: 0 }))).toBe('第 31 日到期（今天）');
    expect(dueLabel(loan({ status: 'overdue', dueDay: 31, daysLeft: -4 }))).toBe('第 31 日到期（已超期 4 日）');
  });
});

describe('repayPct', () => {
  it('按已还 / 应还算百分比', () => {
    expect(repayPct({ repaid: 0, repayAmount: 1_000_000 })).toBe(0);
    expect(repayPct({ repaid: 500_000, repayAmount: 1_000_000 })).toBe(50);
    expect(repayPct({ repaid: 1_000_000, repayAmount: 1_000_000 })).toBe(100);
  });

  it('⚠️ 应还为 0 时按 100 处理，不出 NaN', () => {
    expect(repayPct({ repaid: 0, repayAmount: 0 })).toBe(100);
  });

  it('脏数据（超额还款）夹紧到 100', () => {
    expect(repayPct({ repaid: 2_000_000, repayAmount: 1_000_000 })).toBe(100);
  });
});

describe('repayFromMult / multFromRepay / rateMultLabel', () => {
  it('⚠️ 应还额上限用 floor（与服务端 validateTerms 同口径）', () => {
    // 1.05 × 333 = 349.65 → floor 349；round 会得 350 而被服务端 403 拒掉
    expect(repayFromMult(333, 1.05)).toBe(349);
    expect(repayFromMult(1_000_000, 2)).toBe(2_000_000);
    expect(repayFromMult(1_000_000, 1)).toBe(1_000_000);
  });

  it('负数/非有限输入归零，不出 NaN', () => {
    expect(repayFromMult(-1, 1.5)).toBe(0);
    expect(repayFromMult(Number.NaN, 1.5)).toBe(0);
  });

  it('反推倍数与正推互逆', () => {
    expect(multFromRepay(1_000_000, 1_100_000)).toBeCloseTo(1.1, 10);
    expect(multFromRepay(0, 1_100_000)).toBe(0);
  });

  it('倍数文案：≤1 说「零息」，>1 给加价百分比', () => {
    expect(rateMultLabel(1)).toBe('零息');
    expect(rateMultLabel(0.9)).toBe('零息');
    expect(rateMultLabel(1.1)).toBe('+10.0%');     // ≥10% 留一位，够读
    expect(rateMultLabel(1.0525)).toBe('+5.25%');  // <10% 留两位，差价别被抹掉
    expect(rateMultLabel(2)).toBe('+100.0%');
  });
});

describe('parseYuanInput', () => {
  it('元 → 分', () => {
    const r = parseYuanInput('120.5', '本金');
    expect('cents' in r && r.cents).toBe(12_050);
  });

  it('空输入与非法输入给出带字段名的提示', () => {
    const empty = parseYuanInput('', '本金');
    expect('error' in empty && empty.error).toBe('请输入本金');
    const bad = parseYuanInput('abc', '应还金额');
    expect('error' in bad && bad.error).toBe('应还金额格式不正确');
  });

  it('非正数被拒', () => {
    const r = parseYuanInput('0', '本金');
    expect('error' in r && r.error).toBe('本金须大于 0');
  });
});

describe('validatePropose', () => {
  const limits = {
    maxPrincipal: 500_000_000, minRateMult: 1, maxRateMult: 2,
    minTermDays: 1, maxTermDays: 120,
  };
  const ok = { counterpartyId: 11, principalText: '10000', repayText: '11000', termText: '30' };

  it('全合法 → 返回分与天数', () => {
    const r = validatePropose(ok, limits);
    expect(r).toEqual({ ok: true, principal: 1_000_000, repayAmount: 1_100_000,
      termDays: 30, counterpartyId: 11 });
  });

  it('未选对手方先被拦（第一个报错应是用户最先该改的字段）', () => {
    const r = validatePropose({ ...ok, counterpartyId: null }, limits);
    expect('error' in r && r.error).toBe('请先选择对手方');
  });

  it('本金超单笔上限被拦，提示含上限金额', () => {
    const r = validatePropose({ ...ok, principalText: '6000000', repayText: '6000000' }, limits);
    expect('error' in r && r.error).toContain('¥5,000,000.00');
  });

  it('应还低于本金被拦', () => {
    const r = validatePropose({ ...ok, repayText: '9000' }, limits);
    expect('error' in r && r.error).toContain('不得低于本金');
  });

  it('⚠️ 利息上限按 floor 判（边界值 floor(333×1.05)=349 合法、350 不合法）', () => {
    // maxRateMult 必须是 1.05（不是 limits 里的 2），否则测的是宽上限、边界失去意义。
    const lim = { ...limits, maxPrincipal: 100_000, maxRateMult: 1.05 };
    expect(validatePropose({ counterpartyId: 11, principalText: '3.33', repayText: '3.49', termText: '10' }, lim).ok)
      .toBe(true);
    const over = validatePropose({ counterpartyId: 11, principalText: '3.33', repayText: '3.50', termText: '10' }, lim);
    expect('error' in over && over.error).toContain('利息超出上限');
  });

  it('期限超区间被拦，提示含区间', () => {
    const r = validatePropose({ ...ok, termText: '200' }, limits);
    expect('error' in r && r.error).toContain('1~120 日');
  });

  it('非整数天数被拦', () => {
    const r = validatePropose({ ...ok, termText: '30.5' }, limits);
    expect('error' in r && r.error).toContain('整数天数');
  });
});

describe('bucketLoans', () => {
  const mine = { awaitingId: 11 };
  const theirs = { awaitingId: ME };

  it('⚠️ 「等我回话」与「等对方回话」必须分开（混在一起用户会点错按钮）', () => {
    const loans = [
      loan({ id: 1, status: 'pending', awaitingId: ME }),     // 等我
      loan({ id: 2, status: 'pending', awaitingId: 11 }),     // 等对方
      loan({ id: 3, status: 'active' }),                      // 进行中
      loan({ id: 4, status: 'repaid' }),                      // 已结束
    ];
    const b = bucketLoans(loans, ME);
    expect(b.awaitingMe.map(l => l.id)).toEqual([1]);
    expect(b.awaitingThem.map(l => l.id)).toEqual([2]);
    expect(b.open.map(l => l.id)).toEqual([3]);
    expect(b.closed.map(l => l.id)).toEqual([4]);
  });

  it('宽限与逾期归入「进行中」（它们仍要还，不是历史）', () => {
    const b = bucketLoans([
      loan({ id: 1, status: 'grace' }), loan({ id: 2, status: 'overdue' }),
    ], ME);
    expect(b.open.map(l => l.id)).toEqual([1, 2]);
    expect(b.closed).toHaveLength(0);
  });

  it('各类终止态归入历史', () => {
    const b = bucketLoans([
      loan({ id: 1, status: 'forgiven' }), loan({ id: 2, status: 'rejected' }),
      loan({ id: 3, status: 'cancelled' }), loan({ id: 4, status: 'settled' }),
    ], ME);
    expect(b.closed.map(l => l.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('summarizeP2p', () => {
  it('⚠️ 只统计已生效借据 —— pending 的钱还没划，计进去会虚增负债', () => {
    const loans = [
      loan({ id: 1, status: 'pending', awaitingId: ME, myRole: 'borrower', principal: 9_999_999 }),
      loan({ id: 2, status: 'active', myRole: 'borrower', principal: 1_000_000 }),
    ];
    const s = summarizeP2p(loans, ME);
    expect(s.borrowedPrincipal).toBe(1_000_000);
    expect(s.pendingIn).toBe(1);
  });

  it('负债与债权按角色分别累计', () => {
    const s = summarizeP2p([
      loan({ id: 1, status: 'active', myRole: 'borrower', principal: 1_000_000 }),
      loan({ id: 2, status: 'active', myRole: 'lender', principal: 2_000_000 }),
      loan({ id: 3, status: 'overdue', myRole: 'lender', principal: 500_000 }),
    ], ME);
    expect(s.borrowedPrincipal).toBe(1_000_000);
    expect(s.lentPrincipal).toBe(2_500_000);
    expect(s.hasOverdue).toBe(true);
    expect(s.hasGrace).toBe(false);
  });

  it('宽限期标记（用于较轻的提示）', () => {
    const s = summarizeP2p([loan({ status: 'grace', myRole: 'borrower' })], ME);
    expect(s.hasGrace).toBe(true);
    expect(s.hasOverdue).toBe(false);
  });

  it('空列表全零', () => {
    expect(summarizeP2p([], ME)).toEqual({
      borrowedPrincipal: 0, lentPrincipal: 0, pendingIn: 0, hasOverdue: false, hasGrace: false,
    });
  });
});
