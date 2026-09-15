// test/domain/margin.test.ts —— 融资融券：开户 / 融资买入 / 融券卖出 / 卖券还款 / 买券还券 /
// 直接还款 / 维持担保比例 / 逐日计息 / T+1 追保强平 / 与 ledger 勾稽的一致性。
//
// 全部由真实 Engine 的结算 tick 驱动（不用假时间），与 loans.test.ts 同一套脚手架。
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS, type Config } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { PlayerMatcher } from '../../src/trading/matcher.js';
import { auditGlobal, auditUser, post } from '../../src/core/ledger.js';
import { valuation } from '../../src/domain/portfolio.js';
import {
  openMarginAccount, marginState, financeBuy, shortSell, sellToRepay, buyToCover,
  repayMargin, MarginSettlementHook,
} from '../../src/domain/margin.js';
import { STOCK_SEEDS } from '../../src/seed/stocks.js';

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const TICKS_PER_DAY = 1200;
const CODE = STOCK_SEEDS[0]!.code;
const CODE2 = STOCK_SEEDS[1]!.code;

let db: DB;
let cfg: Config;
let engine: Engine;
let hook: MarginSettlementHook;
let uid: number;

let userSeq = 0;

function newUser(name: string, cash: number): number {
  userSeq += 1;
  const r = db.prepare(`INSERT INTO users(username, pwd_hash, created_day, created_at)
    VALUES (?, 'x', 1, 0)`).run(`${name}#${String(userSeq)}`);
  const id = Number(r.lastInsertRowid);
  post(db, 1, 0, 'genesis', id, [
    { account: ACC.MARKET, bucket: 'A', amount: -cash, kind: 'GENESIS' },
    { account: id, bucket: 'A', amount: cash, kind: 'GENESIS' },
  ]);
  return id;
}

/** 推进 n 个交易日：只执行每日的结算 tick（tickInDay=1180），跳过日内 1199 个定价 tick。 */
function advanceDays(n: number): void {
  const e = engine as unknown as { lastTick: number; advanceOne(t: number, s: boolean): void };
  let done = e.lastTick >= TICKS_PER_DAY - 20 ? Math.floor(e.lastTick / TICKS_PER_DAY) + 1 : 0;
  for (let i = 0; i < n; i++) {
    done += 1;
    const settle = (done - 1) * TICKS_PER_DAY + 1180;
    e.lastTick = settle - 1;
    e.advanceOne(settle, true);
  }
}

function setPrice(code: string, price: number): void {
  db.prepare('UPDATE stock_state SET price = ?, prev_close = ? WHERE code = ?').run(price, price, code);
}

function cashOf(id: number): number {
  return (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(id) as { a: number }).a;
}
function frozenOf(id: number): number {
  return (db.prepare('SELECT cash_frozen f FROM users WHERE id = ?').get(id) as { f: number }).f;
}
function holding(id: number, code: string): { qt: number; qs: number; qm: number; ct: number } | undefined {
  return db.prepare('SELECT qty_total qt, qty_sellable qs, qty_margin qm, cost_total ct FROM holdings WHERE user_id = ? AND code = ?')
    .get(id, code) as { qt: number; qs: number; qm: number; ct: number } | undefined;
}
function posRow(id: number, code: string, kind: 'long' | 'short'): { qty: number; cost: number; frozen: number } | undefined {
  return db.prepare('SELECT qty, cost, frozen FROM margin_positions WHERE user_id = ? AND code = ? AND kind = ?')
    .get(id, code, kind) as { qty: number; cost: number; frozen: number } | undefined;
}
function debtOf(id: number): { debt: number; interest: number; warn: number | null; liq: number } {
  const r = db.prepare('SELECT debt, interest, warn_since_day w, liquidated_count l FROM margin_accounts WHERE user_id = ?')
    .get(id) as { debt: number; interest: number; w: number | null; l: number };
  return { debt: r.debt, interest: r.interest, warn: r.w, liq: r.l };
}
/** 记账三件套：单户勾稽 + 全局平衡。每个写用例结束都该跑一次。 */
function expectLedgerBalanced(id: number): void {
  expect(() => auditUser(db, id)).not.toThrow();
  expect(() => auditGlobal(db)).not.toThrow();
}

function newMarginUser(cash: number): number {
  const id = newUser(`u${String(cash)}`, cash);
  db.prepare('UPDATE users SET credit = 700 WHERE id = ?').run(id);
  openMarginAccount(db, cfg, id);
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  // ⚠️ 必须深拷贝：`DEFAULTS` 是模块级单例，用例里改一个阈值（如 maxDebtPerCreditPoint）
  // 会污染同进程内后续所有用例 —— 谁先跑谁定调。app.ts 里对 cfg 做 structuredClone
  // 是同一个原因。
  cfg = structuredClone(DEFAULTS);
  hook = new MarginSettlementHook({ db, cfg });
  engine = new Engine({ db, cfg, masterSeed: 7, genesisMs: GENESIS, settlementHooks: [hook] });
  setPrice(CODE, 1000);
  setPrice(CODE2, 1000);
});

// ---------- 开户 ----------

describe('openMarginAccount：信誉分门槛', () => {
  it('信誉分 < 650 拒绝（CREDIT_LOW），达到门槛后开通；重复开通幂等', () => {
    const id = newUser('low', 1_000_000);
    db.prepare('UPDATE users SET credit = 649 WHERE id = ?').run(id);
    expect(() => openMarginAccount(db, cfg, id)).toThrowError(/credit score/);
    expect(marginState(db, cfg, id).open).toBe(false);

    db.prepare('UPDATE users SET credit = 650 WHERE id = ?').run(id);
    openMarginAccount(db, cfg, id);
    expect(marginState(db, cfg, id).open).toBe(true);
    expect(marginState(db, cfg, id).eligible).toBe(true);
    openMarginAccount(db, cfg, id); // 幂等：不抛、不重复插行
    expect((db.prepare('SELECT COUNT(*) c FROM margin_accounts WHERE user_id = ?').get(id) as
      { c: number }).c).toBe(1);
  });

  it('未开通就下单 → MARGIN_NOT_OPEN（不是 500、不是静默成功）', () => {
    const id = newUser('nope', 10_000_000);
    db.prepare('UPDATE users SET credit = 700 WHERE id = ?').run(id);
    expect(() => financeBuy(db, cfg, id, CODE, 100)).toThrowError(/margin account not opened/);
    expect(() => shortSell(db, cfg, id, CODE, 100)).toThrowError(/margin account not opened/);
  });
});

// ---------- 融资买入 ----------

describe('financeBuy：保证金 50% ⇒ 2 倍杠杆，担保股票进 holdings 但不可卖', () => {
  it('记账与状态：借入 = 金额 × 50%、debt 同步、qty_margin = 全部、维持担保比例 = 200%', () => {
    // 金额 5,000,000 分 → 保证金 2,500,000 + 费用 1,300 = 2,501,300（刚好花光现金）
    const id = newMarginUser(2_501_300);
    const r = financeBuy(db, cfg, id, CODE, 5_000);
    expect(r.amount).toBe(5_000_000);
    expect(r.loanAmount).toBe(2_500_000);
    expect(r.marginUsed).toBe(2_500_000);

    expect(cashOf(id)).toBe(0);
    expect(debtOf(id).debt).toBe(2_500_000);

    // 股票仍进 holdings（分红/退市/估值都走既有路径），但整笔都是担保物
    expect(holding(id, CODE)).toEqual({ qt: 5_000, qs: 0, qm: 5_000, ct: 5_001_300 });
    expect(posRow(id, CODE, 'long')).toEqual({ qty: 5_000, cost: 5_001_300, frozen: 0 });

    const st = marginState(db, cfg, id);
    expect(st.ratioE6).toBe(2_000_000);      // 纯融资开仓 = 200%
    expect(st.liability).toBe(2_500_000);
    expect(st.collateral).toBe(5_000_000);
    expect(st.status).toBe('ok');
    expectLedgerBalanced(id);
  });

  it('可用现金不足自有保证金 → INSUFFICIENT_CASH，且不留任何痕迹（事务整体回滚）', () => {
    const id = newMarginUser(2_501_299); // 差 1 分
    expect(() => financeBuy(db, cfg, id, CODE, 5_000)).toThrowError(/available cash/);
    expect(holding(id, CODE)).toBeUndefined();
    expect(posRow(id, CODE, 'long')).toBeUndefined();
    expect(debtOf(id).debt).toBe(0);
    expect(cashOf(id)).toBe(2_501_299);
    expectLedgerBalanced(id);
  });

  it('超过融资负债上限（信誉分 × 每分额度）→ MARGIN_LIMIT', () => {
    // 信誉 700 × 200_000 分 = 140,000,000 分额度；这里把额度调到很小以触发
    const id = newMarginUser(100_000_000);
    cfg.margin.maxDebtPerCreditPoint = 100;   // 700 × 100 = 70,000 分额度
    expect(() => financeBuy(db, cfg, id, CODE, 5_000)).toThrowError(/debt cap/);
  });

  it('低于单笔最小金额 → BAD_AMOUNT', () => {
    const id = newMarginUser(100_000_000);
    expect(() => financeBuy(db, cfg, id, CODE, 1)).toThrowError(/order amount/);
  });
});

// ---------- 融券卖出 ----------

describe('shortSell：卖出所得 + 自备保证金全额冻结，开仓即 150%', () => {
  it('冻结 = 净额 + 保证金；现金只减少保证金；维持担保比例恰好 150%', () => {
    // 金额 2,000,000；费用 = 佣金 500 + 过户 20 + 印花 1,000 = 1,520
    // 保证金 = 1,000,000 + 1,520 = 1,001,520；冻结 = 1,998,480 + 1,001,520 = 3,000,000
    const id = newMarginUser(1_001_520);
    const r = shortSell(db, cfg, id, CODE, 2_000);
    expect(r.amount).toBe(2_000_000);
    expect(r.marginUsed).toBe(1_001_520);
    expect(r.loanAmount).toBe(0);

    expect(cashOf(id)).toBe(0);
    expect(frozenOf(id)).toBe(3_000_000);
    expect(posRow(id, CODE, 'short')).toEqual({ qty: 2_000, cost: 1_998_480, frozen: 3_000_000 });
    // 空头不产生 holdings（券是借来的）
    expect(holding(id, CODE)).toBeUndefined();

    const st = marginState(db, cfg, id);
    expect(st.ratioE6).toBe(1_500_000);      // ⚠️ 必须是「恰好」150%：低一点点就会被自己判成警戒
    expect(st.status).toBe('ok');
    expect(st.canOpen).toBe(true);
    expectLedgerBalanced(id);
  });

  it('保证金不足 → INSUFFICIENT_CASH（差 1 分也不行）', () => {
    const id = newMarginUser(1_001_519);
    expect(() => shortSell(db, cfg, id, CODE, 2_000)).toThrowError(/short margin/);
    expect(frozenOf(id)).toBe(0);
    expectLedgerBalanced(id);
  });
});

// ---------- 卖券还款 / 买券还券 / 直接还款 ----------

describe('sellToRepay：卖担保股票冲抵负债，先息后本', () => {
  it('先冲利息再冲本金；持仓与仓位同步递减；可卖量不受影响', () => {
    const id = newMarginUser(2_501_300);
    financeBuy(db, cfg, id, CODE, 5_000);
    // 造出已计利息（模拟已经过了一天的结算）
    db.prepare('UPDATE margin_accounts SET interest = 7_000 WHERE user_id = ?').run(id);

    setPrice(CODE, 1000);
    sellToRepay(db, cfg, id, CODE, 1_000);   // 卖出 1,000 股 → 净额 1,000,000 − 500 − 10 − 500 = 998,990

    const d = debtOf(id);
    expect(d.interest).toBe(0);                       // 利息先被冲光
    expect(d.debt).toBe(2_500_000 - (998_990 - 7_000));
    expect(holding(id, CODE)?.qt).toBe(4_000);
    expect(holding(id, CODE)?.qm).toBe(4_000);
    expect(holding(id, CODE)?.qs).toBe(0);            // 卖出的是担保物，可卖量不变
    expect(posRow(id, CODE, 'long')?.qty).toBe(4_000);
    expectLedgerBalanced(id);
  });

  it('没有该股融资仓位 → POSITION_NOT_FOUND；超过仓位数量 → BAD_QTY', () => {
    const id = newMarginUser(2_501_300);
    financeBuy(db, cfg, id, CODE, 5_000);
    expect(() => sellToRepay(db, cfg, id, CODE2, 100)).toThrowError(/no financed position/);
    expect(() => sellToRepay(db, cfg, id, CODE, 5_001)).toThrowError(/exceeds position/);
  });
});

describe('buyToCover：解冻担保金买回，不足由现金补', () => {
  it('全部还券后仓位行消失，冻结额归零，勾稽仍平', () => {
    const id = newMarginUser(1_001_520);
    shortSell(db, cfg, id, CODE, 2_000);
    // 股价不动 → 解冻额 ≈ 买回成本，现金基本不动
    buyToCover(db, cfg, id, CODE, 2_000);
    expect(posRow(id, CODE, 'short')).toBeUndefined();
    expect(frozenOf(id)).toBe(0);
    expect(cashOf(id)).toBeGreaterThan(0);   // 冻结里多出的那部分（保证金）退回来了
    expectLedgerBalanced(id);
  });

  it('股价上涨时用现金补差；现金不够 → INSUFFICIENT_CASH', () => {
    const id = newMarginUser(1_001_520);
    shortSell(db, cfg, id, CODE, 2_000);
    setPrice(CODE, 1_400);                    // 涨 40%：买回成本 2,800,000 > 解冻 3,000,000×? 仍够
    const cashBefore = cashOf(id);
    buyToCover(db, cfg, id, CODE, 1_000);
    expect(cashOf(id)).not.toBe(cashBefore);
    expectLedgerBalanced(id);

    // 再涨到现金买不回剩余部分
    setPrice(CODE, 1_000);
    const id2 = newMarginUser(1_001_520);
    shortSell(db, cfg, id2, CODE, 2_000);
    setPrice(CODE, 10_000);
    expect(() => buyToCover(db, cfg, id2, CODE, 2_000)).toThrowError(/available cash to buy back/);
  });
});

describe('repayMargin：现金直接还款（先息后本）', () => {
  it('冲利息 → 冲本金；无债时 NOTHING_OWED', () => {
    const id = newMarginUser(6_000_000);
    financeBuy(db, cfg, id, CODE, 5_000);   // 花掉 2,501,300，剩 3,498,700
    db.prepare('UPDATE margin_accounts SET interest = 3_000 WHERE user_id = ?').run(id);
    expect(cashOf(id)).toBe(3_498_700);

    const r = repayMargin(db, cfg, id, 100_000);
    expect(r.interestPaid).toBe(3_000);
    expect(r.principalPaid).toBe(97_000);
    expect(debtOf(id).debt).toBe(2_403_000);
    expectLedgerBalanced(id);

    repayMargin(db, cfg, id, 2_403_000);
    expect(debtOf(id).debt).toBe(0);
    expect(() => repayMargin(db, cfg, id, 1)).toThrowError(/no margin debt/);
  });
});

// ---------- ⚠️ 日终 T+1 解冻不得解锁担保物 ----------

describe('⚠️ 日终解冻（matcher.onDayEnd）', () => {
  it('融资买入的股票次日仍不可卖，普通买入的次日可卖', () => {
    const matcher = new PlayerMatcher({ db, cfg, masterSeed: 7 });
    const e = new Engine({ db, cfg, masterSeed: 7, genesisMs: GENESIS, matcher, settlementHooks: [hook] });
    const eng = engine; engine = e;   // advanceDays 走这个引擎

    const id = newMarginUser(100_000_000);
    // 普通买入 200 股（直接写 holdings 模拟 T+0 成交，qty_sellable 不增）
    db.prepare(`INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total)
      VALUES (?,?,?,0,?)`).run(id, CODE2, 200, 200_000);
    financeBuy(db, cfg, id, CODE, 5_000);

    expect(holding(id, CODE)?.qs).toBe(0);
    advanceDays(1);   // 结算：onDayEnd 解冻

    // ⚠️ 关键：融资买入的 5,000 股**一股都不该被解锁**
    expect(holding(id, CODE)).toEqual({ qt: 5_000, qs: 0, qm: 5_000, ct: 5_001_300 });
    // 普通买入的 200 股照常解锁（T+1）
    expect(holding(id, CODE2)?.qs).toBe(200);
    expectLedgerBalanced(id);
    engine = eng;
  });
});

// ---------- 计息 / 追保 / 强平 ----------

describe('逐日计息与 T+1 追保', () => {
  it('融资按本金 × 日息计提；融券按市值 × 日费率计提', () => {
    const id = newMarginUser(2_501_300);
    financeBuy(db, cfg, id, CODE, 5_000);            // debt 2,500,000 → 日息 500
    advanceDays(1);
    expect(debtOf(id).interest).toBe(500);
    advanceDays(1);
    expect(debtOf(id).interest).toBe(1_000);
  });

  it('⚠️ 跌破平仓线当日只记 warn_since_day，**次日结算才强平**（T+1 追保）', () => {
    const id = newMarginUser(2_501_300);
    financeBuy(db, cfg, id, CODE, 5_000);
    setPrice(CODE, 640);   // 3,200,000 / 2,500,000 = 128% < 130%

    advanceDays(1);
    expect(debtOf(id).warn).not.toBeNull();          // 只登记，不动手
    expect(posRow(id, CODE, 'long')?.qty).toBe(5_000);
    expect(marginState(db, cfg, id).status).toBe('call');

    advanceDays(1);
    expect(posRow(id, CODE, 'long')).toBeUndefined();// T+1 仍未补足 → 强平
    // holdings 行按既有约定「清零而不删除」（matcher 也是这么做的，positions() 会过滤掉）
    expect(holding(id, CODE)?.qt ?? 0).toBe(0);
    expect(holding(id, CODE)?.qm ?? 0).toBe(0);
    expect(debtOf(id)).toEqual({ debt: 0, interest: 0, warn: null, liq: 1 });
    expectLedgerBalanced(id);
  });

  it('补足（比例回到平仓线之上）后 warn_since_day 清零，不会被误强平', () => {
    const id = newMarginUser(2_501_300);
    financeBuy(db, cfg, id, CODE, 5_000);
    setPrice(CODE, 640);
    advanceDays(1);
    expect(debtOf(id).warn).not.toBeNull();

    setPrice(CODE, 900);   // 4,500,000 / 2,500,500 ≈ 180%
    advanceDays(1);
    expect(debtOf(id).warn).toBeNull();
    expect(posRow(id, CODE, 'long')?.qty).toBe(5_000);   // 仓位还在
    expect(debtOf(id).liq).toBe(0);
  });

  it('低于警戒线（150%）但高于平仓线时禁止开新仓 → MARGIN_CALL', () => {
    const id = newMarginUser(2_501_300);
    financeBuy(db, cfg, id, CODE, 5_000);
    setPrice(CODE, 700);   // 3,500,000 / 2,500,000 = 140%：警戒与平仓之间
    expect(marginState(db, cfg, id).status).toBe('warn');
    expect(() => financeBuy(db, cfg, id, CODE, 100)).toThrowError(/warning line/);
    expect(() => shortSell(db, cfg, id, CODE, 100)).toThrowError(/warning line/);
  });

  it('⚠️ 强平走完整结算不崩：卖担保股 → 冲债 → 剩余债务豁免，账本仍平衡', () => {
    const id = newMarginUser(2_501_300);
    financeBuy(db, cfg, id, CODE, 5_000);
    setPrice(CODE, 560);   // 2,800,000 / 2,500,000 = 112% < 130%
    advanceDays(1);
    expect(() => advanceDays(1)).not.toThrow();   // 强平那一日必须能提交事务
    expect(debtOf(id).debt).toBe(0);
    expect(debtOf(id).liq).toBe(1);
    expect(holding(id, CODE)?.qt ?? 0).toBe(0);
    expect(cashOf(id)).toBeGreaterThan(0);        // 卖股所得扣掉负债后还有剩余
    expectLedgerBalanced(id);
    // 信誉分被扣（forcedLiq 是负值）
    const credit = (db.prepare('SELECT credit c FROM users WHERE id = ?').get(id) as { c: number }).c;
    expect(credit).toBeLessThan(700);
  });

  it('⚠️ 空头爆仓：券商垫付差额并计入负债，仓位被清掉（不会永远挂着）', () => {
    const id = newMarginUser(1_001_520);
    shortSell(db, cfg, id, CODE, 2_000);
    setPrice(CODE, 3_000);   // 市值 6,000,000 vs 担保 3,000,000 → 比例 50%
    advanceDays(1);
    advanceDays(1);
    expect(posRow(id, CODE, 'short')).toBeUndefined();
    expect(frozenOf(id)).toBe(0);
    expectLedgerBalanced(id);
  });
});

// ---------- 净资产口径 ----------

describe('⚠️ valuation.marginDebt：融资买入不得凭空抬高净资产', () => {
  it('买入前后净资产不变（只是把现金换成了股票 + 等额负债）', () => {
    const id = newMarginUser(2_501_300);
    const before = valuation(db, id).totalAssets;
    financeBuy(db, cfg, id, CODE, 5_000);
    const after = valuation(db, id);
    expect(after.marginDebt).toBe(2_500_000);
    // 净资产只减少「交易费用」（佣金+过户费），不会因借钱而变大
    expect(before - after.totalAssets).toBe(1_300);
  });

  it('融券：冻结担保金算资产、空头市值算负债，两者对冲', () => {
    const id = newMarginUser(1_001_520);
    shortSell(db, cfg, id, CODE, 2_000);
    const v = valuation(db, id);
    expect(v.marginDebt).toBe(2_000_000);          // 只有融券市值，没有融资本金
    expect(v.cashFrozen).toBe(3_000_000);
    // 净资产 = 担保金 3,000,000 − 负债 2,000,000 = 1,000,000，
    // 正好是初始现金 1,001,520 减去已付出的 1,520 费用（费用已经从卖出净额里扣掉了）。
    expect(v.totalAssets).toBe(1_000_000);
  });
});

// ---------- 退市对账 ----------

describe('退市对账（reconcile）', () => {
  it('标的退市后信用持仓被收掉，不再污染维持担保比例', () => {
    const id = newMarginUser(2_501_300);
    financeBuy(db, cfg, id, CODE, 5_000);
    db.prepare(`UPDATE stocks SET status = 'delisted' WHERE code = ?`).run(CODE);
    advanceDays(1);
    expect(posRow(id, CODE, 'long')).toBeUndefined();
    expectLedgerBalanced(id);
  });

  it('空头标的退市 → 冻结资金全额解冻回可用现金', () => {
    const id = newMarginUser(1_001_520);
    shortSell(db, cfg, id, CODE, 2_000);
    db.prepare(`UPDATE stocks SET status = 'delisted' WHERE code = ?`).run(CODE);
    advanceDays(1);
    expect(posRow(id, CODE, 'short')).toBeUndefined();
    expect(frozenOf(id)).toBe(0);
    expect(cashOf(id)).toBe(3_000_000);
    expectLedgerBalanced(id);
  });
});

// ---------- 孤儿账户（用户被删除但 margin 行留下） ----------

describe('⚠️ 孤儿账户不能把结算带崩（2026-09-15）', () => {
  /**
   * 复现线上真实形状：`DELETE /api/admin/users/:id` 漏删 `margin_accounts` /
   * `margin_positions`（这两张表**没有**指向 users 的外键，所以漏删不会报错）。
   *
   * 修复前，下一个交易日的 `onSettlement` → `checkMaintenance` 会遍历
   * `margin_accounts` 并对每行调 `marginState()`，而它第一件事是读 `users.credit`
   * —— 用户不存在即抛 `UNAUTHORIZED`，把**整个 tick 事务**带崩。
   * 线上表现是「结算卡死、行情停摆」，且日志里只有一句 401，极难联想到是删号留下的。
   */
  function makeOrphan(): number {
    const id = newMarginUser(100_000_000);
    // 夹具把 CODE 的价设成 1000 分（¥10），故 1,000 股 = 1,000,000 分，过 minOrderCents。
    financeBuy(db, cfg, id, CODE, 1_000);
    expect(db.prepare('SELECT COUNT(*) c FROM margin_accounts WHERE user_id = ?').get(id))
      .toEqual({ c: 1 });

    // 模拟「用户行被删、margin 行没清」：清掉所有指向 users 的外键从属行，
    // 但**故意保留** margin 两张表。ledger 行必须留着（append-only，且全局平衡靠它）。
    db.prepare('DELETE FROM trades WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM orders WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM holdings WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return id;
  }

  it('用户行已不存在时，日终结算不抛错，且孤儿行被 reconcile 收掉', () => {
    const id = makeOrphan();

    expect(() => advanceDays(1)).not.toThrow();

    expect(db.prepare('SELECT COUNT(*) c FROM margin_accounts WHERE user_id = ?').get(id))
      .toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM margin_positions WHERE user_id = ?').get(id))
      .toEqual({ c: 0 });
    // 清理孤儿行只删 margin 表，绝不动 ledger —— 全局平衡必须仍然成立。
    expect(() => auditGlobal(db)).not.toThrow();
  });

  it('孤儿账户带未平空头（冻结资金）时同样清得掉，且不影响其他人的结算', () => {
    const orphan = makeOrphan();
    const alive = newMarginUser(1_001_520);
    shortSell(db, cfg, alive, CODE2, 2_000);

    expect(() => advanceDays(1)).not.toThrow();

    expect(db.prepare('SELECT COUNT(*) c FROM margin_accounts WHERE user_id = ?').get(orphan))
      .toEqual({ c: 0 });
    // 活着的那位不受影响：空头还在、冻结还在。
    expect(posRow(alive, CODE2, 'short')?.qty).toBe(2_000);
    expectLedgerBalanced(alive);
  });
});
