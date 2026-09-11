// engine/types.ts —— 跨计划接口（Engine 类在 Task 12 实现）
import type { DB } from '../db/database.js';
import type { Rng } from '../core/rng.js';
import type { Config } from '../config/defaults.js';
import type { Phase } from '../core/clock.js';

export interface TickCtx { day: number; tickInDay: number; globalTick: number;
  phase: Phase;
  db: DB; rng: Rng; cfg: Config; quotes: Map<string, StockQuote>; }
export interface StockQuote { code: string; price: number; prevClose: number;
  limitUp: number; limitDown: number; volume: number; status: string; }
export interface OrderMatcher {           // 计划 B 实现；本计划注入 NoopMatcher
  onContinuousTick(ctx: TickCtx): void;   // 连续竞价每 tick 撮合
  onAuctionClear(ctx: TickCtx, kind: 'open'|'close'): void;
  onDayEnd(ctx: TickCtx): void; }         // 日终撤单、T+1 解冻
export interface SettlementHook {         // 计划 B：贷款/工资/课程/信誉
  onSettlement(ctx: TickCtx): void; }
export interface FlowProvider {           // 玩家净流入（I_player 与竞价失衡）
  netFlow(code: string): number; }        // 单位：股，买正卖负；Noop 返回 0

export interface EngineDeps { db: DB; cfg: Config; masterSeed: number; genesisMs: number;
  matcher?: OrderMatcher; settlementHooks?: SettlementHook[]; flow?: FlowProvider; dataDir?: string;
  onTickError?: () => void;
  /** 实时循环周期（毫秒）。生产默认 1000；测试注入小值以便确定性快速推进。 */
  tickMs?: number }

export class NoopMatcher implements OrderMatcher {
  onContinuousTick(_ctx: TickCtx): void {}
  onAuctionClear(_ctx: TickCtx, _kind: 'open'|'close'): void {}
  onDayEnd(_ctx: TickCtx): void {}
}

export const NOOP_FLOW: FlowProvider = { netFlow: (_code: string): number => 0 };
