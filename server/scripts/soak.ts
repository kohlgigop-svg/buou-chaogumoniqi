// scripts/soak.ts —— 长时守恒压测 CLI：npm run soak -- --days 1000 --users 12
//
// 目的：在远超单测规模的时间跨度上（默认 1000 游戏日 / 12 名玩家）持续注入随机操作，
//   周期性地对账并统计，用于发现"跑得越久越容易暴露"的守恒类缺陷。
//
// 与 test/property/random-ops.test.ts 的关系：
//   单测是"确定性 + 断言即失败"的守门员（150 日，CI 用）；
//   soak 是"长跑 + 汇总报告"的体检工具（默认不在 CI 跑，人工/夜间执行）。
//   两者共用同一套不变量定义与操作分布，保证发现的问题可互相复现。
//
// 用法：
//   npm run soak -- --days 1000 --users 12
//   npm run soak -- --days 3000 --users 20 --seed 7 --report 25 --cache
// 选项：
//   --days   推进的游戏日数（默认 1000）
//   --users  玩家数（默认 12）
//   --seed   主种子（默认 20260828）
//   --ops    每游戏日每玩家平均操作数（默认 4）
//   --report 每多少日输出一行进度（默认 50）
//   --cache  使用磁盘库 ./soak.db 而非内存（默认内存；长跑可省内存但落盘更慢）
//   --keep   保留下载的 soak.db（默认跑完删除）
import { parseArgs } from 'node:util';
import { existsSync, rmSync } from 'node:fs';
import { openDb, ACC, type DB } from '../src/db/database.js';
import { Engine } from '../src/engine/engine.js';
import { PlayerMatcher } from '../src/trading/matcher.js';
import { GameClock } from '../src/core/clock.js';
import { Rng } from '../src/core/rng.js';
import { post, auditUser } from '../src/core/ledger.js';
import { DEFAULTS, type Config } from '../src/config/defaults.js';
import { valuation } from '../src/domain/portfolio.js';
import { borrow, repay, LoanSettlementHook } from '../src/domain/loans.js';
import { scheduleShift, enrollCourse, processDueForUser, WorkSettlementHook,
  listJobs, ABILITY_KINDS } from '../src/domain/work.js';
import { placeOrder, cancelOrder, engineNow } from '../src/trading/orders.js';
import { AppError } from '../src/api/app.js';

const { values } = parseArgs({ options: {
  days: { type: 'string', default: '1000' },
  users: { type: 'string', default: '12' },
  seed: { type: 'string', default: '20260828' },
  ops: { type: 'string', default: '4' },
  report: { type: 'string', default: '50' },
  cache: { type: 'boolean', default: false },
  keep: { type: 'boolean', default: false },
} });

const DAYS = parseInt(values.days!, 10);
const USERS = parseInt(values.users!, 10);
const SEED = parseInt(values.seed!, 10);
const OPS = parseInt(values.ops!, 10);
const REPORT = parseInt(values.report!, 10);
for (const [k, v] of [['days', DAYS], ['users', USERS], ['seed', SEED],
  ['ops', OPS], ['report', REPORT]] as const) {
  if (!Number.isInteger(v) || v <= 0) throw new Error(`bad --${k}: ${v}`);
}

const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);
const DAY_MS = 3_600_000;
const DB_PATH = './soak.db';

if (values.cache && existsSync(DB_PATH)) rmSync(DB_PATH);

const cfg: Config = DEFAULTS;
const db: DB = openDb(values.cache ? DB_PATH : ':memory:');
const matcher = new PlayerMatcher({ db, cfg, masterSeed: SEED });
const clock = new GameClock(GENESIS);
const engine = new Engine({ db, cfg, masterSeed: SEED, genesisMs: GENESIS,
  matcher, flow: matcher,
  onTickError: (): void => matcher.resetMemory(),
  settlementHooks: [new LoanSettlementHook({ db, cfg }),
    new WorkSettlementHook({ db, cfg, clock })] });

const rng = Rng.fromSeed(SEED, 1, 'soak');
const rint = (lo: number, hi: number): number => lo + rng.int(hi - lo + 1);

function mkUser(name: string, cash: number): number {
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

const uidList: number[] = [];
for (let i = 0; i < USERS; i++) uidList.push(mkUser(`soak${i}`, 10_000_000));

const codes = (db.prepare(`SELECT code FROM stocks WHERE status != 'delisted' ORDER BY code`)
  .all() as { code: string }[]).map(r => r.code);
const pick = <T,>(arr: T[]): T => arr[rng.int(arr.length)]!;

/** 合法拒绝即通过；非 AppError 直接抛出（真 bug）。 */
function ok(e: unknown): void { if (e instanceof AppError) return; throw e; }

interface Stats {
  orders: number; orderRejects: number; borrows: number; borrowRejects: number;
  repays: number; shifts: number; courses: number; trades: number;
  liquidations: number; bankruptcies: number; auditFails: number;
}
const stats: Stats = { orders: 0, orderRejects: 0, borrows: 0, borrowRejects: 0,
  repays: 0, shifts: 0, courses: 0, trades: 0, liquidations: 0, bankruptcies: 0, auditFails: 0 };

const pad = (v: string | number, w: number): string => String(v).padStart(w);

console.log(`soak: days=${DAYS} users=${USERS} ops/day/user≈${OPS} seed=${SEED} ` +
  `db=${values.cache ? DB_PATH : ':memory:'}`);
console.log('不变量：全局 Σ=0 / 逐用户 ledger 对账 / 现金非负 / frozen 勾稽 / 强平链条收敛');
console.log([pad('day', 6), pad('净资产合计', 12), pad('成交', 7), pad('挂单拒', 8),
  pad('强平', 6), pad('破产', 6), pad('逾期贷', 8), pad('持仓行', 7), pad('对数账失败', 12)].join(''));

let failures = 0;
let prevTradeCount = 0;
let prevLiqCount = 0;
let prevBkCount = 0;

for (let d = 1; d <= DAYS; d++) {
  engine.catchUpTo(GENESIS + d * DAY_MS);
  const nowMs = GENESIS + d * DAY_MS;

  // 随机操作：每日每个用户抽 OPS 次
  for (let i = 0; i < USERS; i++) {
    const uid = uidList[i]!;
    for (let k = 0; k < OPS; k++) {
      const op = rng.int(7);
      switch (op) {
        case 0: case 1: { // 下单
          const en = engineNow(db);
          const code = pick(codes);
          const st = db.prepare(`SELECT limit_up up, limit_down dn FROM stock_state WHERE code = ?`)
            .get(code) as { up: number; dn: number };
          try {
            placeOrder(db, cfg, en.day, en.nextTick, en.phase, uid,
              { code, side: rng.int(2) === 0 ? 'B' : 'S', type: 'L', price: rint(st.dn, st.up),
                qty: 100 * rint(1, 20), clientKey: `s${d}-${i}-${k}` });
            stats.orders++;
          } catch (e) { ok(e); stats.orderRejects++; }
          break;
        }
        case 2: { // 撤单
          const o = db.prepare(`SELECT id FROM orders WHERE user_id = ? AND status = 'open'
            ORDER BY id DESC LIMIT 1`).get(uid) as { id: number } | undefined;
          if (o !== undefined) { try { cancelOrder(db, uid, o.id); } catch (e) { ok(e); } }
          break;
        }
        case 3: { // 借款
          try { borrow(db, cfg, engine, uid, 100_000 * rint(1, 10), pick([20, 60, 120])); stats.borrows++; }
          catch (e) { ok(e); stats.borrowRejects++; }
          break;
        }
        case 4: { // 还款
          const l = db.prepare(`SELECT id, outstanding, accrued_interest FROM loans
            WHERE user_id = ? AND status IN ('active','grace','overdue') ORDER BY id LIMIT 1`)
            .get(uid) as { id: number; outstanding: number; accrued_interest: number } | undefined;
          if (l !== undefined) {
            const owed = l.outstanding + l.accrued_interest;
            try { repay(db, cfg, engine, uid, l.id, Math.max(1, rint(1, owed))); stats.repays++; }
            catch (e) { ok(e); }
          }
          break;
        }
        case 5: { // 排班
          const jobs = listJobs(db, cfg, uid).filter(j => j.eligible);
          if (jobs.length > 0) {
            try { scheduleShift(db, cfg, clock, nowMs, uid, pick(jobs).id); stats.shifts++; }
            catch (e) { ok(e); }
          }
          break;
        }
        case 6: { // 报课
          try { enrollCourse(db, cfg, clock, nowMs, uid, pick([...ABILITY_KINDS])); stats.courses++; }
          catch (e) { ok(e); }
          break;
        }
      }
    }
    processDueForUser(db, cfg, clock, nowMs, uid);
  }

  // 每 10 日做一次完整对账（太频繁会显著拖慢长跑）
  if (d % 10 === 0) {
    for (const uid of uidList) {
      try { auditUser(db, uid); } catch { stats.auditFails++; failures++; }
    }
    const gsum = (db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger').get() as { s: number }).s;
    if (gsum !== 0) { failures++; console.error(`!! day ${d}: global ledger sum = ${gsum}`); }
    const badHold = (db.prepare(`SELECT COUNT(*) c FROM holdings
      WHERE qty_total < 0 OR qty_sellable < 0 OR qty_sellable > qty_total`).get() as { c: number }).c;
    if (badHold > 0) { failures++; console.error(`!! day ${d}: invalid holdings = ${badHold}`); }
    for (const uid of uidList) {
      // 净资产（totalAssets）**允许为负**——规格 §9 的杠杆约束只在放款时检查，持仓亏损后
      // 净资产转负是"强平/破产"的正常前置态，唯一强制降杠杆路径是逾期第 10 交易日强平。
      // 因此这里只断言：① 估值可计算（非 NaN）、② 现金不为负（账实不能被击穿）。
      const v = valuation(db, uid);
      if (!Number.isFinite(v.totalAssets)) {
        failures++;
        console.error(`!! day ${d}: user ${uid} totalAssets is NaN`);
      }
      if (v.cashAvailable < 0 || v.cashFrozen < 0) {
        failures++;
        console.error(`!! day ${d}: user ${uid} negative cash a=${v.cashAvailable} f=${v.cashFrozen}`);
      }
      const frozenOrders = (db.prepare(`SELECT COALESCE(SUM(frozen),0) v FROM orders
        WHERE user_id = ? AND status = 'open'`).get(uid) as { v: number }).v;
      const cashFrozen = (db.prepare('SELECT cash_frozen f FROM users WHERE id = ?')
        .get(uid) as { f: number }).f;
      if (frozenOrders !== cashFrozen) {
        failures++;
        console.error(`!! day ${d}: user ${uid} frozen mismatch ${frozenOrders} != ${cashFrozen}`);
      }
    }
    // 强平链条收敛：不存在"早已越过强平日却仍逾期"的贷款。
    const stale = db.prepare(`SELECT COUNT(*) c FROM loans WHERE status = 'overdue'
      AND due_day + ${cfg.loans.graceDays + cfg.loans.liqOverdueDay} < ?`).get(d) as { c: number };
    if (stale.c > 0) {
      failures++;
      console.error(`!! day ${d}: ${stale.c} overdue loans past liquidation day were never liquidated`);
    }
  }

  if (d % REPORT === 0 || d === DAYS) {
    const assets = uidList.reduce((s, u) => s + valuation(db, u).totalAssets, 0);
    const tradeCount = (db.prepare('SELECT COUNT(*) c FROM trades').get() as { c: number }).c;
    const liqCount = (db.prepare(`SELECT COUNT(*) c FROM loans WHERE status = 'liquidated'`)
      .get() as { c: number }).c;
    const bkCount = (db.prepare(`SELECT COALESCE(SUM(bankrupt_count),0) c FROM users
      WHERE kind = 'user'`).get() as { c: number }).c;
    const overdue = (db.prepare(`SELECT COUNT(*) c FROM loans WHERE status = 'overdue'`)
      .get() as { c: number }).c;
    const holdRows = (db.prepare('SELECT COUNT(*) c FROM holdings').get() as { c: number }).c;
    stats.trades = tradeCount;
    stats.liquidations = liqCount;
    stats.bankruptcies = bkCount;
    console.log([
      pad(d, 6), pad((assets / 100).toFixed(0), 12), pad(tradeCount, 7), pad(stats.orderRejects, 8),
      pad(liqCount, 6), pad(bkCount, 6), pad(overdue, 8), pad(holdRows, 7), pad(stats.auditFails, 12),
    ].join(''));
    prevTradeCount = tradeCount; prevLiqCount = liqCount; prevBkCount = bkCount;
  }
}
void prevTradeCount; void prevLiqCount; void prevBkCount;

console.log('---');
const alive = (db.prepare(`SELECT COUNT(*) n FROM stocks WHERE status != 'delisted'`)
  .get() as { n: number }).n;
const delisted = (db.prepare(`SELECT COUNT(*) n FROM stocks WHERE status = 'delisted'`)
  .get() as { n: number }).n;
console.log(`soak summary: days=${DAYS} users=${USERS}`);
console.log(`  orders accepted=${stats.orders} rejected=${stats.orderRejects}`);
console.log(`  borrows accepted=${stats.borrows} rejected=${stats.borrowRejects} repays=${stats.repays}`);
console.log(`  shifts=${stats.shifts} courses=${stats.courses} trades=${stats.trades}`);
console.log(`  liquidated loans=${stats.liquidations} bankruptcies=${stats.bankruptcies}`);
console.log(`  audit failures=${stats.auditFails} invariant failures=${failures}`);
console.log(`  stocks alive=${alive} delisted=${delisted}`);
console.log(`  ledger rows=${(db.prepare('SELECT COUNT(*) c FROM ledger').get() as { c: number }).c} ` +
  `orders=${(db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c} ` +
  `trades=${(db.prepare('SELECT COUNT(*) c FROM trades').get() as { c: number }).c}`);

db.close();
if (values.cache && !values.keep && existsSync(DB_PATH)) rmSync(DB_PATH);
process.exit(failures === 0 ? 0 : 1);
