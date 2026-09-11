// trading/orders.ts —— 下单域：校验/冻结/幂等/撤单（不含撮合，撮合为 T5）。
// 全部资金变动走 post()（A↔F 同户双腿）；placeOrder/cancelOrder 各自在一个 db.transaction 内执行。
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import type { PlaceOrderInput } from '@pt/shared';
import { TICKS_PER_DAY, phaseOfTick, type Phase } from '../core/clock.js';
import { commission, transferFee, type Cents } from '../core/money.js';
import { post } from '../core/ledger.js';
import { AppError } from '../api/app.js';

/** 引擎"当前"视图（R-B2）：nextTick = last_tick+1 即"将处理本单的 tick"；day/tickInDay/phase 均按 nextTick 计。 */
export function engineNow(db: DB): { lastTick: number; nextTick: number; day: number; tickInDay: number; phase: Phase } {
  const row = db.prepare('SELECT last_tick lt FROM engine_state WHERE id = 1').get() as { lt: number };
  const nextTick = row.lt + 1;
  const tid = nextTick % TICKS_PER_DAY;
  return { lastTick: row.lt, nextTick,
    day: Math.floor(nextTick / TICKS_PER_DAY) + 1, tickInDay: tid, phase: phaseOfTick(tid) };
}

export interface OrderRow {
  id: number; user_id: number; code: string; side: 'B' | 'S'; type: 'L' | 'M';
  price: number | null; qty: number; filled: number; status: string; frozen: Cents;
  client_key: string; day: number; created_tick: number;
}

/**
 * 下单。engineDay/engineTick/phase 由调用方从 engineNow(db) 传入（engineTick = nextTick，全局 tick），
 * 域本身不读时钟。orders.day=engineDay、created_tick=engineTick；ledger 过账用 (engineDay, engineTick%1200)。
 */
export function placeOrder(db: DB, cfg: Config, engineDay: number, engineTick: number,
    phase: Phase, userId: number, req: PlaceOrderInput): { orderId: number; reused: boolean } {
  return db.transaction((): { orderId: number; reused: boolean } => {
    // 幂等最先：任何校验/变更之前查 (user_id, client_key)，命中即返回既有单（无视其状态与当前相位）
    const existing = db.prepare('SELECT id FROM orders WHERE user_id = ? AND client_key = ?')
      .get(userId, req.clientKey) as { id: number } | undefined;
    if (existing !== undefined) return { orderId: existing.id, reused: true };

    // 1. 相位准入：结算窗全拒；M 单仅连续竞价（竞价期 M → MARKET_IN_AUCTION）
    if (phase === 'settlement') throw new AppError('PHASE_CLOSED', 400, 'market closed for settlement');
    if (req.type === 'M' && phase !== 'continuous') throw new AppError('MARKET_IN_AUCTION', 400, 'market order not allowed in auction');

    // 2. 标的存在与可交易（delisting/st 正常交易）
    const stock = db.prepare('SELECT status, listed_day ld FROM stocks WHERE code = ?')
      .get(req.code) as { status: string; ld: number } | undefined;
    if (stock === undefined) throw new AppError('UNKNOWN_STOCK', 404, `unknown stock ${req.code}`);
    if (stock.status === 'delisted' || stock.ld > engineDay)
      throw new AppError('STOCK_HALTED', 400, `stock ${req.code} not tradable`);

    // 3. 数量：qty≤0 拒；买入须 100 整数倍；卖出零股允许但不得超过 qty_sellable
    if (req.qty <= 0) throw new AppError('BAD_QTY', 400, 'qty must be positive');
    if (req.side === 'B' && req.qty % 100 !== 0) throw new AppError('BAD_QTY', 400, 'buy qty must be a multiple of 100');
    if (req.side === 'S') {
      const h = db.prepare('SELECT qty_sellable qs FROM holdings WHERE user_id = ? AND code = ?')
        .get(userId, req.code) as { qs: number } | undefined;
      if (req.qty > (h?.qs ?? 0)) throw new AppError('INSUFFICIENT_POSITION', 400, 'not enough sellable shares');
    }

    // 4. 限价须在当日涨跌停区间内
    const state = db.prepare('SELECT price, limit_up up, limit_down dn FROM stock_state WHERE code = ?')
      .get(req.code) as { price: number; up: number; dn: number };
    if (req.type === 'L' && (req.price! < state.dn || req.price! > state.up))
      throw new AppError('BAD_PRICE', 400, `price out of [${state.dn}, ${state.up}]`);

    // 5. 买单冻结额：L 按委托价、M 按现价加缓冲逐股向上取整；费用按冻结基数预估
    let freeze = 0;
    if (req.side === 'B') {
      const base = req.type === 'L'
        ? req.price! * req.qty
        : Math.ceil(state.price * (1 + cfg.trading.marketBufferPct)) * req.qty;
      freeze = base + commission(base) + transferFee(base);
      const u = db.prepare('SELECT cash_available a FROM users WHERE id = ?').get(userId) as { a: number };
      if (u.a < freeze) throw new AppError('INSUFFICIENT_CASH', 400, `need ${freeze} available`);
    }

    // 变更：先插 orders 行（拿 orderId 作 ledger ref），再冻结/扣可卖
    const r = db.prepare(`INSERT INTO orders(user_id, code, side, type, price, qty, status, frozen, client_key, day, created_tick)
      VALUES (?,?,?,?,?,?,'open',?,?,?,?)`)
      .run(userId, req.code, req.side, req.type, req.price ?? null, req.qty, freeze, req.clientKey, engineDay, engineTick);
    const orderId = Number(r.lastInsertRowid);
    if (req.side === 'B') {
      post(db, engineDay, engineTick % TICKS_PER_DAY, 'order', orderId, [
        { account: userId, bucket: 'A', amount: -freeze, kind: 'ORDER_FREEZE' },
        { account: userId, bucket: 'F', amount: freeze, kind: 'ORDER_FREEZE' },
      ]);
    } else {
      db.prepare('UPDATE holdings SET qty_sellable = qty_sellable - ? WHERE user_id = ? AND code = ?')
        .run(req.qty, userId, req.code);
    }
    return { orderId, reused: false };
  })();
}

/** 撤单：仅本人 open 单。买：释放剩余 frozen（F→A）；卖：qty_sellable += 未成交部分；status='cancelled'。 */
export function cancelOrder(db: DB, userId: number, orderId: number): void {
  db.transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined;
    if (o === undefined || o.user_id !== userId) throw new AppError('NOT_FOUND', 404, 'order not found');
    if (o.status !== 'open') throw new AppError('NOT_CANCELLABLE', 409, `order is ${o.status}`);
    const en = engineNow(db);
    releaseOrderRemainder(db, o, en.day, en.tickInDay);
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).run(orderId);
  })();
}

/**
 * 冻结释放原语（撤单/完结/日终过期共用；T5 撮合、T6 日终复用）。
 * 买：剩余 frozen 全额 F→A（'ORDER_UNFREEZE'，为 0 则跳过过账），orders.frozen=0；
 * 卖：qty_sellable += (qty − filled)。不改 status（由调用方负责）。
 */
export function releaseOrderRemainder(db: DB, order: OrderRow, day: number, tick: number): void {
  if (order.side === 'B') {
    if (order.frozen > 0) {
      post(db, day, tick, 'order', order.id, [
        { account: order.user_id, bucket: 'F', amount: -order.frozen, kind: 'ORDER_UNFREEZE' },
        { account: order.user_id, bucket: 'A', amount: order.frozen, kind: 'ORDER_UNFREEZE' },
      ]);
      db.prepare('UPDATE orders SET frozen = 0 WHERE id = ?').run(order.id);
    }
  } else {
    const remainder = order.qty - order.filled;
    if (remainder > 0) {
      db.prepare('UPDATE holdings SET qty_sellable = qty_sellable + ? WHERE user_id = ? AND code = ?')
        .run(remainder, order.user_id, order.code);
    }
  }
}
