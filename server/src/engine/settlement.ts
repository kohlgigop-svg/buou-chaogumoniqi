// engine/settlement.ts —— 日终结算编排（步骤顺序即契约，禁止调换）：
// 1 matcher.onDayEnd → 2 hooks.onSettlement → 3 财报(publishReport→applyStTransitions→declareDividends)
// → 4 closeDay → 5 applyExDividend → 6 记录 21 指数成分市值 → 7 processDelistings → 8 scheduleIpoIfNeeded
// → 9 成分变化的指数 adjustDivisorOnChange → 10 rolloverDriftDaily → 11 全体存活股重算明日涨跌停
// → 12 auditGlobal → 13 purgeOldTicks → 14 backup（非补跑）→ 15 次日准备（anchor→regime→events→新 pricing 流）
// RNG 流：reports=fromSeed(seed,D,'reports')；ipo=fromSeed(seed,D,'ipo')；
// 次日 anchor/regime/events/pricing 各自 fromSeed(seed,D+1,<stream>)。
import type { DB } from '../db/database.js';
import { Rng } from '../core/rng.js';
import type { TickCtx, SettlementHook, OrderMatcher } from './types.js';
import { rolloverDriftDaily, generateDayEvents, type DriftItem } from './events.js';
import { reportDueCodes, publishReport } from './reports.js';
import { applyStTransitions, declareDividends, applyExDividend, processDelistings, scheduleIpoIfNeeded } from './corporate.js';
import { closeDay, mcapOf, adjustDivisorOnChange, purgeOldTicks } from './candles.js';
import { evolveAnchorDaily } from './anchor.js';
import { transitionRegime, type RegimeState } from './regime.js';
import { limitKindOf, limitPrices } from './limits.js';
import { auditGlobal } from '../core/ledger.js';

export interface SettlementDeps {
  masterSeed: number;
  matcher: OrderMatcher;
  regime: RegimeState;
  backup: (day: number) => void; // Engine 注入；dataDir/补跑抑制条件由 Engine 判定
}
export interface SettlementResult { regime: RegimeState; rngPricing: Rng }

type IndexKind = 'COMP' | `S:${string}`;

export function runSettlement(db: DB, ctx: TickCtx, hooks: SettlementHook[],
  drift: Map<string, DriftItem[]>, deps: SettlementDeps): SettlementResult {
  const { day, cfg } = ctx;
  const seed = deps.masterSeed;
  // 1. 日终撤单、T+1 解冻
  deps.matcher.onDayEnd(ctx);
  // 2. 计划 B 钩子（贷款/工资/课程/信誉）
  for (const h of hooks) h.onSettlement(ctx);
  // 3. 财报：披露 → ST 迁移 → 分红宣告
  const rngReports = Rng.fromSeed(seed, day, 'reports');
  for (const code of reportDueCodes(db, day, cfg)) {
    publishReport(db, code, day, rngReports, cfg);
    applyStTransitions(db, code, day, cfg);
    declareDividends(db, code, day, cfg);
  }
  // 4. 收盘写日 K、prev_close=close
  closeDay(db, day);
  // 5. 除权除息
  applyExDividend(db, day, cfg);
  // 6. 记录成分市值（COMP + 20 板块）
  const kinds: IndexKind[] = ['COMP',
    ...(db.prepare('SELECT DISTINCT sector FROM stocks ORDER BY sector').all() as { sector: string }[])
      .map(r => `S:${r.sector}` as IndexKind)];
  const mcapBefore = new Map<IndexKind, number>(kinds.map(k => [k, mcapOf(db, k)]));
  // 7. 到期摘牌
  processDelistings(db, day, cfg);
  // 8. IPO 补位排队 / 到期上市
  scheduleIpoIfNeeded(db, day, Rng.fromSeed(seed, day, 'ipo'), cfg);
  // 9. 成分变化 → 除数调整保持指数连续
  for (const k of kinds) {
    const before = mcapBefore.get(k)!;
    const after = mcapOf(db, k);
    if (after !== before) adjustDivisorOnChange(db, k, before, after);
  }
  // 10. 事件摊释滚动到次日
  rolloverDriftDaily(drift, cfg);
  // 11. 全体存活股重算明日涨跌停
  const rows = db.prepare(`SELECT s.code, s.status, s.board, s.listed_day ld, t.prev_close pc
    FROM stocks s JOIN stock_state t ON t.code = s.code
    WHERE s.status != 'delisted' ORDER BY s.code`).all() as
    { code: string; status: string; board: 'SH' | 'SZ' | 'CY'; ld: number; pc: number }[];
  const updLim = db.prepare('UPDATE stock_state SET limit_up = ?, limit_down = ? WHERE code = ?');
  for (const r of rows) {
    const { up, down } = limitPrices(r.pc, limitKindOf(r.status, r.board, r.ld, day + 1), cfg);
    updLim.run(up, down, r.code);
  }
  // 12. 总账全局平衡
  auditGlobal(db);
  // 13. 清理 3 天前 tick 明细
  purgeOldTicks(db, day);
  // 14. 备份（补跑期间除最后一日外抑制）
  deps.backup(day);
  // 15. 次日准备：价值锚游走 → 大盘/板块状态转移 → 次日事件 → 新 pricing 流
  const rngAnchor = Rng.fromSeed(seed, day + 1, 'anchor');
  const codes = (db.prepare(`SELECT code FROM stocks WHERE status != 'delisted' ORDER BY code`)
    .all() as { code: string }[]).map(r => r.code);
  for (const code of codes) evolveAnchorDaily(db, code, rngAnchor, cfg);
  const sectors = (db.prepare(`SELECT DISTINCT sector FROM stocks WHERE status != 'delisted' ORDER BY sector`)
    .all() as { sector: string }[]).map(r => r.sector);
  const regime = transitionRegime(deps.regime, sectors, Rng.fromSeed(seed, day + 1, 'regime'), cfg);
  generateDayEvents(db, day + 1, Rng.fromSeed(seed, day + 1, 'events'), cfg);
  return { regime, rngPricing: Rng.fromSeed(seed, day + 1, 'pricing') };
}
