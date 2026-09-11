import { describe, it, expect } from 'vitest';
import {
  ledgerKindLabel, orderStatusLabel, orderSideLabel, directionTone,
  mergePage, rankBadge, isSelf, settledDays,
} from '../src/pages/meLogic.js';
import type { LedgerRow, OrderRow } from '../src/api.js';

// meLogic 是「榜单 + 我的」的纯函数层。这里锁死三件容易写错的事：
// 1. ledger.kind 有 20 种，未知码必须**回落原文**而不是渲染空白/undefined；
// 2. 分页语义是 `id < before` 且 `nextBefore = 末条 id`，故相邻两页**必然重叠一条**，
//    合并必须按 id 去重（否则「加载更多」会把同一条显示两遍）；
// 3. 前三名徽标、破产标注、高亮自己的判定口径。

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: 1, user_id: 10, bucket: 'A', day: 1, tick: 0, kind: 'GENESIS',
  amount: 10_000_000, balance_after: 10_000_000, ref_type: 'genesis', ref_id: 10,
  created_at: 1_789_109_718, ...over,
});

const order = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: 1, user_id: 10, code: '000334', side: 'B', type: 'L', price: 5183, qty: 100,
  filled: 0, status: 'open', frozen: 518_805, client_key: 'k1', day: 1, created_tick: 100,
  ...over,
});

describe('ledgerKindLabel', () => {
  it('已知 kind → 中文标签', () => {
    expect(ledgerKindLabel('GENESIS')).toBe('初始资金');
    expect(ledgerKindLabel('TRADE_BUY')).toBe('买入');
    expect(ledgerKindLabel('TRADE_SELL')).toBe('卖出');
    expect(ledgerKindLabel('WAGE')).toBe('工资');
    expect(ledgerKindLabel('LOAN_DRAW')).toBe('贷款放款');
    expect(ledgerKindLabel('LOAN_REPAY')).toBe('贷款还款');
    expect(ledgerKindLabel('RELIEF')).toBe('破产救济');
    expect(ledgerKindLabel('BANKRUPTCY')).toBe('破产清算');
  });

  it('⚠️ 服务端全部 20 个 kind 都有映射（漏一个就会静默显示英文码）', () => {
    // 来源：`grep -rhoE "kind: '[A-Z_]+'" server/src/ | sort -u`
    const ALL = [
      'BANKRUPTCY', 'BANKRUPTCY_FORFEIT', 'COMP', 'COURSE_FEE', 'DELIST_RECOVERY',
      'DIVIDEND', 'DIVIDEND_TAX', 'FORCED_SELL', 'GENESIS', 'LOAN_DRAW', 'LOAN_LIQ',
      'LOAN_REPAY', 'ORDER_FREEZE', 'ORDER_RELEASE', 'ORDER_UNFREEZE', 'RELIEF',
      'SH', 'TRADE_BUY', 'TRADE_SELL', 'WAGE',
    ] as const;
    for (const k of ALL) {
      const label = ledgerKindLabel(k);
      expect(label, `${k} 未映射`).not.toBe(k);
      expect(label).not.toBe('');
    }
  });

  it('⚠️ 未知 kind 回落原文，不渲染空白', () => {
    expect(ledgerKindLabel('SOME_NEW_KIND')).toBe('SOME_NEW_KIND');
    expect(ledgerKindLabel('')).toBe('');
  });
});

describe('orderStatusLabel / orderSideLabel', () => {
  it('四种订单状态 → 中文', () => {
    expect(orderStatusLabel('open')).toBe('未成交');
    expect(orderStatusLabel('done')).toBe('已成交');
    expect(orderStatusLabel('cancelled')).toBe('已撤销');
    expect(orderStatusLabel('expired')).toBe('已过期');
  });

  it('未知状态回落原文', () => {
    expect(orderStatusLabel('weird')).toBe('weird');
  });

  it('买卖方向 → 中文', () => {
    expect(orderSideLabel('B')).toBe('买入');
    expect(orderSideLabel('S')).toBe('卖出');
    expect(orderSideLabel('X')).toBe('X');
  });
});

describe('directionTone', () => {
  it('⚠️ 买入用 up（红）、卖出用 down（绿）—— A 股惯例', () => {
    expect(directionTone('B')).toBe('up');
    expect(directionTone('S')).toBe('down');
  });

  it('金额流向：正数（入账）绿、负数（出账）红', () => {
    expect(directionTone('B', 500)).toBe('down');    // 入账 → 绿
    expect(directionTone('B', -500)).toBe('up');     // 出账 → 红
    expect(directionTone('B', 0)).toBe('flat');
  });
});

describe('mergePage', () => {
  it('拼接两页', () => {
    const a = [row({ id: 5 }), row({ id: 4 })];
    const b = [row({ id: 3 }), row({ id: 2 })];
    expect(mergePage(a, b).map(r => r.id)).toEqual([5, 4, 3, 2]);
  });

  it('⚠️ 相邻页重叠一条要去重（服务端 nextBefore = 末条 id → 下页从该条开始）', () => {
    const a = [row({ id: 5 }), row({ id: 4 })];
    // 第二页用 before=4 请求，服务端回 id<4，但若误用 before=4 之外的游标会重叠
    const b = [row({ id: 4 }), row({ id: 3 })];
    const merged = mergePage(a, b);
    expect(merged.map(r => r.id)).toEqual([5, 4, 3]);
  });

  it('保持稳定顺序（按出现先后，不重排）', () => {
    const a = [row({ id: 9 }), row({ id: 7 })];
    const b = [row({ id: 8 })];
    expect(mergePage(a, b).map(r => r.id)).toEqual([9, 7, 8]);
  });

  it('空页不改变结果', () => {
    const a = [row({ id: 1 })];
    expect(mergePage(a, []).map(r => r.id)).toEqual([1]);
    expect(mergePage([], a).map(r => r.id)).toEqual([1]);
  });
});

describe('rankBadge', () => {
  it('前三名给名次，其余为 null', () => {
    expect(rankBadge(0)).toBe(1);
    expect(rankBadge(1)).toBe(2);
    expect(rankBadge(2)).toBe(3);
    expect(rankBadge(3)).toBeNull();
    expect(rankBadge(99)).toBeNull();
  });
});

describe('isSelf', () => {
  it('按 username 匹配（服务端榜单不回 id）', () => {
    expect(isSelf('alice', 'alice')).toBe(true);
    expect(isSelf('alice', 'bob')).toBe(false);
  });

  it('当前用户名为空/undefined 时一律 false（未登录不应高亮任何人）', () => {
    expect(isSelf('', 'alice')).toBe(false);
    expect(isSelf(undefined, 'alice')).toBe(false);
    expect(isSelf('alice', undefined)).toBe(false);
  });
});

describe('settledDays', () => {
  it('由 day 差值算「T+N」结算标记', () => {
    expect(settledDays(1, 1)).toBe(0);
    expect(settledDays(1, 3)).toBe(2);
  });

  it('同日为 0，不为负', () => {
    expect(settledDays(5, 5)).toBe(0);
    expect(settledDays(5, 2)).toBe(0);
  });
});
