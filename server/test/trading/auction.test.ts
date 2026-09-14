import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { DEFAULTS, type Config } from '../../src/config/defaults.js';
import { seedStocks } from '../../src/seed/stocks.js';
import { post, auditGlobal, auditUser, balancesOf } from '../../src/core/ledger.js';
import { Rng } from '../../src/core/rng.js';
import { TICKS_PER_DAY, TICK_MS, phaseOfTick } from '../../src/core/clock.js';
import { engineNow, placeOrder, type OrderRow } from '../../src/trading/orders.js';
import { PlayerMatcher, type FillEvent } from '../../src/trading/matcher.js';
import { Engine } from '../../src/engine/engine.js';
import type { TickCtx, StockQuote } from '../../src/engine/types.js';

// 沿用现有测试创世时刻，非真实行情数据。
const G = 1_700_000_000_000;
const SEED = 20260828;
const CODE = '601389';
const forbiddenRng = new Proxy({}, {
  get(): never { throw new Error('auction must not consume pricing RNG'); },
}) as Rng;
function user(db: DB, name: string, cash = 10_000_000): number {
  const id = Number(db.prepare('INSERT INTO users(username) VALUES (?)').run(name).lastInsertRowid);
  post(db, 1, 0, 'genesis', id, [
    { account: id, bucket: 'A', amount: cash, kind: 'GENESIS' },
    { account: ACC.MARKET, bucket: 'A', amount: -cash, kind: 'GENESIS' },
  ]);
  return id;
}
function ctx(db: DB, globalTick: number, cfg: Config = DEFAULTS): TickCtx {
  const rows = db.prepare(`SELECT s.code, s.status, t.price, t.prev_close, t.limit_up, t.limit_down, t.volume
    FROM stocks s JOIN stock_state t ON s.code=t.code`).all() as {
      code: string; status: string; price: number; prev_close: number; limit_up: number; limit_down: number; volume: number;
    }[];
  const quotes = new Map<string, StockQuote>(rows.map(r => [r.code, { code: r.code, status: r.status,
    price: r.price, prevClose: r.prev_close, limitUp: r.limit_up, limitDown: r.limit_down, volume: r.volume }]));
  const tickInDay = globalTick % TICKS_PER_DAY;
  return { db, cfg, globalTick, tickInDay, day: Math.floor(globalTick / TICKS_PER_DAY) + 1,
    phase: phaseOfTick(tickInDay), rng: forbiddenRng, quotes };
}
function order(db: DB, uid: number, tick: number, side: 'B'|'S', price: number, qty: number, key: string,
  type: 'L'|'M' = 'L'): number {
  return placeOrder(db, DEFAULTS, Math.floor(tick / TICKS_PER_DAY) + 1, tick, phaseOfTick(tick % TICKS_PER_DAY), uid,
    type === 'L' ? { code: CODE, side, type, price, qty, clientKey: key }
      : { code: CODE, side, type, qty, clientKey: key }).orderId;
}
function row(db: DB, id: number): OrderRow { return db.prepare('SELECT * FROM orders WHERE id=?').get(id) as OrderRow; }
function holding(db: DB, uid: number) {
  return db.prepare('SELECT qty_total, qty_sellable, cost_total FROM holdings WHERE user_id=? AND code=?')
    .get(uid, CODE) as { qty_total: number; qty_sellable: number; cost_total: number };
}
function stock(db: DB, uid: number, qty: number): void {
  db.prepare('INSERT INTO holdings(user_id,code,qty_total,qty_sellable,cost_total) VALUES (?,?,?,?,?)')
    .run(uid, CODE, qty, qty, qty * 500);
}
function audit(db: DB): void {
  auditGlobal(db);
  for (const r of db.prepare('SELECT id FROM users').all() as { id: number }[]) auditUser(db, r.id);
}

describe('集合竞价及日终单元契约', () => {
  let db: DB; let m: PlayerMatcher;
  beforeEach(() => {
    db = openDb(':memory:'); seedStocks(db, 1);
    m = new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
  });
  afterEach(() => db.close());

  it.each(['open', 'close'] as const)('%s：跨价限价单统一价成交，按创建时间/id排序，不抽钉板随机数', kind => {
    const uid = user(db, 'auction'); stock(db, uid, 200);
    const clear = kind === 'open' ? 59 : 1179;
    const earlier = order(db, uid, clear - 10, 'B', 520, 100, 'earlier');
    const better = order(db, uid, clear - 9, 'B', 560, 100, 'better-price');
    const sell = order(db, uid, clear - 9, 'S', 480, 100, 'sell');
    // 集合竞价采用统一价/NPC 对手，不沿用连续竞价钉板抽签。
    db.prepare('UPDATE stock_state SET limit_up=price WHERE code=?').run(CODE);
    const events: FillEvent[] = []; m.onFill(f => events.push(f));
    db.transaction(() => m.onAuctionClear(ctx(db, clear), kind))();
    expect(events.map(e => e.orderId)).toEqual([earlier, better, sell]);
    expect(events.every(e => e.price === 520 && e.qty === 100 && e.orderStatus === 'done')).toBe(true);
    expect(events[0]).toMatchObject({ commission: 500, transfer: 1, stamp: 0 });
    expect(events[2]).toMatchObject({ commission: 500, transfer: 1, stamp: 26 });
    expect(holding(db, uid)).toMatchObject({ qty_total: 300, qty_sellable: 100 });
    expect(balancesOf(db, uid).frozen).toBe(0);
    expect(m.netFlow(CODE)).toBe(100);
    expect(JSON.parse((db.prepare("SELECT value FROM config WHERE key='matcher_rng'").get() as { value: string }).value))
      .toEqual({ day: 1, state: Rng.fromSeed(SEED, 1, 'matching').serialize() });
    audit(db);
  });

  it('不跨价、未来订单和历史市价单不参加竞价；不跨价限价单留至连续竞价', () => {
    const uid = user(db, 'filters'); stock(db, uid, 100);
    const buy = order(db, uid, 10, 'B', 500, 100, 'buy-low');
    const sell = order(db, uid, 10, 'S', 550, 100, 'sell-high');
    const future = order(db, uid, 1180 + 20, 'B', 560, 100, 'future');
    const market = order(db, uid, 1150, 'B', 0, 100, 'market', 'M');
    db.transaction(() => m.onAuctionClear(ctx(db, 59), 'open'))();
    for (const id of [buy, sell, future, market]) expect(row(db, id)).toMatchObject({ status: 'open', filled: 0 });
    expect(db.prepare('SELECT * FROM trades').all()).toHaveLength(0);
    db.prepare('UPDATE stock_state SET price=500 WHERE code=?').run(CODE);
    db.transaction(() => m.onContinuousTick(ctx(db, 60)))();
    expect(row(db, buy).status).toBe('done');
    db.transaction(() => m.onAuctionClear(ctx(db, 1179), 'close'))();
    expect(row(db, market).status).toBe('open');
    expect(row(db, sell).status).toBe('open');
    expect(row(db, future).status).toBe('open');
    audit(db);
  });

  it('竞价补齐部分成交单，使用剩余冻结额，成交完结释放差额', () => {
    const cfg = { ...DEFAULTS, trading: { ...DEFAULTS.trading, boardFillProb: 1, boardFillRatio: [0.1, 0.1] as [number, number] } };
    m = new PlayerMatcher({ db, cfg, masterSeed: SEED });
    const uid = user(db, 'partial');
    const id = order(db, uid, 1159, 'B', 560, 1000, 'partial-buy');
    db.prepare('UPDATE stock_state SET limit_up=price WHERE code=?').run(CODE);
    db.transaction(() => m.onContinuousTick(ctx(db, 1159, cfg)))();
    expect(row(db, id)).toMatchObject({ status: 'open', filled: 100 });
    db.transaction(() => m.onAuctionClear(ctx(db, 1179, cfg), 'close'))();
    expect(row(db, id)).toMatchObject({ status: 'done', filled: 1000, frozen: 0 });
    expect(db.prepare('SELECT qty FROM trades WHERE order_id=? ORDER BY id').all(id)).toEqual([{ qty: 100 }, { qty: 900 }]);
    expect(balancesOf(db, uid).frozen).toBe(0);
    expect(holding(db, uid)).toMatchObject({ qty_total: 1000, qty_sellable: 0 });
    audit(db);
  });

  it('日终释放部分买卖单剩余冻结，T+1解冻，清零净流且重复执行不重复记账', () => {
    const cfg = { ...DEFAULTS, trading: { ...DEFAULTS.trading, boardFillProb: 1, boardFillRatio: [0.1, 0.1] as [number, number] } };
    m = new PlayerMatcher({ db, cfg, masterSeed: SEED });
    const buyer = user(db, 'buyer'); const seller = user(db, 'seller'); stock(db, seller, 1000);
    const buy = order(db, buyer, 1159, 'B', 520, 1000, 'buy');
    const sell = order(db, seller, 1159, 'S', 520, 1000, 'sell');
    db.prepare('UPDATE stock_state SET limit_up=price,limit_down=price WHERE code=?').run(CODE);
    db.transaction(() => m.onContinuousTick(ctx(db, 1159, cfg)))();
    expect(row(db, buy).filled).toBe(100); expect(row(db, sell).filled).toBe(100);
    expect(holding(db, seller)).toMatchObject({ qty_total: 900, qty_sellable: 0 });
    db.transaction(() => m.onDayEnd(ctx(db, 1180, cfg)))();
    expect(row(db, buy)).toMatchObject({ status: 'expired', filled: 100, frozen: 0 });
    expect(row(db, sell)).toMatchObject({ status: 'expired', filled: 100 });
    expect(holding(db, buyer)).toMatchObject({ qty_total: 100, qty_sellable: 100 });
    expect(holding(db, seller)).toMatchObject({ qty_total: 900, qty_sellable: 900 });
    expect(balancesOf(db, buyer)).toEqual({ available: 10_000_000 - 52_501, frozen: 0 });
    expect(m.netFlow(CODE)).toBe(0);
    const ledger = db.prepare('SELECT * FROM ledger ORDER BY id').all();
    db.transaction(() => m.onDayEnd(ctx(db, 1180, cfg)))();
    expect(db.prepare('SELECT * FROM ledger ORDER BY id').all()).toEqual(ledger);
    expect(holding(db, seller).qty_sellable).toBe(900);
    audit(db);
  });

  it('收盘单边成交净流非零，日终持久化清空，冷启动后仍为零', () => {
    const uid = user(db, 'close-flow');
    order(db, uid, 1170, 'B', 560, 200, 'close-only-buy');
    db.transaction(() => m.onAuctionClear(ctx(db, 1179), 'close'))();
    expect(m.netFlow(CODE)).toBe(200);
    const configFlow = () => (db.prepare("SELECT value FROM config WHERE key='matcher_flow'").get() as { value: string }).value;
    expect(JSON.parse(configFlow())).toEqual({ [CODE]: 200 });
    db.transaction(() => m.onDayEnd(ctx(db, 1180)))();
    expect(m.netFlow(CODE)).toBe(0);
    expect(configFlow()).toBe('{}');
    const restarted = new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
    expect(restarted.netFlow(CODE)).toBe(0);
    expect(holding(db, uid)).toMatchObject({ qty_total: 200, qty_sellable: 200 });
    audit(db);
  });

  it('无单竞价清除上一轮净流，新交易日独立撮合流重置', () => {
    const uid = user(db, 'flow'); order(db, uid, 10, 'B', 560, 100, 'fill');
    db.transaction(() => m.onAuctionClear(ctx(db, 59), 'open'))();
    expect(m.netFlow(CODE)).toBe(100);
    m = new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
    db.transaction(() => m.onAuctionClear(ctx(db, 1259), 'open'))();
    expect(m.netFlow(CODE)).toBe(0);
    expect(JSON.parse((db.prepare("SELECT value FROM config WHERE key='matcher_rng'").get() as { value: string }).value))
      .toEqual({ day: 2, state: Rng.fromSeed(SEED, 2, 'matching').serialize() });
    audit(db);
  });
});

describe('规格 §4.4：集合竞价统一价受当轮挂单净需求失衡调整', () => {
  let db: DB; let m: PlayerMatcher;
  beforeEach(() => {
    db = openDb(':memory:'); seedStocks(db, 1);
    m = new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
  });
  afterEach(() => db.close());

  // CODE 的日均量 adv = 7.5e8（日），单 tick 均量 = adv/1100 ≈ 681,818 股。
  // 净需求要产生可见调整，量级必须与之相当 —— 几百股在 1e-7 量级，四舍五入后恒为 0。
  const BIG = 700_000;

  /** 让参考价可预期：把 price 与 limit_up/limit_down 设为 1000。 */
  function pinPrice(p = 1000): void {
    db.prepare('UPDATE stock_state SET price=?, prev_close=?, limit_up=?, limit_down=? WHERE code=?')
      .run(p, p, Math.round(p * 1.1), Math.round(p * 0.9), CODE);
  }
  function tradePrices(): number[] {
    return (db.prepare('SELECT price FROM trades ORDER BY id').all() as { price: number }[]).map(r => r.price);
  }

  it('买单净需求占优时，统一价高于参考价', () => {
    const uid = user(db, 'buy-heavy', 5_000_000_000); stock(db, uid, 100);
    pinPrice(1000);
    // 单边净买（无卖单）：净需求为正，统一价应上抬
    order(db, uid, 20, 'B', 1050, BIG, 'b1');
    const events: FillEvent[] = []; m.onFill(f => events.push(f));
    db.transaction(() => m.onAuctionClear(ctx(db, 59), 'open'))();
    expect(events).toHaveLength(1);
    expect(events[0]!.price).toBeGreaterThan(1000);
  });

  it('卖单净需求占优时，统一价低于参考价', () => {
    const uid = user(db, 'sell-heavy'); stock(db, uid, BIG);
    pinPrice(1000);
    order(db, uid, 20, 'S', 950, BIG, 's1');
    const events: FillEvent[] = []; m.onFill(f => events.push(f));
    db.transaction(() => m.onAuctionClear(ctx(db, 59), 'open'))();
    expect(events).toHaveLength(1);
    expect(events[0]!.price).toBeLessThan(1000);
  });

  it('买卖净需求为零时，统一价等于参考价', () => {
    const buyer = user(db, 'np-buyer', 5_000_000_000); const seller = user(db, 'np-seller');
    stock(db, seller, BIG);
    pinPrice(1000);
    order(db, buyer, 20, 'B', 1050, BIG, 'nb');
    order(db, seller, 20, 'S', 950, BIG, 'ns');
    const events: FillEvent[] = []; m.onFill(f => events.push(f));
    db.transaction(() => m.onAuctionClear(ctx(db, 59), 'open'))();
    expect(events).toHaveLength(2);
    expect(events.every(e => e.price === 1000)).toBe(true);
  });

  it('调整幅度受 auctionImpactCap 限制（不越出涨跌停）', () => {
    const uid = user(db, 'capped', 500_000_000_000); stock(db, uid, 100);
    pinPrice(1000);
    // 净买远超单 tick 均量：调整必须被 cap 夹住（≤ cap），且不越过涨停 1100
    order(db, uid, 20, 'B', 1090, 200_000_000, 'big');
    const events: FillEvent[] = []; m.onFill(f => events.push(f));
    db.transaction(() => m.onAuctionClear(ctx(db, 59), 'open'))();
    expect(events).toHaveLength(1);
    const p = events[0]!.price;
    expect(p).toBeLessThanOrEqual(Math.round(1000 * (1 + DEFAULTS.trading.auctionImpactCap)) + 1);
    expect(p).toBeGreaterThan(1000);
  });

  it('⚠️ 玩家稀疏性：规模与单 tick 均量同量级的挂单也必须实际推动统一价', () => {
    // K=0.8 时 raw 落在 1e-4 量级，round 后调整量恒为 0 —— 竞价定价形同虚设。
    // 用「本金级」规模（BIG 与单 tick 均量同量级）验证调整确实非零。
    const uid = user(db, 'sparse', 50_000_000_000); stock(db, uid, 100);
    pinPrice(1000);
    order(db, uid, 20, 'B', 1090, BIG, 'sparse-b');
    const events: FillEvent[] = []; m.onFill(f => events.push(f));
    db.transaction(() => m.onAuctionClear(ctx(db, 59), 'open'))();
    expect(events).toHaveLength(1);
    expect(events[0]!.price).toBeGreaterThan(1000); // 具体位移量已非 0
  });

  it('调整后的价格对所有合资格委托一致（统一价语义）', () => {
    const buyer = user(db, 'uni-buyer', 5_000_000_000); const seller = user(db, 'uni-seller');
    stock(db, seller, BIG);
    pinPrice(1000);
    order(db, buyer, 20, 'B', 1050, BIG, 'ub');
    order(db, seller, 20, 'S', 950, BIG, 'us');
    const events: FillEvent[] = []; m.onFill(f => events.push(f));
    db.transaction(() => m.onAuctionClear(ctx(db, 59), 'open'))();
    expect(new Set(tradePrices()).size).toBe(1); // 全部成交同价
    expect(new Set(events.map(e => e.price)).size).toBe(1);
    audit(db);
  });

  it('竞价调整不消耗撮合 RNG（确定性回放不受影响）', () => {
    const uid = user(db, 'no-rng', 5_000_000_000); stock(db, uid, 100);
    pinPrice(1000);
    order(db, uid, 20, 'B', 1050, BIG, 'nr');
    db.transaction(() => m.onAuctionClear(ctx(db, 59), 'open'))();
    expect(JSON.parse((db.prepare("SELECT value FROM config WHERE key='matcher_rng'").get() as { value: string }).value))
      .toEqual({ day: 1, state: Rng.fromSeed(SEED, 1, 'matching').serialize() });
  });

  it('净需求调整后账实自洽（守恒）', () => {
    const buyer = user(db, 'ok-buyer', 5_000_000_000); const seller = user(db, 'ok-seller');
    stock(db, seller, BIG);
    pinPrice(1000);
    order(db, buyer, 20, 'B', 1050, BIG, 'ob');
    order(db, seller, 20, 'S', 950, BIG, 'os');
    db.transaction(() => m.onAuctionClear(ctx(db, 59), 'open'))();
    audit(db);
  });
});

describe('真实引擎集合竞价、结算和重启', () => {

  it('开盘tick59成交、同日不可卖、日终过期释放、次日可卖；跨收盘重启结果一致', async () => {
    function build() {
      const db = openDb(':memory:');
      const m = new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: SEED });
      const eng = new Engine({ db, cfg: DEFAULTS, masterSeed: SEED, genesisMs: G, matcher: m, flow: m,
        onTickError: () => m.resetMemory() });
      return { db, m, eng, uid: user(db, 'trader') };
    }
    const A = build(); const B = build();
    try {
      for (const run of [A, B]) {
        run.eng.catchUpTo(G + 10 * TICK_MS);
        const q = run.eng.getQuote(CODE)!;
        const buy = order(run.db, run.uid, 11, 'B', q.limitUp, 100, 'auction-buy');
        run.eng.catchUpTo(G + 58 * TICK_MS);
        expect(row(run.db, buy).filled).toBe(0);
        run.eng.catchUpTo(G + 59 * TICK_MS);
        expect(row(run.db, buy)).toMatchObject({ status: 'done', filled: 100 });
        // ⚠️ 成交价 = **竞价清算价**（参考价叠加净需求调整后夹在涨跌停内），
        // 不一定等于该 tick 的模型参考价：本单规模远超单 tick 均量时调整量会实际生效。
        // 这里断言「成交价 = 参考价 ± 净需求调整」，即必须落在涨跌停内、且不小于参考价
        // （本用例是单边大额买单，净需求为正）。跨重启两条链的一致性由末尾 dump 全等保证。
        const ref: number = run.eng.getQuote(CODE)!.price;
        const trade = run.db.prepare('SELECT price,tick FROM trades WHERE order_id=?').get(buy) as
          { price: number; tick: number };
        expect(trade.tick).toBe(59);
        expect(trade.price).toBeGreaterThanOrEqual(ref);
        expect(trade.price).toBeLessThanOrEqual(Math.round(ref * (1 + DEFAULTS.trading.auctionImpactCap)) + 1);
        expect(holding(run.db, run.uid).qty_sellable).toBe(0);
        expect(() => order(run.db, run.uid, 60, 'S', run.eng.getQuote(CODE)!.limitDown, 100, 'same-day'))
          .toThrow('not enough sellable shares');
        run.eng.catchUpTo(G + 1178 * TICK_MS);
        // 测试专用极低下界，确保剩余买单不跨收盘价，日终走过期释放。
        run.db.prepare('UPDATE stock_state SET limit_down=1 WHERE code=?').run(CODE);
        order(run.db, run.uid, 1179, 'B', 1, 100, 'resting');
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const m2 = new PlayerMatcher({ db: B.db, cfg: DEFAULTS, masterSeed: SEED });
      const e2 = new Engine({ db: B.db, cfg: DEFAULTS, masterSeed: SEED, genesisMs: G, matcher: m2, flow: m2,
        onTickError: () => m2.resetMemory() });
      for (const [eng, run] of [[A.eng, A], [e2, B]] as const) {
        eng.catchUpTo(G + 1180 * TICK_MS);
        expect(run.db.prepare("SELECT status,frozen FROM orders WHERE client_key='resting'").get())
          .toEqual({ status: 'expired', frozen: 0 });
        expect(balancesOf(run.db, run.uid).frozen).toBe(0);
        expect(holding(run.db, run.uid).qty_sellable).toBe(holding(run.db, run.uid).qty_total);
        eng.catchUpTo(G + 1200 * TICK_MS);
        const en = engineNow(run.db);
        expect(en.day).toBe(2);
        const sold = order(run.db, run.uid, en.nextTick, 'S', eng.getQuote(CODE)!.limitDown, 100, 'day-two');
        eng.catchUpTo(G + 1259 * TICK_MS);
        expect(row(run.db, sold)).toMatchObject({ status: 'done', filled: 100 });
        audit(run.db);
      }
      const dump = (db: DB) => ({
        orders: db.prepare('SELECT id,side,type,price,qty,filled,frozen,status,day,created_tick FROM orders ORDER BY id').all(),
        trades: db.prepare('SELECT * FROM trades ORDER BY id').all(),
        ledger: db.prepare('SELECT user_id,bucket,day,tick,kind,amount,balance_after,ref_type,ref_id FROM ledger ORDER BY id').all(),
        holdings: db.prepare('SELECT * FROM holdings ORDER BY user_id,code').all(),
        config: db.prepare("SELECT * FROM config WHERE key LIKE 'matcher_%' ORDER BY key").all(),
        engine: db.prepare('SELECT * FROM engine_state').all(),
        quotes: db.prepare('SELECT * FROM stock_state ORDER BY code').all(),
      });
      expect(dump(A.db)).toEqual(dump(B.db));
    } finally { A.db.close(); B.db.close(); }
  }, 60_000);
});
