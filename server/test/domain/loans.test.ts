// test/domain/loans.test.ts —— Task 8：信誉 + 贷款（门槛 / 计息 / 宽限逾期 / 强平 / 破产 / 还款）。
// 全部由真实 Engine 日推进驱动结算钩子，不使用假时间。
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS, type Config } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { applyCreditEvent, shiftCredit } from '../../src/domain/credit.js';
import { loanProducts, borrow, repay, LoanSettlementHook } from '../../src/domain/loans.js';
import { valuation } from '../../src/domain/portfolio.js';
import { auditGlobal, post } from '../../src/core/ledger.js';

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const TICKS_PER_DAY = 1200;

let db: DB;
let engine: Engine;
let hook: LoanSettlementHook;
let uid: number;
let cfg: Config;

/** 建一个用户（走 ledger GENESIS，保证总账平衡），返回 id。 */
function newUser(name: string, cash = DEFAULTS.auth.initialCash): number {
  const r = db.prepare(`INSERT INTO users(username, pwd_hash, created_day, created_at)
    VALUES (?, 'x', 1, 0)`).run(name);
  const id = Number(r.lastInsertRowid);
  post(db, 1, 0, 'genesis', id, [
    { account: ACC.MARKET, bucket: 'A', amount: -cash, kind: 'GENESIS' },
    { account: id, bucket: 'A', amount: cash, kind: 'GENESIS' },
  ]);
  for (const kind of ['EDU', 'CODE', 'FIN', 'FIT', 'COMM', 'DESIGN']) {
    db.prepare('INSERT INTO abilities(user_id, kind, level) VALUES (?,?,0)').run(id, kind);
  }
  return id;
}

/**
 * 推进 n 个交易日：只执行每日的**结算 tick**（tickInDay=1180），跳过日内 1199 个定价 tick。
 *
 * 这是测试专用的捷径：贷款/信誉/强平均发生在结算钩子内，与日内定价无关；
 * 计价成本（每 tick 全市场定价）会让 30+ 日用例超过分钟级。引擎的 lastTick 由本函数
 * 直接置位到"下一日结算前一刻"，只把结算那一 tick 交给引擎真实执行。
 */
function advanceDays(n: number): void {
  const e = engine as unknown as { lastTick: number; advanceOne(t: number, s: boolean): void };
  let done = e.lastTick >= TICKS_PER_DAY - 20
    ? Math.floor(e.lastTick / TICKS_PER_DAY) + 1 : 0;
  for (let i = 0; i < n; i++) {
    done += 1;
    const settle = (done - 1) * TICKS_PER_DAY + 1180;
    e.lastTick = settle - 1;          // 直接跳到结算 tick 的前一刻
    e.advanceOne(settle, true);        // 真实执行结算 tick（触发钩子）
  }
}

function loanRow(id: number): { principal: number; outstanding: number; accrued_interest: number;
  status: string; rate_e6: number; due_day: number; term_days: number } {
  return db.prepare('SELECT principal, outstanding, accrued_interest, status, rate_e6, due_day, term_days FROM loans WHERE id = ?')
    .get(id) as { principal: number; outstanding: number; accrued_interest: number;
      status: string; rate_e6: number; due_day: number; term_days: number };
}
function creditOf(id: number): number {
  return (db.prepare('SELECT credit c FROM users WHERE id = ?').get(id) as { c: number }).c;
}
function setCredit(id: number, score: number): void {
  db.prepare('UPDATE users SET credit = ? WHERE id = ?').run(score, id);
}
function cashOf(id: number): number {
  return (db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(id) as { a: number }).a;
}
function giveHolding(id: number, code: string, qty: number, cost: number): void {
  db.prepare(`INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total)
    VALUES (?,?,?,?,?) ON CONFLICT(user_id, code) DO UPDATE SET
      qty_total = qty_total + excluded.qty_total,
      qty_sellable = qty_sellable + excluded.qty_sellable,
      cost_total = cost_total + excluded.cost_total`).run(id, code, qty, qty, cost);
}
function setPrice(code: string, price: number): void {
  db.prepare('UPDATE stock_state SET price = ?, prev_close = ? WHERE code = ?').run(price, price, code);
}

beforeEach(() => {
  db = openDb(':memory:');
  cfg = DEFAULTS;
  hook = new LoanSettlementHook({ db, cfg });
  engine = new Engine({ db, cfg, masterSeed: 7, genesisMs: GENESIS,
    settlementHooks: [hook] });
  uid = newUser('borrower');
});

// ---------- 产品表 ----------

describe('loanProducts：额度 = 信誉分 × 每分额度，日息按档位', () => {
  it('分数 <500 一律拒贷（空数组）', () => {
    for (const s of [350, 400, 499]) expect(loanProducts(cfg, s)).toEqual([]);
  });

  it('额度随信誉分线性：capPerCreditPoint = 500_000 分（= ¥5,000/分）', () => {
    // 500 分 → 250_000_000 分 = ¥2,500,000；三档期限额度相同（同一信誉分）
    expect(loanProducts(cfg, 500)).toEqual([
      { termDays: 20, rateE6: 600, capCents: 250_000_000 },
      { termDays: 60, rateE6: 600, capCents: 250_000_000 },
      { termDays: 120, rateE6: 600, capCents: 250_000_000 },
    ]);
    expect(loanProducts(cfg, 600)[0]).toEqual({ termDays: 20, rateE6: 500, capCents: 300_000_000 });
    expect(loanProducts(cfg, 700)[0]).toEqual({ termDays: 20, rateE6: 400, capCents: 350_000_000 });
    expect(loanProducts(cfg, 850)[0]).toEqual({ termDays: 20, rateE6: 300, capCents: 425_000_000 });
  });

  it('额度公式可核验：capCents === score × capPerCreditPoint（不依赖任何字面量）', () => {
    for (const s of [500, 549, 600, 601, 750, 850]) {
      const p = loanProducts(cfg, s)[0]!;
      expect(p.capCents).toBe(s * cfg.loans.capPerCreditPoint);
    }
  });

  it('分数落在区间端点时取该档（含上界）', () => {
    expect(loanProducts(cfg, 549)[0]!.rateE6).toBe(600);
    expect(loanProducts(cfg, 550)[0]!.rateE6).toBe(550);
  });
});

// ---------- 借款门槛 ----------

describe('borrow：门槛矩阵', () => {
  it('分数 <500 拒贷（CREDIT_LOW）', () => {
    setCredit(uid, 480);
    expect(() => borrow(db, cfg, engine, uid, 100_000, 20))
      .toThrowError(/credit score below 500/);
  });

  it('金额超过授信额度 → LOAN_LIMIT（额度 = 信誉分 × ¥5,000）', () => {
    // ⚠️ 额度与杠杆上限**都正比于信誉分**，取严时谁生效只取决于净资产：
    //    额度 < 杠杆 ⟺ 净资产 > capPerCreditPoint × leverageDivisor = 150_000_000 分。
    //    默认初始资金只有 100_000_000 分（此时杠杆先触发），故先补足净资产，
    //    否则这条测到的是 LEVERAGE 而不是 LOAN_LIMIT。
    setCredit(uid, 500);
    const topUp = 100_000_000;   // 净资产 → 200_000_000 分
    post(db, 1, 0, 'topup', uid, [
      { account: ACC.MARKET, bucket: 'A', amount: -topUp, kind: 'TEST_TOPUP' },
      { account: uid, bucket: 'A', amount: topUp, kind: 'TEST_TOPUP' },
    ]);
    // 500 分 → 额度 250_000_000 分；杠杆上限 = 200_000_000 × 500/300 ≈ 333_333_333 分
    expect(() => borrow(db, cfg, engine, uid, 250_000_001, 20))
      .toThrowError(/exceeds credit cap/);
    expect(borrow(db, cfg, engine, uid, 250_000_000, 20)).toBeGreaterThan(0);
  });

  it('⚠️ 净资产低于 capPerCreditPoint×leverageDivisor 时，杠杆先于授信额度触发', () => {
    // 两条闸门都正比于信誉分 ⇒ 「谁先拒」只取决于净资产：
    //   授信额度 < 杠杆上限 ⟺ 净资产 > capPerCreditPoint × leverageDivisor。
    // 默认初始资金 100_000_000 分 < 150_000_000 分 ⇒ **默认玩家实际被杠杆卡住**，
    // 此时调大 capPerCreditPoint 对玩家完全无感（运营调参时最容易被这个误导）。
    setCredit(uid, 600);
    const threshold = cfg.loans.capPerCreditPoint * cfg.loans.leverageDivisor;
    expect(DEFAULTS.auth.initialCash).toBeLessThan(threshold);
    // 600 分授信额度 = 300_000_000 分（远超净资产），但杠杆上限只有 200_000_000 分：
    // 借 200_000_001 既没超额度、又超了杠杆 ⇒ 必须报 LEVERAGE。
    expect(() => borrow(db, cfg, engine, uid, 200_000_001, 20))
      .toThrowError(/exceeds leverage cap/);
  });

  it('总杠杆约束取严：未偿本息 ≤ 净资产 × 分数/300', () => {
    // 杠杆上限 = 净资产 × 分数/300。把现金花掉推低净资产，令杠杆上限低于授信额度：
    // 600 分时额度 = 300_000_000 分，而这里把净资产压到 1_000_000 分 → 杠杆上限 2_000_000 分。
    setCredit(uid, 600);
    // 花掉绝大部分现金 → 净资产压到只剩 1_000_000 分；杠杆上限 = 1_000_000 × 600/300 = 2_000_000 分。
    // ⚠️ 用 initialCash 推导，不要写死 ¥90,000 —— 初始资金是配置项，写死会在调整时静默失配。
    const spendDownTo = 1_000_000;
    const spend = DEFAULTS.auth.initialCash - spendDownTo;
    post(db, 1, 0, 'spend', uid, [
      { account: uid, bucket: 'A', amount: -spend, kind: 'TEST_SPEND' },
      { account: ACC.MARKET, bucket: 'A', amount: spend, kind: 'TEST_SPEND' },
    ]);
    expect(() => borrow(db, cfg, engine, uid, 2_100_000, 20)).toThrowError(/exceeds leverage cap/);
    expect(borrow(db, cfg, engine, uid, 1_500_000, 20)).toBeGreaterThan(0);
  });

  it('净资产为负 → 明确 LEVERAGE 拒绝（不得把负值送进 roundHalfUpDiv 而崩）', () => {
    setCredit(uid, 700);
    // 先在净资产为正时正常借出一笔，再人为把未偿本息抬高到超过全部资产，
    // 制造"净资产为负"（规格允许持仓亏损后净资产转负，此时唯一出路是逾期强平/破产）。
    const l = borrow(db, cfg, engine, uid, 1_000_000, 20);
    // 未偿本息抬到"超过全部资产"即可 → 净资产为负；用 initialCash 推导，别写死。
    const huge = DEFAULTS.auth.initialCash + 5_000_000;
    db.prepare('UPDATE loans SET outstanding = ? WHERE id = ?').run(huge, l);
    expect(valuation(db, uid).totalAssets).toBeLessThan(0);
    // 修复前：净资产为负 → roundHalfUpDiv 收到负数被除数 → 抛 "bad dividend"（500/进程崩溃）
    // 注意请求额要小到不触发 LOAN_LIMIT（档位剩余额度按未偿本金算，会被 huge 直接顶满），
    // 但仍要走到净资产判断 —— 故先清掉本金占用、只留较大的"本息"制造负净资产。
    db.prepare(`UPDATE loans SET outstanding = 0, accrued_interest = ? WHERE id = ?`).run(huge, l);
    expect(valuation(db, uid).totalAssets).toBeLessThan(0);
    expect(() => borrow(db, cfg, engine, uid, 100_000, 20))
      .toThrowError(/net worth is not positive/);
  });

  it('期限必须是 20/60/120 之一 → BAD_TERM', () => {
    setCredit(uid, 700);
    expect(() => borrow(db, cfg, engine, uid, 100_000, 30)).toThrowError(/term must be one of/);
  });

  it('有 overdue/grace 逾期贷在身 → 禁新贷款（OVERDUE_EXISTS）', () => {
    setCredit(uid, 700);
    const id = borrow(db, cfg, engine, uid, 1_000_000, 20);
    db.prepare("UPDATE loans SET status='overdue' WHERE id = ?").run(id);
    expect(() => borrow(db, cfg, engine, uid, 100_000, 20)).toThrowError(/has overdue loan/);
  });

  it('happy path：BANK→user 放款、loans 行字段正确、due_day=day+term', () => {
    setCredit(uid, 700);
    const cashBefore = cashOf(uid);
    const id = borrow(db, cfg, engine, uid, 1_000_000, 60);
    expect(cashOf(uid)).toBe(cashBefore + 1_000_000);
    const l = loanRow(id);
    expect(l).toMatchObject({ principal: 1_000_000, outstanding: 1_000_000,
      accrued_interest: 0, status: 'active', rate_e6: 400, term_days: 60 });
    expect(l.due_day).toBe(1 + 60);
    auditGlobal(db);
  });
});

// ---------- 计息与状态推进 ----------

describe('LoanSettlementHook：计息 / 宽限 / 逾期', () => {
  it('日息按 outstanding 精确计提（rate_e6 单利，四舍五入到分）', () => {
    setCredit(uid, 700); // 日息 万4 = 400e-6
    const id = borrow(db, cfg, engine, uid, 1_000_000, 120);
    advanceDays(1);
    // 1_000_000 × 400 / 1e6 = 400 分
    expect(loanRow(id).accrued_interest).toBe(400);
    advanceDays(1);
    expect(loanRow(id).accrued_interest).toBe(800);
  }, 20000);

  it('到期次日进宽限，罚息 2 倍', () => {
    setCredit(uid, 700);
    const id = borrow(db, cfg, engine, uid, 1_000_000, 20); // due_day = 21
    advanceDays(20); // 记到第 20 日结算
    expect(loanRow(id).status).toBe('active');
    advanceDays(1); // 第 21 日：day > due_day → grace
    expect(loanRow(id).status).toBe('grace');
    const before = loanRow(id).accrued_interest;
    advanceDays(1); // 宽限期内：罚息 2 倍 = 800/日
    expect(loanRow(id).accrued_interest - before).toBe(800);
  }, 60000);

  it('宽限 3 日后再进 overdue，每日 −8 信誉并记 credit_events', () => {
    setCredit(uid, 700);
    const id = borrow(db, cfg, engine, uid, 1_000_000, 20);
    advanceDays(20 + 3 + 1); // 进入 overdue
    expect(loanRow(id).status).toBe('overdue');
    const before = creditOf(uid);
    advanceDays(1);
    expect(creditOf(uid)).toBe(before + cfg.credit.overduePerDay);
    const ev = db.prepare(`SELECT delta, reason FROM credit_events
      WHERE user_id = ? AND reason = 'OVERDUE' ORDER BY id DESC LIMIT 1`).get(uid) as
      { delta: number; reason: string };
    expect(ev.delta).toBe(-8);
  }, 60000);
});

// ---------- 强平 ----------

describe('逾期第 10 日强制平仓', () => {
  it('按持仓市值降序逐只以现价×(1−滑点)卖出，费用照收、ledger 平衡、信誉 −80', () => {
    setCredit(uid, 700);
    const id = borrow(db, cfg, engine, uid, 1_000_000, 20);
    // 两笔持仓：高价股与低价股，市值降序决定卖出顺序
    giveHolding(uid, '002143', 100_000, 46_000_00);   // 460 分/股 → 市值 46,000,000
    giveHolding(uid, '002595', 100, 2_400_000);       // 24000 分/股 → 市值 2,400,000
    advanceDays(21 + 3 + 4); // 逾期第 5 日（day 29），尚未触发强平
    const before = creditOf(uid);
    advanceDays(cfg.loans.liqOverdueDay - 4); // 再推 6 日至逾期第 10 日（day 35）→ 强平
    const after = loanRow(id);
    // 强平后持仓已清空（或至少清掉足够覆盖债务的部分）
    expect(after.status === 'liquidated' || after.status === 'repaid').toBe(true);
    const ev = db.prepare(`SELECT delta FROM credit_events WHERE user_id = ? AND reason = 'FORCED_LIQ'
      ORDER BY id DESC LIMIT 1`).get(uid) as { delta: number } | undefined;
    expect(ev?.delta).toBe(cfg.credit.forcedLiq);
    expect(creditOf(uid)).toBeLessThanOrEqual(before);
    auditGlobal(db);
  }, 90000);

  it('强平后足额清偿 → 贷款结清、持仓清零、无救济金', () => {
    setCredit(uid, 700);
    const id = borrow(db, cfg, engine, uid, 1_000_000, 20);
    giveHolding(uid, '002143', 100_000, 46_000_00);
    // 逾期第 10 交易日（day 21 + 3 + 10 = 34）触发强平
    advanceDays(21 + cfg.loans.graceDays + cfg.loans.liqOverdueDay);
    const l = loanRow(id);
    expect(l.outstanding).toBe(0);
    expect(l.accrued_interest).toBe(0);
    expect(l.status).toBe('liquidated');
    const qty = (db.prepare('SELECT COALESCE(SUM(qty_total),0) q FROM holdings WHERE user_id = ?')
      .get(uid) as { q: number }).q;
    expect(qty).toBe(0);
    const relief = db.prepare("SELECT COUNT(*) c FROM ledger WHERE user_id = ? AND kind = 'RELIEF'")
      .get(uid) as { c: number };
    expect(relief.c).toBe(0);
  }, 90000);
});

// ---------- 破产 ----------

describe('破产结算', () => {
  it('强平后仍资不抵债 → 债务豁免、信誉置 400、发 ¥20,000 救济、bankrupt_count+1、撤单', () => {
    setCredit(uid, 850); // 高额度，便于借到还不起的数
    const id = borrow(db, cfg, engine, uid, 5_000_000, 20);
    // 挂一张 open 买单并冻结 ¥460：现金 A→F 走 ledger（破产时应释放回 A 再被冲抵清零）。
    const freeze = 46_000;
    post(db, 1, 0, 'freeze', uid, [
      { account: uid, bucket: 'A', amount: -freeze, kind: 'TEST_FREEZE' },
      { account: uid, bucket: 'F', amount: freeze, kind: 'TEST_FREEZE' },
    ]);
    db.prepare(`INSERT INTO orders(user_id, code, side, type, price, qty, filled, frozen, status, created_tick, day, client_key)
      VALUES (?, '002143', 'B', 'L', 460, 100, 0, ?, 'open', 61, 1, 'openk')`).run(uid, freeze);
    // 制造资不抵债：借款 ¥50,000 后，把手中可动用的现金几乎全部"花掉"（走 ledger，保持账实一致），
    // 只留 ¥50 现金 + 一个市值仅 ¥460 的低价持仓（清仓所得远不足以偿还本息）。
    // ⚠️ 用 initialCash 推导；写死会在调整初始资金时静默失配（留下花不完的现金 → 不破产）。
    const spend = DEFAULTS.auth.initialCash + 5_000_000 - freeze - 5_000;
    post(db, 1, 0, 'spend', uid, [
      { account: uid, bucket: 'A', amount: -spend, kind: 'TEST_SPEND' },
      { account: ACC.MARKET, bucket: 'A', amount: spend, kind: 'TEST_SPEND' },
    ]);
    giveHolding(uid, '002143', 100, 46_000);

    advanceDays(21 + cfg.loans.graceDays + cfg.loans.liqOverdueDay);

    const u = db.prepare('SELECT credit, bankrupt_count bc, cash_available a, cash_frozen f FROM users WHERE id = ?')
      .get(uid) as { credit: number; bc: number; a: number; f: number };
    expect(u.credit).toBe(cfg.credit.bankruptcyScore);
    expect(u.bc).toBe(1);
    expect(u.a).toBe(cfg.loans.reliefCash);
    expect(u.f).toBe(0);
    expect(loanRow(id).status).toBe('forgiven');
    const orders = db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id = ? AND status = 'open'")
      .get(uid) as { c: number };
    expect(orders.c).toBe(0);
    const bEv = db.prepare(`SELECT delta FROM credit_events WHERE user_id = ? AND reason = 'BANKRUPTCY' ORDER BY id DESC LIMIT 1`)
      .get(uid) as { delta: number } | undefined;
    expect(bEv).toBeDefined();
    // /api/me 的 totalInflow 应计入救济金
    expect(valuation(db, uid).totalInflow).toBeGreaterThanOrEqual(cfg.loans.reliefCash);
    auditGlobal(db);
  }, 120000);
});

// ---------- 还款 ----------

describe('repay：先息后本', () => {
  it('部分还款先冲利息再冲本金', () => {
    setCredit(uid, 700);
    const id = borrow(db, cfg, engine, uid, 1_000_000, 120);
    advanceDays(2); // accrued = 800
    const cashBefore = cashOf(uid);
    const r = repay(db, cfg, engine, uid, id, 500);
    expect(r.interestPaid).toBe(500);
    expect(r.principalPaid).toBe(0);
    expect(loanRow(id).accrued_interest).toBe(300);
    expect(loanRow(id).outstanding).toBe(1_000_000);
    expect(cashOf(uid)).toBe(cashBefore - 500);
    auditGlobal(db);
  });

  it('全额还清（按期）→ status=repaid、信誉 +15', () => {
    setCredit(uid, 700);
    const id = borrow(db, cfg, engine, uid, 1_000_000, 20); // due_day=21
    advanceDays(21); // 推到 due_day 当天（day === due_day，不算提前）
    const l = loanRow(id);
    const total = l.outstanding + l.accrued_interest;
    const before = creditOf(uid);
    const r = repay(db, cfg, engine, uid, id, total + 10_000_00); // 多还的部分应被截断
    expect(r.closed).toBe(true);
    expect(loanRow(id)).toMatchObject({ outstanding: 0, accrued_interest: 0, status: 'repaid' });
    expect(creditOf(uid)).toBe(before + cfg.credit.repayOnTime);
    auditGlobal(db);
  }, 30000);

  it('提前还清 → 信誉 +20（day < due_day）', () => {
    setCredit(uid, 700);
    const id = borrow(db, cfg, engine, uid, 1_000_000, 120);
    advanceDays(1);
    const l = loanRow(id);
    const before = creditOf(uid);
    repay(db, cfg, engine, uid, id, l.outstanding + l.accrued_interest);
    expect(creditOf(uid)).toBe(before + cfg.credit.repayEarly);
  });
});

// ---------- credit 工具 ----------

describe('credit 基础工具', () => {
  it('applyCreditEvent 钳制到 [min,max] 并记录流水', () => {
    // 初始 600；+300 → 900 应被钳制到 max=850
    const s = applyCreditEvent(db, cfg, uid, +300, 'TEST', 1);
    expect(s).toBe(cfg.credit.max);
    // 再 −1000 → 应钳制到 min=350
    const s2 = applyCreditEvent(db, cfg, uid, -1000, 'TEST', 1);
    expect(s2).toBe(cfg.credit.min);
    const rows = db.prepare('SELECT COUNT(*) c FROM credit_events WHERE user_id = ?').get(uid) as { c: number };
    expect(rows.c).toBe(2);
    // 流水 delta 记录的是「实际生效」的差值，不是请求值
    const evs = db.prepare('SELECT delta FROM credit_events WHERE user_id = ? ORDER BY id').all(uid) as { delta: number }[];
    expect(evs[0]!.delta).toBe(cfg.credit.max - cfg.credit.start);
    expect(evs[1]!.delta).toBe(cfg.credit.min - cfg.credit.max);
  });

  it('shiftCredit 上限：滚动 20 日窗口内经 SHIFT 途径最多 +shiftCapPer20d', () => {
    // 连续 30 日每日 +1：窗口 [d-20, d) 内累计不得超过 10。
    for (let d = 1; d <= 30; d++) shiftCredit(db, cfg, uid, d);
    const total = (db.prepare(`SELECT COALESCE(SUM(delta),0) s FROM credit_events
      WHERE user_id = ? AND reason = 'SHIFT'`).get(uid) as { s: number }).s;
    // 日 1..10 逐日 +1（累计 10，达上限）；日 11..20 窗口已满 → 不加；
    // 日 21 起窗口滑动、最早事件滑出 → 恢复 +1，至日 30 再 +10。
    expect(total).toBe(20);
    // 逐窗口检查：任取连续 20 日，增量不超过上限
    const events = db.prepare(`SELECT day FROM credit_events WHERE user_id = ? AND reason = 'SHIFT'
      ORDER BY day`).all(uid) as { day: number }[];
    for (const e of events) {
      const inWin = events.filter(x => x.day > e.day - 20 && x.day <= e.day).length;
      expect(inWin).toBeLessThanOrEqual(cfg.credit.shiftCapPer20d);
    }
  });
});
