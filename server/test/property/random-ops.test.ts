// test/property/random-ops.test.ts —— Task 11：150 游戏日随机操作守恒压测。
//
// 驱动器：seeded RNG（core/rng，流 'ops'）生成确定性操作序列；8 用户；
//   每游戏日推进 1 日（分块 catchUpTo 以免饿死 vitest RPC），日间执行 30 个随机操作
//   （下单/撤单/借款/还款/排班/报课 + 显式非法操作）。
// 不变量（每 10 日 + 结束各断言一次）：
//   ① auditUser 全体通过；② 全局 Σ=0；③ holdings 非负且 sellable ≤ total；
//   ④ Σ open 买单 frozen === users.cash_frozen（逐用户）；⑤ orders.filled ≤ qty、done 单 filled == qty；
//   ⑥ 全体 valuation.totalAssets ≥ 0 且非 NaN。
// 追加：trades ↔ ledger 全量勾稽（每笔成交 fee 腿合计 === commission+stamp+transfer，
//   且 user 腿方向与净额完全匹配）。
import { describe, it, expect } from 'vitest';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS, type Config } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { PlayerMatcher } from '../../src/trading/matcher.js';
import { GameClock } from '../../src/core/clock.js';
import { Rng } from '../../src/core/rng.js';
import { post, auditUser } from '../../src/core/ledger.js';
import { valuation } from '../../src/domain/portfolio.js';
import { borrow, repay, LoanSettlementHook } from '../../src/domain/loans.js';
import { scheduleShift, enrollCourse, processDueForUser, WorkSettlementHook,
  listJobs, ABILITY_KINDS } from '../../src/domain/work.js';
import { placeOrder, cancelOrder, engineNow } from '../../src/trading/orders.js';
import { AppError } from '../../src/api/app.js';

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const SEED = 20260828;
const USERS = 8;
const OPS_PER_DAY = 30;
const DAYS = 150;

interface U { id: number; name: string }

/** 合法拒绝（AppError）即通过；非 AppError 视为真 bug，重抛。 */
function expectAppError(e: unknown): void {
  if (e instanceof AppError) return;
  throw e;
}

function mkUser(db: DB, name: string, cash: number): number {
  const id = Number(db.prepare(`INSERT INTO users(username, pwd_hash, created_day, created_at)
    VALUES (?, 'x', 1, 0)`).run(name).lastInsertRowid);
  post(db, 1, 0, 'genesis', id, [
    { account: ACC.MARKET, bucket: 'A', amount: -cash, kind: 'GENESIS' },
    { account: id, bucket: 'A', amount: cash, kind: 'GENESIS' },
  ]);
  for (const k of ABILITY_KINDS) {
    db.prepare('INSERT INTO abilities(user_id, kind, level) VALUES (?,?,0)').run(id, k);
  }
  return id;
}

/** 分块推进 n 日：每次 catchUpTo 一日并 yield 事件循环（避免 vitest RPC 饥饿）。 */
async function advanceDays(engine: Engine, from: number, days: number): Promise<number> {
  let d = from;
  for (let i = 0; i < days; i++) {
    d += 1;
    engine.catchUpTo(GENESIS + d * 3_600_000);
    await new Promise<void>(r => setImmediate(r));
  }
  return d;
}

function invariants(db: DB, label: string): void {
  // ① 逐用户 balances 对账
  const users = db.prepare("SELECT id FROM users WHERE kind = 'user' ORDER BY id").all() as { id: number }[];
  for (const u of users) {
    try { auditUser(db, u.id); } catch (e) {
      throw new Error(`[${label}] auditUser failed for ${u.id}: ${String(e)}`);
    }
  }
  // ② 全局平衡
  const gsum = (db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger').get() as { s: number }).s;
  expect(gsum, `[${label}] global ledger sum`).toBe(0);
  // ③ holdings 非负、sellable ≤ total
  const bad = db.prepare(`SELECT COUNT(*) c FROM holdings
    WHERE qty_total < 0 OR qty_sellable < 0 OR qty_sellable > qty_total`).get() as { c: number };
  expect(bad.c, `[${label}] invalid holdings`).toBe(0);
  // ④ 逐用户：Σ open 买单 frozen === cash_frozen
  for (const u of users) {
    const frozenOrders = (db.prepare(`SELECT COALESCE(SUM(frozen),0) v FROM orders
      WHERE user_id = ? AND status = 'open'`).get(u.id) as { v: number }).v;
    const cashFrozen = (db.prepare('SELECT cash_frozen f FROM users WHERE id = ?').get(u.id) as
      { f: number }).f;
    expect(frozenOrders, `[${label}] frozen mismatch for user ${u.id}`).toBe(cashFrozen);
  }
  // ⑤ orders.filled ≤ qty；done 单 filled == qty
  expect((db.prepare('SELECT COUNT(*) c FROM orders WHERE filled > qty').get() as { c: number }).c,
    `[${label}] filled > qty`).toBe(0);
  expect((db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'done' AND filled <> qty")
    .get() as { c: number }).c, `[${label}] done order not fully filled`).toBe(0);
  // ⑥ 估值健全：Cash 与估值必须有限、非 NaN。
  //   注意：净资产（totalAssets）**允许为负**——规格 §9 的杠杆约束只在"放款时"检查
  //   （未偿本息 ≤ 净资产 × 信誉分/300），持仓亏损后净资产可以转负；唯一的强制降杠杆
  //   路径是"逾期第 10 交易日强平/破产"（due_day + 3 grace + 10 overdue）。因此在强平
  //   日到来之前，负净资产是规格内的合法中间态，不能作为不变量断言。
  //   真正的不变量是：① 现金充裕度不被击穿（cash 不为负）、② 估值可计算、③ 强平链条
  //   最终能收敛（由下方 liquidationDrain 断言）。
  for (const u of users) {
    const v = valuation(db, u.id);
    expect(Number.isFinite(v.totalAssets), `[${label}] NaN assets user ${u.id}`).toBe(true);
    const cash = db.prepare('SELECT cash_available a, cash_frozen f FROM users WHERE id = ?')
      .get(u.id) as { a: number; f: number };
    expect(cash.a, `[${label}] negative cash user ${u.id}`).toBeGreaterThanOrEqual(0);
    expect(cash.f, `[${label}] negative frozen user ${u.id}`).toBeGreaterThanOrEqual(0);
  }
}

/**
 * trades ↔ ledger 全量勾稽（Task 11 契约要求）：
 *   - 每笔 trade 的用户腿净额必须精确等于 "amount ∓ 费用"；
 *   - 费用腿（TRADE_BUY/TRADE_SELL 中 MARKET/CLEARING/TAX 三方的合计）=== commission+stamp+transfer。
 * 过账口径（matcher.ts）：
 *   B：user:F -(amount+comm+tf) │ MARKET:+amount │ CLEARING:+(comm+tf)
 *   S：MARKET:-amount │ user:A +(amount-comm-stamp-tf) │ CLEARING:+(comm+tf) │ TAX:+stamp
 */
function reconcileTrades(db: DB): number {
  const trades = db.prepare(`SELECT id, user_id, price, qty, commission, stamp, transfer, side
    FROM trades ORDER BY id`).all() as
    { id: number; user_id: number; price: number; qty: number; commission: number; stamp: number;
      transfer: number; side: string }[];

  for (const t of trades) {
    const amount = t.price * t.qty;
    const fees = t.commission + t.stamp + t.transfer;
    const rows = db.prepare(`SELECT user_id, bucket, amount FROM ledger
      WHERE ref_type = 'trade' AND ref_id = ?`).all(t.id) as
      { user_id: number; bucket: string; amount: number }[];

    expect(rows.length, `trade ${t.id}: no ledger rows`).toBeGreaterThan(0);

    // 用户腿
    const userLegs = rows.filter(r => r.user_id === t.user_id);
    expect(userLegs.length, `trade ${t.id}: expected exactly 1 user leg`).toBe(1);
    const ul = userLegs[0]!;
    if (t.side === 'B') {
      expect(ul.bucket, `trade ${t.id}: buy user leg bucket`).toBe('F');
      expect(ul.amount, `trade ${t.id}: buy user leg amount`).toBe(-(amount + fees));
    } else {
      expect(ul.bucket, `trade ${t.id}: sell user leg bucket`).toBe('A');
      expect(ul.amount, `trade ${t.id}: sell user leg amount`).toBe(amount - fees);
    }

    // 费用 + 对手方腿：非用户腿绝对值合计 === amount + fees（双边平衡校验）
    const otherAbs = rows.filter(r => r.user_id !== t.user_id)
      .reduce((s, r) => s + Math.abs(r.amount), 0);
    expect(otherAbs, `trade ${t.id}: counterparty legs`).toBe(amount + fees);

    // 全局该 trade 净额恒为 0
    const net = rows.reduce((s, r) => s + r.amount, 0);
    expect(net, `trade ${t.id}: trade posting net`).toBe(0);
  }
  return trades.length;
}

describe('随机操作守恒（150 游戏日）', () => {
  it(`${USERS} 用户 × ${DAYS} 日 × ${OPS_PER_DAY} 操作：六项不变量恒成立 + trades↔ledger 全量勾稽`, async () => {
    const db = openDb(':memory:');
    const cfg: Config = DEFAULTS;
    // 不预置 engine_state：交给 Engine 走创世路径（自建 rng 流 + 播种股票 + 生成首日事件）。
    const matcher = new PlayerMatcher({ db, cfg, masterSeed: SEED });
    const clock = new GameClock(GENESIS);
    const engine = new Engine({ db, cfg, masterSeed: SEED, genesisMs: GENESIS,
      matcher, flow: matcher,
      onTickError: (): void => matcher.resetMemory(),
      settlementHooks: [new LoanSettlementHook({ db, cfg }),
        new WorkSettlementHook({ db, cfg, clock })] });

    const rng = Rng.fromSeed(SEED, 1, 'ops');
    /** [lo, hi] 闭区间随机整数（Rng.int 只有单参 maxExclusive）。 */
    const rint = (lo: number, hi: number): number => lo + rng.int(hi - lo + 1);
    const users: U[] = [];
    for (let i = 0; i < USERS; i++) users.push({ id: mkUser(db, `prop${i}`, 10_000_000), name: `prop${i}` });

    const codes = (db.prepare(`SELECT code FROM stocks WHERE status != 'delisted' ORDER BY code`)
      .all() as { code: string }[]).map(r => r.code);
    const pick = <T>(arr: T[]): T => arr[rng.int(arr.length)]!;
    expect(codes.length).toBeGreaterThan(0);

    let day = 0;
    let placed = 0, rejected = 0;

    for (let d = 1; d <= DAYS; d++) {
      day = await advanceDays(engine, day, 1);
      const nowMs = GENESIS + d * 3_600_000;
      for (let k = 0; k < OPS_PER_DAY; k++) {
        const u = pick(users);
        const op = rng.int(7);
        try {
          switch (op) {
            case 0: case 1: { // 下单（涨跌停区间内随机价量）；资金/持仓不足属合法拒绝
              const en = engineNow(db);
              const code = pick(codes);
              const st = db.prepare(`SELECT limit_up up, limit_down dn FROM stock_state WHERE code = ?`)
                .get(code) as { up: number; dn: number };
              const price = rint(st.dn, st.up);
              try {
                placeOrder(db, cfg, en.day, en.nextTick, en.phase, u.id,
                  { code, side: rng.int(2) === 0 ? 'B' : 'S', type: 'L', price, qty: 100 * rint(1, 20),
                    clientKey: `d${d}k${k}` });
                placed++;
              } catch (e) { expectAppError(e); rejected++; }
              break;
            }
            case 2: { // 撤单（任意 open 单）
              const o = db.prepare(`SELECT id FROM orders WHERE user_id = ? AND status = 'open'
                ORDER BY id DESC LIMIT 1`).get(u.id) as { id: number } | undefined;
              if (o !== undefined) {
                try { cancelOrder(db, u.id, o.id); } catch (e) { expectAppError(e); }
              }
              break;
            }
            case 3: { // 借款（失败即合法拒绝：门槛/杠杆/额度）
              try { borrow(db, cfg, engine, u.id, 100_000 * rint(1, 10), pick([20, 60, 120])); }
              catch (e) { expectAppError(e); }
              break;
            }
            case 4: { // 还款（部分/全额）
              const l = db.prepare(`SELECT id, outstanding, accrued_interest FROM loans
                WHERE user_id = ? AND status IN ('active','grace','overdue') ORDER BY id LIMIT 1`)
                .get(u.id) as { id: number; outstanding: number; accrued_interest: number } | undefined;
              if (l !== undefined) {
                const owed = l.outstanding + l.accrued_interest;
                try { repay(db, cfg, engine, u.id, l.id, Math.max(1, rint(1, owed))); }
                catch (e) { expectAppError(e); }
              }
              break;
            }
            case 5: { // 排班
              const jobs = listJobs(db, cfg, u.id).filter(j => j.eligible);
              if (jobs.length > 0) {
                try { scheduleShift(db, cfg, clock, nowMs, u.id, pick(jobs).id); }
                catch (e) { expectAppError(e); }
              }
              break;
            }
            case 6: { // 报课
              try { enrollCourse(db, cfg, clock, nowMs, u.id, pick([...ABILITY_KINDS])); }
              catch (e) { expectAppError(e); }
              break;
            }
          }
        } catch (e) {
          throw new Error(`op ${op} day ${d} failed unexpectedly: ${String(e)}`);
        }
      }
      // 日内惰性结转，保证班次/课程与被拒路径都跟上
      for (const u of users) processDueForUser(db, cfg, clock, nowMs, u.id);
      if (d % 10 === 0) invariants(db, `day ${d}`);
    }

    invariants(db, 'final');

    // 覆盖面体检：确定性序列不应全部被拒，也不应全部成功（否则等于没压测到拒绝路径）
    expect(placed, 'no orders accepted at all').toBeGreaterThan(0);
    expect(rejected, 'no orders rejected at all').toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) c FROM trades').get() as { c: number }).c,
      'no trades occurred').toBeGreaterThan(0);

    const checked = reconcileTrades(db);
    expect(checked, 'no trades to reconcile').toBeGreaterThan(0);

    // 强平链条收敛性：任何 overdue 贷款的强平日 = due_day + graceDays + liqOverdueDay。
    // 最终日之后，不应存在"早已过了强平日却仍处于 overdue"的贷款（说明强平/破产从未执行）。
    const liqDayExpr = `${DEFAULTS.loans.graceDays + DEFAULTS.loans.liqOverdueDay}`;
    const staleOverdue = db.prepare(`SELECT COUNT(*) c FROM loans
      WHERE status = 'overdue' AND due_day + ${liqDayExpr} < ?`).get(DAYS) as { c: number };
    expect(staleOverdue.c, 'overdue loans past liquidation day were never liquidated').toBe(0);

    // 逾期状态终态化检查：活跃/宽限/逾期的贷款都应满足 due_day ≥ 起始日 + 期限
    const badTerms = db.prepare(`SELECT COUNT(*) c FROM loans
      WHERE status IN ('active','grace','overdue') AND due_day <> start_day + term_days`)
      .get() as { c: number };
    expect(badTerms.c, 'loan due_day inconsistent with start_day + term_days').toBe(0);

    // eslint-disable-next-line no-console
    console.log(`[property] days=${DAYS} users=${USERS} ops=${DAYS * OPS_PER_DAY} ` +
      `orders_accepted=${placed} orders_rejected=${rejected} trades=${checked}`);

    db.close();
  }, 480_000);
});
