// seed/topup.ts —— 把 `STOCK_SEEDS` 里「库里还没有」的股票补齐到老库。
//
// 为什么需要它：种子表是**创世时一次性**写入的（`Engine` 构造里 `seedStocks`）。
// 线上库已经跑了几十个游戏日，加行到 `STOCK_SEEDS` 对**已存在的库毫无作用** ——
// 只能靠这个幂等函数在 bootstrap 时补齐。
//
// ⚠️⚠️ 最容易漏的一步：**必须修正指数除数**。
// `mcapOf('COMP')` 是「全体存活股市值之和」，凭空多出几十只股会让指数点位
// 从 2600 点一步跳到 8000 点（板块指数同理）。除数法的意义就是「成分变化时保持连续」，
// 所以插入前后各算一次 mcap，再 `adjustDivisorOnChange` 把跳变吃掉。
// 结算流程（`settlement.ts` 第 6→9 步）里那套 mcapBefore/mcapAfter 只覆盖
// 「结算过程中发生的成分变化」，**覆盖不到 bootstrap 这种流程外的变更**。
import type { DB } from '../db/database.js';
import { STOCK_SEEDS, insertSeed } from './stocks.js';
import { mcapOf, adjustDivisorOnChange } from '../engine/candles.js';

export interface TopUpResult {
  /** 新插入的股票数；0 表示库已是最新（绝大多数启动都是这种）。 */
  added: number;
  codes: string[];
}

/**
 * 幂等补齐种子股票。对空库/已满库都是安全的 no-op。
 *
 * `listed_day` 一律写 **1**（=「一直存在」），**不是**当前游戏日：
 * `limitKindOf` 判定 `forDay === listedDay` 时给 IPO 首日档（+44%/−36%），
 * 若写当天，这批股会在结算后带上首日涨跌停 —— 62 只股集体 ±44% 是个不该发生的
 * 波动事件。市场扩容不是 IPO，按「一直都在」处理最干净。
 */
export function ensureStockSeeds(db: DB, day: number): TopUpResult {
  const have = new Set((db.prepare('SELECT code FROM stocks').all() as { code: string }[])
    .map(r => r.code));
  const missing = STOCK_SEEDS.filter(s => !have.has(s.code));
  if (missing.length === 0) return { added: 0, codes: [] };

  // 1) 插入前：记下受影响指数的市值（COMP + 本次涉及的板块）
  const kinds = ['COMP', ...new Set(missing.map(s => `S:${s.sector}`))];
  const before = new Map(kinds.map(k => [k, mcapOf(db, k as 'COMP' | `S:${string}`)]));

  // 2) 插入
  db.transaction(() => { for (const s of missing) insertSeed(db, s, day); })();

  // 3) 插入后：把除数按比例放大，指数点位不变
  for (const k of kinds) {
    const b = before.get(k) as number;
    const after = mcapOf(db, k as 'COMP' | `S:${string}`);
    if (after !== b) adjustDivisorOnChange(db, k, b, after);
  }
  return { added: missing.length, codes: missing.map(s => s.code) };
}
