# 计划 A：核心域与行情引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 paper-trader 的无界面核心：游戏时钟、复式账本、48 只虚构股的确定性行情引擎（含事件/财报/分红/ST/退市/IPO）与断点补跑，全部由测试保护。

**Architecture:** npm workspaces 单仓库（server/shared/web）；本计划只建 server 与 shared。引擎为进程内 tick 循环，所有随机数出自持久化种子 PRNG，状态每 tick 落 SQLite（WAL）；玩家相关逻辑通过钩子接口留空（计划 B 填充）。

**Tech Stack:** Node ≥22（本机 24）、TypeScript 5 严格模式、ESM、better-sqlite3 v12、vitest、tsx。

**Spec:** `docs/superpowers/specs/2026-08-28-paper-trader-design.md`（下称"规格"。本计划实现规格 §2 §3 §4 §6 §13(部分) §14(部分) §16(1/2/3)。执行者必须同时打开规格——附录 A/B 是本计划的数据源。）

## Global Constraints

- 所有金额一律**整数"分"**存储与运算；费用逐笔四舍五入到分（规格 §5）。
- 时间常量：1 交易日=60 现实分钟；tick=3 秒；每日 1200 tick（开盘竞价 tick 0–59、连续竞价 60–1159、收盘竞价 1160–1179、结算 1180–1199）（规格 §2）。
- 涨跌停：主板 ±10%、创业板 ±20%、ST ±5%、IPO 首日 +44%/−36%，基准昨收，四舍五入到分（规格 §5）。
- 一切随机数出自 `core/rng.ts` 的流；**禁止使用 `Math.random`**（补跑一致性靠它）。
- ledger 只追加；每笔 posting 的 legs 金额和恒为 0（规格 §16）。
- TypeScript `strict: true`；每个 Task 以 `npm test` 全绿 + git commit 结束。
- 提交信息用英文 conventional commits（feat:/test:/chore:）。

## File Structure（本计划落定的边界）

```
paper-trader/
├─ package.json                 # workspaces: ["server","shared","web"]
├─ tsconfig.base.json
├─ .gitignore
├─ shared/                      # 计划 B/C 使用的 DTO；本计划仅建空壳
│  ├─ package.json  └─ src/index.ts
└─ server/
   ├─ package.json
   ├─ tsconfig.json
   ├─ vitest.config.ts
   ├─ src/
   │  ├─ config/defaults.ts     # 规格 §14 全部默认参数（唯一数值来源）
   │  ├─ db/database.ts         # 打开+PRAGMA+迁移器（唯一 SQLite 接触面）
   │  ├─ db/migrations/001_init.sql
   │  ├─ core/money.ts          # Cents 运算与费用
   │  ├─ core/clock.ts          # 墙钟 → (day, phase, tick)
   │  ├─ core/rng.ts            # xoshiro128** 流 + 正态/t 分布
   │  ├─ core/ledger.ts         # 复式记账
   │  ├─ seed/stocks.ts         # 附录 A 48 股 + 每板块 2 个备用 IPO 名
   │  ├─ seed/events.ts         # 附录 B 30 事件类型
   │  ├─ engine/types.ts        # TickCtx、钩子接口、引擎对外类型
   │  ├─ engine/limits.ts       # 涨跌停价
   │  ├─ engine/regime.ts       # 大盘 HMM + 板块 AR(1)
   │  ├─ engine/anchor.ts       # EPS/PE 内在价值 + 净资产
   │  ├─ engine/pricing.ts      # 每 tick 收益合成
   │  ├─ engine/events.ts       # 事件生成与冲击释放队列
   │  ├─ engine/reports.ts      # 财报披露 + surprise
   │  ├─ engine/corporate.ts    # 分红/ST/退市/IPO
   │  ├─ engine/candles.ts      # 分时/日K/指数（除数法）
   │  ├─ engine/settlement.ts   # 日终结算编排 + 对账 + 备份
   │  └─ engine/engine.ts       # tick 主循环、快照、补跑
   ├─ scripts/simulate.ts       # CLI：快进 N 日打印市场摘要
   └─ test/                     # 与 src 镜像的 *.test.ts
```

**跨计划接口（计划 B 依赖，本计划必须原样产出）**

```ts
// engine/types.ts
export interface TickCtx { day: number; tickInDay: number; globalTick: number;
  phase: 'auction_open'|'continuous'|'auction_close'|'settlement';
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
export class Engine {
  constructor(deps: { db: DB; cfg: Config; masterSeed: number; genesisMs: number;
    matcher?: OrderMatcher; settlementHooks?: SettlementHook[]; flow?: FlowProvider });
  start(): void; stop(): void;
  catchUpTo(nowMs: number): number;       // 返回补跑的 tick 数
  getQuote(code: string): StockQuote | undefined;
  onTick(cb: (ctx: TickCtx) => void): () => void; }
```

---

### Task 1: Monorepo 脚手架与测试基建

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `shared/package.json`, `shared/src/index.ts`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/test/sanity.test.ts`

**Interfaces:**
- Produces: 可运行的 `npm test`（workspace 级）、`npm run test -w server`。

- [ ] **Step 1: 写根与子包配置**

`package.json`（根）:
```json
{
  "name": "paper-trader", "private": true, "type": "module",
  "workspaces": ["shared", "server", "web"],
  "engines": { "node": ">=22" },
  "scripts": { "test": "npm run test -w server", "simulate": "npm run simulate -w server" }
}
```

`tsconfig.base.json`:
```json
{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
  "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true,
  "forceConsistentCasingInFileNames": true, "declaration": true } }
```

`.gitignore`: `node_modules/`, `dist/`, `*.db`, `*.db-*`, `/data/`, `coverage/`

`shared/package.json`: `{ "name": "@pt/shared", "version": "0.0.0", "type": "module", "main": "src/index.ts" }`；`shared/src/index.ts`: `export {};`

`server/package.json`:
```json
{ "name": "@pt/server", "version": "0.0.0", "type": "module",
  "scripts": { "test": "vitest run", "test:watch": "vitest", "simulate": "tsx scripts/simulate.ts" },
  "dependencies": { "better-sqlite3": "^12.4.1" },
  "devDependencies": { "@types/better-sqlite3": "^7.6.13", "@types/node": "^24.3.0",
    "tsx": "^4.20.0", "typescript": "^5.9.0", "vitest": "^3.2.0" } }
```

`server/tsconfig.json`: `{ "extends": "../tsconfig.base.json", "include": ["src", "scripts", "test"] }`
`server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], pool: 'threads' } });
```

`server/test/sanity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
describe('sanity', () => { it('runs', () => expect(1 + 1).toBe(2)); });
```

- [ ] **Step 2: 安装并验证测试失败→通过路径**

Run: `npm install`（仓库根）。若 better-sqlite3 无预编译包报 node-gyp 错误：**不要装编译工具链**，改用内置 `node:sqlite`——把 Task 5 的 database.ts 换成注释中给出的 node:sqlite 版本（接口不变），并从依赖中移除 better-sqlite3。
Run: `npm test` → 期望 sanity 1 passed。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: monorepo scaffold with vitest"
```

---

### Task 2: core/money.ts —— 分运算与费用

**Files:**
- Create: `server/src/core/money.ts`
- Test: `server/test/core/money.test.ts`

**Interfaces:**
- Produces: `type Cents = number`（整数分）；`roundHalfUpDiv(n: bigint|number, d: number): Cents`；`commission(amount: Cents): Cents`（万2.5 最低 500 分）；`stampTax(amount: Cents): Cents`（0.05% 仅卖出，调用方决定）；`transferFee(amount: Cents): Cents`（万0.1）；`dividendTax(amount: Cents): Cents`（10%）；`assertCents(v: number): void`（非整数/非安全整数即 throw）。

- [ ] **Step 1: 写失败测试**

`server/test/core/money.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { commission, stampTax, transferFee, dividendTax, roundHalfUpDiv, assertCents } from '../../src/core/money.js';

describe('money', () => {
  it('roundHalfUpDiv 四舍五入到分', () => {
    expect(roundHalfUpDiv(1035, 10)).toBe(104);  // 103.5 → 104
    expect(roundHalfUpDiv(1034, 10)).toBe(103);
    expect(roundHalfUpDiv(0, 10)).toBe(0);
  });
  it('佣金 万2.5 最低5元', () => {
    expect(commission(1_000_000)).toBe(500);      // 1万元成交 → 触底 5 元
    expect(commission(10_000_000)).toBe(2500);    // 10万元 → 25 元
    expect(commission(1_234_567)).toBe(500);      // 308.6 分 → 仍触底
    expect(commission(20_000_001)).toBe(5000);    // 5000.00025 → 5000
  });
  it('印花税 卖出 0.05%', () => {
    expect(stampTax(10_000_000)).toBe(5000);      // 10万 → 50 元
    expect(stampTax(999)).toBe(0);                // 0.4995 分 → 0
  });
  it('过户费 万0.1', () => { expect(transferFee(10_000_000)).toBe(100); });
  it('红利税 10%', () => { expect(dividendTax(12345)).toBe(1235); }); // 1234.5→1235
  it('assertCents 拒绝小数', () => { expect(() => assertCents(1.5)).toThrow(); });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test` → 期望 FAIL（模块不存在）。

- [ ] **Step 3: 最小实现**

`server/src/core/money.ts`:
```ts
export type Cents = number;
export function assertCents(v: number): void {
  if (!Number.isSafeInteger(v)) throw new Error(`not integer cents: ${v}`);
}
export function roundHalfUpDiv(n: number, d: number): Cents {
  if (d <= 0) throw new Error('bad divisor');
  const q = Math.floor(n / d), r = n - q * d;
  return r * 2 >= d ? q + 1 : q;                 // n≥0 前提，调用方保证
}
const MIN_COMMISSION = 500;
export function commission(amount: Cents): Cents {
  assertCents(amount);
  return Math.max(MIN_COMMISSION, roundHalfUpDiv(amount * 25, 100_000)); // 万2.5
}
export function stampTax(amount: Cents): Cents { assertCents(amount); return roundHalfUpDiv(amount * 5, 10_000); }   // 0.05%
export function transferFee(amount: Cents): Cents { assertCents(amount); return roundHalfUpDiv(amount, 100_000); }   // 万0.1
export function dividendTax(amount: Cents): Cents { assertCents(amount); return roundHalfUpDiv(amount, 10); }        // 10%
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test` → 期望全部 PASS。

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: money primitives and A-share fees"`

---

### Task 3: core/clock.ts —— 游戏时钟

**Files:**
- Create: `server/src/core/clock.ts`
- Test: `server/test/core/clock.test.ts`

**Interfaces:**
- Produces: `const TICK_MS = 3000; const TICKS_PER_DAY = 1200;`
  `type Phase = 'auction_open'|'continuous'|'auction_close'|'settlement';`
  `phaseOfTick(tickInDay: number): Phase`（0–59 开盘竞价 / 60–1159 连续 / 1160–1179 收盘竞价 / 1180–1199 结算）；
  `class GameClock { constructor(genesisMs: number); globalTick(nowMs: number): number; dayOfTick(t: number): number;  // 1 起 tickInDay(t: number): number; gameMinuteAbs(nowMs: number): number; // 游戏分钟绝对值 = 全局分钟×24 }`

- [ ] **Step 1: 写失败测试**

`server/test/core/clock.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { GameClock, phaseOfTick, TICK_MS, TICKS_PER_DAY } from '../../src/core/clock.js';

const G = 1_700_000_000_000;
const c = new GameClock(G);
describe('clock', () => {
  it('创世时刻是第1日 tick0 开盘竞价', () => {
    expect(c.globalTick(G)).toBe(0);
    expect(c.dayOfTick(0)).toBe(1);
    expect(c.tickInDay(0)).toBe(0);
    expect(phaseOfTick(0)).toBe('auction_open');
  });
  it('相位边界', () => {
    expect(phaseOfTick(59)).toBe('auction_open');
    expect(phaseOfTick(60)).toBe('continuous');
    expect(phaseOfTick(1159)).toBe('continuous');
    expect(phaseOfTick(1160)).toBe('auction_close');
    expect(phaseOfTick(1180)).toBe('settlement');
    expect(phaseOfTick(1199)).toBe('settlement');
  });
  it('一小时后进入第2日', () => {
    const t = c.globalTick(G + 3_600_000);
    expect(t).toBe(TICKS_PER_DAY);
    expect(c.dayOfTick(t)).toBe(2);
    expect(c.tickInDay(t)).toBe(0);
  });
  it('tick 不足不进位', () => { expect(c.globalTick(G + TICK_MS - 1)).toBe(0); });
  it('游戏分钟换算 1现实分=24游戏分', () => {
    expect(c.gameMinuteAbs(G + 60_000) - c.gameMinuteAbs(G)).toBe(24);
  });
});
```

- [ ] **Step 2: 确认失败** — Run: `npm test` → FAIL。

- [ ] **Step 3: 实现**

`server/src/core/clock.ts`:
```ts
export const TICK_MS = 3000;
export const TICKS_PER_DAY = 1200;
export type Phase = 'auction_open'|'continuous'|'auction_close'|'settlement';
export function phaseOfTick(tickInDay: number): Phase {
  if (tickInDay < 0 || tickInDay >= TICKS_PER_DAY) throw new Error(`bad tick ${tickInDay}`);
  if (tickInDay < 60) return 'auction_open';
  if (tickInDay < 1160) return 'continuous';
  if (tickInDay < 1180) return 'auction_close';
  return 'settlement';
}
export class GameClock {
  constructor(readonly genesisMs: number) {}
  globalTick(nowMs: number): number {
    if (nowMs < this.genesisMs) throw new Error('before genesis');
    return Math.floor((nowMs - this.genesisMs) / TICK_MS);
  }
  dayOfTick(t: number): number { return Math.floor(t / TICKS_PER_DAY) + 1; }
  tickInDay(t: number): number { return t % TICKS_PER_DAY; }
  gameMinuteAbs(nowMs: number): number {
    return Math.floor((nowMs - this.genesisMs) / 60_000) * 24
      + Math.floor(((nowMs - this.genesisMs) % 60_000) / 2500); // 2.5s=1游戏分
  }
}
```

- [ ] **Step 4: 确认通过** — Run: `npm test` → PASS。
- [ ] **Step 5: Commit** — `git commit -am "feat: game clock (1h = 1 trading day, 1200 ticks)"`

---

### Task 4: core/rng.ts —— 确定性随机流

**Files:**
- Create: `server/src/core/rng.ts`
- Test: `server/test/core/rng.test.ts`

**Interfaces:**
- Produces: `class Rng { static fromSeed(masterSeed: number, day: number, stream: string): Rng;
  next(): number;            // [0,1)
  normal(): number;          // Box-Muller，固定消耗 2 个 uniform，无缓存
  studentT4(): number;       // z/sqrt(chi2_4/4)，固定消耗 4 个 uniform
  int(maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  poisson(lambda: number): number;   // Knuth 乘积法
  serialize(): string; static restore(s: string): Rng; }`

- [ ] **Step 1: 写失败测试**

`server/test/core/rng.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Rng } from '../../src/core/rng.js';

describe('rng', () => {
  it('同参数完全同序列', () => {
    const a = Rng.fromSeed(42, 7, 'pricing'), b = Rng.fromSeed(42, 7, 'pricing');
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });
  it('不同流不同序列', () => {
    const a = Rng.fromSeed(42, 7, 'pricing'), b = Rng.fromSeed(42, 7, 'events');
    const same = Array.from({ length: 50 }, () => a.next() === b.next()).filter(Boolean).length;
    expect(same).toBeLessThan(3);
  });
  it('序列化恢复后续序列一致', () => {
    const a = Rng.fromSeed(1, 1, 's');
    for (let i = 0; i < 37; i++) a.next();
    const b = Rng.restore(a.serialize());
    for (let i = 0; i < 100; i++) expect(b.next()).toBe(a.next());
  });
  it('normal 大样本均值≈0 方差≈1', () => {
    const r = Rng.fromSeed(9, 1, 'n'); let s = 0, s2 = 0; const N = 20000;
    for (let i = 0; i < N; i++) { const x = r.normal(); s += x; s2 += x * x; }
    expect(Math.abs(s / N)).toBeLessThan(0.03);
    expect(Math.abs(s2 / N - 1)).toBeLessThan(0.05);
  });
  it('studentT4 比正态肥尾（|x|>3 频率更高）', () => {
    const r = Rng.fromSeed(9, 1, 't'); let fat = 0; const N = 20000;
    for (let i = 0; i < N; i++) if (Math.abs(r.studentT4()) > 3) fat++;
    expect(fat / N).toBeGreaterThan(0.005); // 正态≈0.0027，t4≈0.0114
  });
  it('poisson(2) 均值≈2', () => {
    const r = Rng.fromSeed(3, 1, 'p'); let s = 0; const N = 10000;
    for (let i = 0; i < N; i++) s += r.poisson(2);
    expect(Math.abs(s / N - 2)).toBeLessThan(0.1);
  });
});
```

- [ ] **Step 2: 确认失败** — Run: `npm test` → FAIL。

- [ ] **Step 3: 实现**

`server/src/core/rng.ts`:
```ts
function splitmix32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15); t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0); };
}
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export class Rng {
  private constructor(private s0: number, private s1: number, private s2: number, private s3: number) {}
  static fromSeed(masterSeed: number, day: number, stream: string): Rng {
    const mix = splitmix32((masterSeed ^ Math.imul(day, 0x9e3779b1) ^ fnv1a(stream)) | 0);
    let a = mix(), b = mix(), c = mix(), d = mix();
    if ((a | b | c | d) === 0) a = 1;
    return new Rng(a, b, c, d);
  }
  private nextU32(): number { // xoshiro128**：rotl(s1*5, 7) * 9
    const s1x5 = (this.s1 * 5) | 0;
    const rot = ((s1x5 << 7) | (s1x5 >>> 25)) | 0;
    const result = Math.imul(rot, 9) >>> 0;
    const t = (this.s1 << 9) | 0;
    this.s2 ^= this.s0; this.s3 ^= this.s1; this.s1 ^= this.s2; this.s0 ^= this.s3; this.s2 ^= t;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) | 0;
    return result;
  }
  next(): number { return this.nextU32() / 4294967296; }
  normal(): number {
    const u1 = Math.max(this.next(), 1e-12), u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  studentT4(): number {
    const z = this.normal();
    const e = -Math.log(Math.max(this.next(), 1e-12)) - Math.log(Math.max(this.next(), 1e-12));
    return z / Math.sqrt((2 * e) / 4); // chi2_4 = 2·(Exp1+Exp1)
  }
  int(maxExclusive: number): number { return Math.floor(this.next() * maxExclusive); }
  pick<T>(arr: readonly T[]): T {
    const v = arr[this.int(arr.length)];
    if (v === undefined) throw new Error('pick from empty');
    return v;
  }
  poisson(lambda: number): number {
    const L = Math.exp(-lambda); let k = 0, p = 1;
    do { k++; p *= this.next(); } while (p > L);
    return k - 1;
  }
  serialize(): string { return JSON.stringify([this.s0, this.s1, this.s2, this.s3]); }
  static restore(s: string): Rng {
    const [a, b, c, d] = JSON.parse(s) as number[];
    return new Rng(a!, b!, c!, d!);
  }
}
```
（rotl 结果保持 32 位有符号中间值即可，`>>> 0` 只在 `next()` 归一化前使用；测试的逐位一致性会兜住实现偏差。）

- [ ] **Step 4: 确认通过** — Run: `npm test` → PASS（分布断言若边缘波动，允许调种子常数一次，不允许放宽阈值）。
- [ ] **Step 5: Commit** — `git commit -am "feat: deterministic seeded rng streams (xoshiro128**)"`

---

### Task 5: db/database.ts + 全量建表迁移

**Files:**
- Create: `server/src/db/database.ts`, `server/src/db/migrations/001_init.sql`
- Test: `server/test/db/database.test.ts`

**Interfaces:**
- Produces: `type DB = import('better-sqlite3').Database;`
  `openDb(path: string): DB`（`:memory:` 可用；设 `journal_mode=WAL`(内存库除外)、`foreign_keys=ON`、`synchronous=NORMAL`；按 `user_version` 顺序执行 migrations 目录内 SQL）。
  系统账户常量：`export const ACC = { MARKET: 1, BANK: 2, TAX: 3, EMPLOYER: 4, CLEARING: 5 } as const;`

- [ ] **Step 1: 写失败测试**

`server/test/db/database.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb, ACC } from '../../src/db/database.js';

describe('database', () => {
  it('迁移建出 23 张表', () => {
    const db = openDb(':memory:');
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map((r: any) => r.name);
    for (const t of ['users','sessions','stocks','stock_state','candles_day','ticks','orders','trades','holdings','ledger','loans','credit_events','jobs','shifts','abilities','enrollments','news','reports','dividends','config','engine_state','announcements','admin_logs'])
      expect(names).toContain(t);
  });
  it('系统账户已播种且 kind=system', () => {
    const db = openDb(':memory:');
    const row = db.prepare('SELECT kind FROM users WHERE id=?').get(ACC.MARKET) as any;
    expect(row.kind).toBe('system');
    const n = (db.prepare(`SELECT COUNT(*) c FROM users WHERE kind='system'`).get() as any).c;
    expect(n).toBe(5);
  });
  it('重复打开幂等', () => {
    const db = openDb(':memory:');
    expect((db.pragma('user_version', { simple: true }) as number)).toBe(1);
  });
  it('ledger 禁止 UPDATE/DELETE（触发器）', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO ledger(user_id,bucket,day,tick,kind,amount,balance_after,ref_type,ref_id) VALUES(1,'A',1,0,'TEST',0,0,'t',0)`).run();
    expect(() => db.prepare(`UPDATE ledger SET amount=1 WHERE id=1`).run()).toThrow();
    expect(() => db.prepare(`DELETE FROM ledger WHERE id=1`).run()).toThrow();
  });
});
```

- [ ] **Step 2: 确认失败** — Run: `npm test` → FAIL。

- [ ] **Step 3: 实现迁移与打开器**

`server/src/db/migrations/001_init.sql`（完整落表；金额单位分、EPS/每股值用 `_e6`=微元整数）:
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pwd_hash TEXT,
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system')),
  cash_available INTEGER NOT NULL DEFAULT 0,
  cash_frozen INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 600,
  bankrupt_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  reg_ip TEXT, created_day INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE stocks (
  code TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  board TEXT NOT NULL CHECK (board IN ('SH','SZ','CY')),
  sector TEXT NOT NULL, shares_total INTEGER NOT NULL,
  vol_tier TEXT NOT NULL CHECK (vol_tier IN ('L','M','H')),
  beta REAL NOT NULL, payout_tier TEXT NOT NULL CHECK (payout_tier IN ('H','M','L','N')),
  listed_day INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal','st','delisting','delisted')),
  st_since_day INTEGER, delist_at_day INTEGER, ipo_price INTEGER
);
CREATE TABLE stock_state (
  code TEXT PRIMARY KEY REFERENCES stocks(code),
  price INTEGER NOT NULL, prev_close INTEGER NOT NULL,
  open INTEGER, high INTEGER, low INTEGER,
  volume INTEGER NOT NULL DEFAULT 0, turnover INTEGER NOT NULL DEFAULT 0,
  limit_up INTEGER NOT NULL, limit_down INTEGER NOT NULL,
  eps_e6 INTEGER NOT NULL, pe REAL NOT NULL, equity_e6 INTEGER NOT NULL,
  loss_streak INTEGER NOT NULL DEFAULT 0, win_streak INTEGER NOT NULL DEFAULT 0,
  drift_json TEXT NOT NULL DEFAULT '[]', adv INTEGER NOT NULL
);
CREATE TABLE candles_day (code TEXT NOT NULL, day INTEGER NOT NULL,
  o INTEGER NOT NULL, h INTEGER NOT NULL, l INTEGER NOT NULL, c INTEGER NOT NULL,
  volume INTEGER NOT NULL, turnover INTEGER NOT NULL, PRIMARY KEY (code, day));
CREATE TABLE ticks (code TEXT NOT NULL, day INTEGER NOT NULL, tick INTEGER NOT NULL,
  price INTEGER NOT NULL, volume INTEGER NOT NULL, PRIMARY KEY (code, day, tick));
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL REFERENCES stocks(code),
  side TEXT NOT NULL CHECK (side IN ('B','S')), type TEXT NOT NULL CHECK (type IN ('L','M')),
  price INTEGER, qty INTEGER NOT NULL, filled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled','expired')),
  frozen INTEGER NOT NULL DEFAULT 0, client_key TEXT NOT NULL,
  day INTEGER NOT NULL, created_tick INTEGER NOT NULL,
  UNIQUE (user_id, client_key));
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
  user_id INTEGER NOT NULL, code TEXT NOT NULL, side TEXT NOT NULL,
  price INTEGER NOT NULL, qty INTEGER NOT NULL,
  commission INTEGER NOT NULL, stamp INTEGER NOT NULL, transfer INTEGER NOT NULL,
  day INTEGER NOT NULL, tick INTEGER NOT NULL);
CREATE TABLE holdings (user_id INTEGER NOT NULL, code TEXT NOT NULL,
  qty_total INTEGER NOT NULL DEFAULT 0 CHECK (qty_total >= 0),
  qty_sellable INTEGER NOT NULL DEFAULT 0 CHECK (qty_sellable >= 0),
  cost_total INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, code));
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('A','F')),
  day INTEGER NOT NULL, tick INTEGER NOT NULL, kind TEXT NOT NULL,
  amount INTEGER NOT NULL, balance_after INTEGER NOT NULL,
  ref_type TEXT NOT NULL, ref_id INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'ledger append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'ledger append-only'); END;
CREATE TABLE loans (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  principal INTEGER NOT NULL, outstanding INTEGER NOT NULL,
  rate_e6 INTEGER NOT NULL, term_days INTEGER NOT NULL,
  start_day INTEGER NOT NULL, due_day INTEGER NOT NULL,
  accrued_interest INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','grace','overdue','repaid','liquidated','forgiven')));
CREATE TABLE credit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  day INTEGER NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, score_after INTEGER NOT NULL);
CREATE TABLE jobs (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, base_pay INTEGER NOT NULL,
  min_credit INTEGER, reqs TEXT NOT NULL DEFAULT '[]');
CREATE TABLE shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  start_gmin INTEGER NOT NULL, end_gmin INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','working','done','cancelled')),
  pay INTEGER);
CREATE TABLE abilities (user_id INTEGER NOT NULL, kind TEXT NOT NULL
    CHECK (kind IN ('EDU','CODE','FIN','FIT','COMM','DESIGN')),
  level INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, kind));
CREATE TABLE enrollments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  kind TEXT NOT NULL, from_level INTEGER NOT NULL,
  start_gmin INTEGER NOT NULL, end_gmin INTEGER NOT NULL, cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled')));
CREATE TABLE news (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL, tick INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('MKT','SEC','STK')), target TEXT,
  type_id TEXT NOT NULL, title TEXT NOT NULL,
  impact_e6 INTEGER NOT NULL, drift_days INTEGER NOT NULL);
CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL,
  period_idx INTEGER NOT NULL, report_day INTEGER NOT NULL,
  eps_e6 INTEGER NOT NULL, revenue INTEGER NOT NULL, profit INTEGER NOT NULL,
  surprise_e6 INTEGER NOT NULL, UNIQUE (code, period_idx));
CREATE TABLE dividends (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL,
  announced_day INTEGER NOT NULL, ex_day INTEGER NOT NULL, per_share_e6 INTEGER NOT NULL);
CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE engine_state (id INTEGER PRIMARY KEY CHECK (id = 1),
  master_seed INTEGER NOT NULL, genesis_ms INTEGER NOT NULL,
  last_tick INTEGER NOT NULL DEFAULT -1, state_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL,
  content TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE admin_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL,
  action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX idx_ledger_user ON ledger (user_id, id);
CREATE INDEX idx_orders_open ON orders (code, status) WHERE status = 'open';
CREATE INDEX idx_trades_user ON trades (user_id, id);
CREATE INDEX idx_ticks_day ON ticks (day);
CREATE INDEX idx_news_day ON news (day, id);
INSERT INTO users (id, username, kind) VALUES
  (1,'@market','system'),(2,'@bank','system'),(3,'@tax','system'),(4,'@employer','system'),(5,'@clearing','system');
```

`server/src/db/database.ts`:
```ts
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export type DB = Database.Database;
export const ACC = { MARKET: 1, BANK: 2, TAX: 3, EMPLOYER: 4, CLEARING: 5 } as const;
const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
export function openDb(path: string): DB {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  const files = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
  const cur = db.pragma('user_version', { simple: true }) as number;
  for (const f of files) {
    const v = parseInt(f.slice(0, 3), 10);
    if (v > cur) db.transaction(() => {
      db.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
      db.pragma(`user_version = ${v}`);
    })();
  }
  return db;
}
```
（若 Task 1 已切换 node:sqlite：等价实现 `new DatabaseSync(path)` + `db.exec`，pragma 用 `db.exec('PRAGMA …')`，`prepare(...).run/get/all` 同名可用；保持 `openDb/ACC` 签名不变。）
注意迁移文件被 tsc 编译时不会拷贝——vitest/tsx 直接跑 TS 源码没问题；生产构建的拷贝在计划 C 的 Dockerfile 任务里处理，此处不做。

- [ ] **Step 4: 确认通过** — Run: `npm test` → PASS。
- [ ] **Step 5: Commit** — `git commit -am "feat: sqlite schema (23 tables) + migration runner"`

---

### Task 6: core/ledger.ts —— 复式记账

**Files:**
- Create: `server/src/core/ledger.ts`
- Test: `server/test/core/ledger.test.ts`

**Interfaces:**
- Produces:
```ts
export type Bucket = 'A' | 'F';
export interface Leg { account: number; bucket: Bucket; amount: Cents; kind: string; }
export function post(db: DB, day: number, tick: number, refType: string, refId: number, legs: Leg[]): void;
// 校验 Σamount===0 且 legs 非空，否则 throw；原子更新 users.cash_available/cash_frozen 并逐 leg 插入 ledger(balance_after=该账户该桶新余额)；
// 用户账户(kind='user')余额不得为负（violates 则 throw 回滚）；系统账户允许负。
export function balancesOf(db: DB, userId: number): { available: Cents; frozen: Cents };
export function auditUser(db: DB, userId: number): void;   // Σledger(A)==available 且 Σledger(F)==frozen，否则 throw
export function auditGlobal(db: DB): void;                 // 全表 Σamount===0，否则 throw
```

- [ ] **Step 1: 写失败测试**

`server/test/core/ledger.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { post, balancesOf, auditUser, auditGlobal } from '../../src/core/ledger.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = Number(db.prepare(`INSERT INTO users(username) VALUES('alice')`).run().lastInsertRowid);
});
describe('ledger', () => {
  it('发初始资金：市场→用户，两腿平衡', () => {
    post(db, 1, 0, 'GENESIS', uid, [
      { account: ACC.MARKET, bucket: 'A', amount: -10_000_000, kind: 'GENESIS' },
      { account: uid, bucket: 'A', amount: 10_000_000, kind: 'GENESIS' }]);
    expect(balancesOf(db, uid)).toEqual({ available: 10_000_000, frozen: 0 });
    auditUser(db, uid); auditGlobal(db);
  });
  it('不平衡拒绝', () => {
    expect(() => post(db, 1, 0, 'X', 0, [{ account: uid, bucket: 'A', amount: 5, kind: 'X' }])).toThrow(/unbalanced/);
  });
  it('冻结=同户 A→F', () => {
    post(db, 1, 0, 'GENESIS', uid, [
      { account: ACC.MARKET, bucket: 'A', amount: -1000, kind: 'GENESIS' },
      { account: uid, bucket: 'A', amount: 1000, kind: 'GENESIS' }]);
    post(db, 1, 1, 'FREEZE', 7, [
      { account: uid, bucket: 'A', amount: -600, kind: 'ORDER_FREEZE' },
      { account: uid, bucket: 'F', amount: 600, kind: 'ORDER_FREEZE' }]);
    expect(balancesOf(db, uid)).toEqual({ available: 400, frozen: 600 });
    auditUser(db, uid);
  });
  it('用户余额不可透支，事务回滚', () => {
    expect(() => post(db, 1, 0, 'X', 0, [
      { account: uid, bucket: 'A', amount: -1, kind: 'X' },
      { account: ACC.MARKET, bucket: 'A', amount: 1, kind: 'X' }])).toThrow(/negative/);
    expect(balancesOf(db, uid)).toEqual({ available: 0, frozen: 0 });
    expect((db.prepare('SELECT COUNT(*) c FROM ledger').get() as any).c).toBe(0);
  });
});
```

- [ ] **Step 2: 确认失败** — Run: `npm test` → FAIL。

- [ ] **Step 3: 实现**

`server/src/core/ledger.ts`:
```ts
import type { DB } from '../db/database.js';
import { assertCents, type Cents } from './money.js';
export type Bucket = 'A' | 'F';
export interface Leg { account: number; bucket: Bucket; amount: Cents; kind: string; }

export function post(db: DB, day: number, tick: number, refType: string, refId: number, legs: Leg[]): void {
  if (legs.length === 0) throw new Error('empty posting');
  let sum = 0; for (const l of legs) { assertCents(l.amount); sum += l.amount; }
  if (sum !== 0) throw new Error(`unbalanced posting: ${sum}`);
  const getU = db.prepare('SELECT kind, cash_available a, cash_frozen f FROM users WHERE id=?');
  const updA = db.prepare('UPDATE users SET cash_available = cash_available + ? WHERE id=?');
  const updF = db.prepare('UPDATE users SET cash_frozen = cash_frozen + ? WHERE id=?');
  const ins = db.prepare(`INSERT INTO ledger(user_id,bucket,day,tick,kind,amount,balance_after,ref_type,ref_id)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const l of legs) {
      const u = getU.get(l.account) as { kind: string; a: number; f: number } | undefined;
      if (!u) throw new Error(`no account ${l.account}`);
      const before = l.bucket === 'A' ? u.a : u.f;
      const after = before + l.amount;
      if (u.kind === 'user' && after < 0) throw new Error(`negative balance for ${l.account}`);
      (l.bucket === 'A' ? updA : updF).run(l.amount, l.account);
      ins.run(l.account, l.bucket, day, tick, l.kind, l.amount, after, refType, refId);
    }
  })();
}
export function balancesOf(db: DB, userId: number): { available: Cents; frozen: Cents } {
  const r = db.prepare('SELECT cash_available a, cash_frozen f FROM users WHERE id=?').get(userId) as any;
  return { available: r.a, frozen: r.f };
}
export function auditUser(db: DB, userId: number): void {
  const s = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN bucket='A' THEN amount END),0) a,
    COALESCE(SUM(CASE WHEN bucket='F' THEN amount END),0) f FROM ledger WHERE user_id=?`).get(userId) as any;
  const b = balancesOf(db, userId);
  if (s.a !== b.available || s.f !== b.frozen)
    throw new Error(`ledger mismatch user=${userId} ledger=(${s.a},${s.f}) balance=(${b.available},${b.frozen})`);
}
export function auditGlobal(db: DB): void {
  const s = (db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger').get() as any).s;
  if (s !== 0) throw new Error(`global ledger sum ${s} != 0`);
}
```

- [ ] **Step 4: 确认通过** — Run: `npm test` → PASS。
- [ ] **Step 5: Commit** — `git commit -am "feat: double-entry ledger with invariant audits"`

---

### Task 7: config/defaults.ts + seed 数据 + engine/limits.ts

**Files:**
- Create: `server/src/config/defaults.ts`, `server/src/seed/stocks.ts`, `server/src/seed/events.ts`, `server/src/engine/limits.ts`
- Test: `server/test/seed/seed.test.ts`, `server/test/engine/limits.test.ts`

**Interfaces:**
- Produces:
```ts
// config/defaults.ts —— 规格 §14 的机器可读形态（本计划用到的键，计划 B 再扩）
export interface Config {
  volSigmaDay: { L: number; M: number; H: number; cyMult: number };   // 0.012/0.018/0.026/1.3
  regime: { states: ['bull','range','bear'];
    muDay: [number, number, number];        // [+0.0035, 0, -0.0040]
    sigmaDay: [number, number, number];     // [0.010, 0.008, 0.013]
    volMult: [number, number, number];      // [1.0, 0.9, 1.25]
    trans: number[][] };                    // 行随机矩阵 3x3（见下）
  sectorAR: { phi: number; sigmaDay: number };          // 0.3 / 0.006
  anchor: { kappaDaily: number; epsSigma: number; peSigma: number; reportNoise: number }; // 0.05/0.02/0.01/0.15
  eventsPerDay: { MKT: number; SEC: number; STK: number };  // 0.3/0.8/2.5
  eventRelease: { instantFrac: number; spreadTicks: number; driftDecay: number }; // 0.3/9/0.5
  reportPeriodDays: number;                 // 60
  payoutRatio: { H: number; M: number; L: number; N: number }; // 0.6/0.3/0.1/0
  limits: { SH: number; SZ: number; CY: number; ST: number; ipoUp: number; ipoDown: number }; // 0.10/0.10/0.20/0.05/0.44/0.36
  stRule: { lossToSt: number; stLossToDelist: number; delistDays: number; recovery: number }; // 2/1/20/0.3
  poolTarget: number; poolMax: number;      // 48 / 50
  backupKeep: number;                       // 7
}
export const DEFAULTS: Config;   // 以及 regime.trans = [[0.97,0.025,0.005],[0.03,0.94,0.03],[0.01,0.04,0.95]]
// seed/stocks.ts
export interface StockSeed { code: string; name: string; board: 'SH'|'SZ'|'CY'; sector: string;
  price0: Cents; sharesE8: number /*亿股*/; volTier: 'L'|'M'|'H'; beta: number; payout: 'H'|'M'|'L'|'N'; }
export const STOCK_SEEDS: StockSeed[];        // 恰 48 条 = 规格附录 A 全表逐行转录
export const SPARE_NAMES: Record<string, string[]>; // 每板块≥2个备用 IPO 名（自拟，风格一致）
export function seedStocks(db: DB, day: number): void; // 写 stocks + stock_state（见下）
// seed/events.ts
export interface EventType { id: string; scope: 'MKT'|'SEC'|'STK'; title: string; // 含 {name} 占位
  lo: number; hi: number;   // 对数收益冲击区间（正负号含方向），如 -0.05..-0.02
  driftDays: number; weight: number; }
export const EVENT_TYPES: EventType[];        // 恰 30 条 = 规格附录 B 全表逐行转录
// engine/limits.ts
export function limitPrices(prevClose: Cents, kind: 'SH'|'SZ'|'CY'|'ST'|'IPO1', cfg: Config): { up: Cents; down: Cents };
```
- `seedStocks` 细则：`stock_state.price=prev_close=price0`；`limit_up/limit_down=limitPrices(price0, 板块或ST)`；`eps_e6 = round(price0_元/PE0×1e6)`（PE0 按波动档 L:18 M:28 H:45）；`pe=PE0`；`equity_e6 = eps_e6×8`；`adv = shares_total×0.005`（日均量=流通盘 0.5%，简化全股本为流通盘）。

- [ ] **Step 1: 写失败测试**

`server/test/seed/seed.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { STOCK_SEEDS, SPARE_NAMES, seedStocks } from '../../src/seed/stocks.js';
import { EVENT_TYPES } from '../../src/seed/events.js';
import { openDb } from '../../src/db/database.js';

describe('seeds', () => {
  it('48 只、创业板 6 只、板块 20 个、代码唯一', () => {
    expect(STOCK_SEEDS).toHaveLength(48);
    expect(STOCK_SEEDS.filter(s => s.board === 'CY')).toHaveLength(6);
    expect(new Set(STOCK_SEEDS.map(s => s.sector)).size).toBe(20);
    expect(new Set(STOCK_SEEDS.map(s => s.code)).size).toBe(48);
    for (const s of STOCK_SEEDS) {
      if (s.board === 'SH') expect(s.code[0]).toBe('6');
      if (s.board === 'SZ') expect(s.code[0]).toBe('0');
      if (s.board === 'CY') expect(s.code.startsWith('30')).toBe(true);
    }
  });
  it('黔台酒业按附录A逐字段正确（抽查行）', () => {
    const m = STOCK_SEEDS.find(s => s.name === '黔台酒业')!;
    expect(m).toMatchObject({ code: '600619', board: 'SH', sector: '白酒饮料',
      price0: 158_000, sharesE8: 12.5, volTier: 'L', beta: 0.7, payout: 'H' });
  });
  it('每板块备用名≥2', () => {
    for (const sec of new Set(STOCK_SEEDS.map(s => s.sector)))
      expect(SPARE_NAMES[sec]!.length).toBeGreaterThanOrEqual(2);
  });
  it('事件库 30 条：6 MKT + 8 SEC + 16 STK，区间合法', () => {
    expect(EVENT_TYPES).toHaveLength(30);
    expect(EVENT_TYPES.filter(e => e.scope === 'MKT')).toHaveLength(6);
    expect(EVENT_TYPES.filter(e => e.scope === 'SEC')).toHaveLength(8);
    expect(EVENT_TYPES.filter(e => e.scope === 'STK')).toHaveLength(16);
    for (const e of EVENT_TYPES) { expect(e.lo).toBeLessThanOrEqual(e.hi); expect(Math.sign(e.lo)).toBe(Math.sign(e.hi)); }
  });
  it('seedStocks 落库自洽', () => {
    const db = openDb(':memory:');
    seedStocks(db, 1);
    expect((db.prepare('SELECT COUNT(*) c FROM stocks').get() as any).c).toBe(48);
    const st = db.prepare(`SELECT * FROM stock_state WHERE code='600619'`).get() as any;
    expect(st.price).toBe(158_000);
    expect(st.limit_up).toBe(173_800); // 1580×1.1=1738.00 元
    expect(st.eps_e6).toBe(Math.round(1580 / 18 * 1e6));
  });
});
```

`server/test/engine/limits.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { limitPrices } from '../../src/engine/limits.js';
import { DEFAULTS } from '../../src/config/defaults.js';

describe('limits（规格 §5 取整示例）', () => {
  it('主板 5.67 → 6.24 / 5.10', () => {
    expect(limitPrices(567, 'SH', DEFAULTS)).toEqual({ up: 624, down: 510 });
  });
  it('ST 5.67 → 5.95 / 5.39', () => {
    expect(limitPrices(567, 'ST', DEFAULTS)).toEqual({ up: 595, down: 539 });
  });
  it('创业板 10.00 → 12.00 / 8.00', () => {
    expect(limitPrices(1000, 'CY', DEFAULTS)).toEqual({ up: 1200, down: 800 });
  });
  it('IPO 首日 10.00 → 14.40 / 6.40', () => {
    expect(limitPrices(1000, 'IPO1', DEFAULTS)).toEqual({ up: 1440, down: 640 });
  });
});
```

- [ ] **Step 2: 确认失败** — Run: `npm test` → FAIL。

- [ ] **Step 3: 实现**

1. `config/defaults.ts`：按上方接口原样写出 `DEFAULTS`（数值全部来自接口注释；不得改动）。
2. `engine/limits.ts`：
```ts
import { roundHalfUpDiv, type Cents } from '../core/money.js';
import type { Config } from '../config/defaults.js';
export function limitPrices(prevClose: Cents, kind: 'SH'|'SZ'|'CY'|'ST'|'IPO1', cfg: Config): { up: Cents; down: Cents } {
  const pct = kind === 'IPO1' ? null : kind === 'ST' ? cfg.limits.ST : cfg.limits[kind];
  const upPct = kind === 'IPO1' ? cfg.limits.ipoUp : pct!;
  const dnPct = kind === 'IPO1' ? cfg.limits.ipoDown : pct!;
  return { up: roundHalfUpDiv(prevClose * Math.round((1 + upPct) * 1000), 1000),
           down: roundHalfUpDiv(prevClose * Math.round((1 - dnPct) * 1000), 1000) };
}
```
3. `seed/stocks.ts`：**打开规格附录 A，把 48 行逐行转录**为 `STOCK_SEEDS`（`price0` 用分：`1580.00→158_000`；`股本` 列填 `sharesE8`）。前 3 行如下，其余 45 行照表抄，测试会抽查与计数：
```ts
export const STOCK_SEEDS: StockSeed[] = [
  { code: '600619', name: '黔台酒业', board: 'SH', sector: '白酒饮料', price0: 158_000, sharesE8: 12.5, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '600859', name: '川酿窖藏', board: 'SH', sector: '白酒饮料', price0: 14_800, sharesE8: 38, volTier: 'M', beta: 0.9, payout: 'H' },
  { code: '002331', name: '快乐水业', board: 'SZ', sector: '白酒饮料', price0: 1_800, sharesE8: 96, volTier: 'L', beta: 0.8, payout: 'H' },
  // …其余 45 行照附录 A 逐行转录…
];
export const SPARE_NAMES: Record<string, string[]> = {
  '白酒饮料': ['晋窖酒业', '甘泉饮品'], '银行': ['汇通银行', '锦城银行'],
  '券商保险': ['东部证券', '瑞和保险'], '医药生物': ['康柏制药', '泰生生物'],
  '新能源电池': ['星辰电池', '聚能新能'], '光伏': ['晴川光伏', '曜阳能源'],
  '半导体': ['芯河科技', '微纳电子'], '消费电子': ['声达电子', '慧屏科技'],
  '软件互联网': ['码上科技', '云帆网络'], '家电': ['凉夏电器', '洁风家电'],
  '汽车': ['骏驰汽车', '峰行汽车'], '地产': ['安居置业', '曜城地产'],
  '基建': ['路桥建设', '巨匠工程'], '钢铁煤炭': ['铁流集团', '黑金能源'],
  '石油化工': ['海油石化', '巨烷化工'], '航运物流': ['蓝鲸航运', '迅达物流'],
  '军工': ['天盾军工', '烈焰动力'], '农牧食品': ['丰穗农业', '鲜禾食品'],
  '航空旅游': ['云翼航空', '四海旅业'], '传媒游戏': ['幻境游戏', '光影传媒'],
};
export function seedStocks(db: DB, day: number): void {
  const insS = db.prepare(`INSERT INTO stocks(code,name,board,sector,shares_total,vol_tier,beta,payout_tier,listed_day)
    VALUES (@code,@name,@board,@sector,@shares,@volTier,@beta,@payout,@day)`);
  const insT = db.prepare(`INSERT INTO stock_state(code,price,prev_close,limit_up,limit_down,eps_e6,pe,equity_e6,adv)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const PE0 = { L: 18, M: 28, H: 45 } as const;
  db.transaction(() => {
    for (const s of STOCK_SEEDS) {
      const shares = Math.round(s.sharesE8 * 1e8);
      insS.run({ ...s, shares, day });
      const { up, down } = limitPrices(s.price0, s.board === 'CY' ? 'CY' : s.board, DEFAULTS);
      const pe = PE0[s.volTier];
      const eps = Math.round((s.price0 / 100) / pe * 1e6);
      insT.run(s.code, s.price0, s.price0, up, down, eps, pe, eps * 8, Math.round(shares * 0.005));
    }
  })();
}
```
4. `seed/events.ts`：**打开规格附录 B，30 条逐行转录**。示例前 2 条 + 计数由测试保护：
```ts
export const EVENT_TYPES: EventType[] = [
  { id: 'MKT_RRR_CUT', scope: 'MKT', title: '央行宣布降准，流动性宽松', lo: 0.01, hi: 0.03, driftDays: 2, weight: 1 },
  { id: 'MKT_RATE_HIKE', scope: 'MKT', title: '央行加息，资金面收紧', lo: -0.03, hi: -0.01, driftDays: 2, weight: 1 },
  // …其余 28 条照附录 B 逐行转录，id 用 SCOPE_大写蛇形…
];
```
（个股/板块标题里写 `{name}` 占位符，生成时替换。）

- [ ] **Step 4: 确认通过** — Run: `npm test` → PASS（计数/抽查/取整全绿）。
- [ ] **Step 5: Commit** — `git commit -am "feat: config defaults, 48-stock & 30-event seeds, price limits"`

---

### Task 8: engine/regime.ts + engine/anchor.ts —— 市场状态与价值锚

**Files:**
- Create: `server/src/engine/regime.ts`, `server/src/engine/anchor.ts`, `server/src/engine/types.ts`
- Test: `server/test/engine/regime.test.ts`

**Interfaces:**
- Produces:
```ts
// engine/types.ts：按"跨计划接口"一节原样落定 TickCtx/StockQuote/OrderMatcher/SettlementHook/FlowProvider（Engine 类在 Task 12）
// engine/regime.ts
export type RegimeState = { regime: 0|1|2; sectorS: Record<string, number> }; // sectorS: 板块 AR(1) 当前值(日单位)
export function transitionRegime(prev: RegimeState, sectors: string[], rng: Rng, cfg: Config): RegimeState; // 日初调用
export function marketTickReturn(state: RegimeState, rng: Rng, cfg: Config): number;   // r_mkt per tick
export function sectorTickReturn(state: RegimeState, sector: string, rng: Rng, cfg: Config): number;
// engine/anchor.ts
export function evolveAnchorDaily(db: DB, code: string, rng: Rng, cfg: Config): void; // 日初：eps/pe 随机游走（写 stock_state）
export function anchorPullPerTick(priceCents: number, eps_e6: number, pe: number, equity_e6: number, price0: number, cfg: Config): number;
// 规则：V元 = eps>0 ? (eps_e6/1e6)*pe : max(0.3*price0元, equity_e6/1e6/8)；pull = kappaDaily*(ln(V)-ln(price元))/1100，夹在±0.001/tick
```

- [ ] **Step 1: 写失败测试**

`server/test/engine/regime.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { transitionRegime, marketTickReturn, sectorTickReturn, type RegimeState } from '../../src/engine/regime.js';
import { anchorPullPerTick } from '../../src/engine/anchor.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Rng } from '../../src/core/rng.js';

const SECS = ['银行', '白酒饮料'];
describe('regime', () => {
  it('同种子转移确定', () => {
    const s0: RegimeState = { regime: 0, sectorS: { 银行: 0, 白酒饮料: 0 } };
    const a = transitionRegime(s0, SECS, Rng.fromSeed(5, 2, 'regime'), DEFAULTS);
    const b = transitionRegime(s0, SECS, Rng.fromSeed(5, 2, 'regime'), DEFAULTS);
    expect(a).toEqual(b);
  });
  it('长期驻留分布覆盖三态', () => {
    let s: RegimeState = { regime: 1, sectorS: {} }; const seen = new Set<number>();
    for (let d = 1; d <= 3000; d++) { s = transitionRegime(s, [], Rng.fromSeed(7, d, 'regime'), DEFAULTS); seen.add(s.regime); }
    expect(seen.size).toBe(3);
  });
  it('牛市日漂移为正（1100 tick 汇总，去噪取均值）', () => {
    const s: RegimeState = { regime: 0, sectorS: {} }; let sum = 0; const R = Rng.fromSeed(1, 1, 'm');
    for (let i = 0; i < 1100 * 200; i++) sum += marketTickReturn(s, R, DEFAULTS);
    expect(sum / 200).toBeGreaterThan(0.001); // ≈ +0.0035/日
  });
  it('板块 AR 有界', () => {
    const s: RegimeState = { regime: 1, sectorS: { 银行: 0 } }; const R = Rng.fromSeed(2, 1, 's');
    for (let i = 0; i < 5000; i++) expect(Math.abs(sectorTickReturn(s, '银行', R, DEFAULTS))).toBeLessThan(0.01);
  });
  it('价格高于锚 → 拉力为负；EPS≤0 用净资产地板', () => {
    expect(anchorPullPerTick(200_00, 5_000_000, 20, 40_000_000, 100_00, DEFAULTS)).toBeLessThan(0);
    const pull = anchorPullPerTick(100_00, -1_000_000, 20, 8_000_000, 100_00, DEFAULTS);
    expect(Number.isFinite(pull)).toBe(true);
  });
});
```

- [ ] **Step 2: 确认失败** — Run: `npm test` → FAIL。

- [ ] **Step 3: 实现**

`engine/regime.ts`（要点）：`transitionRegime` 用 `rng.next()` 对转移行做轮盘；每板块 `sectorS[sec] = phi*prev + normal()*sigmaDay*sqrt(1-phi^2)`（保持平稳方差）。`marketTickReturn = muDay[r]/1100 + normal()*sigmaDay[r]/sqrt(1100)`。`sectorTickReturn = sectorS[sec]/1100 + normal()*(cfg.sectorAR.sigmaDay*0.5)/sqrt(1100)`（板块日值摊到 tick + 小噪声）。
`engine/anchor.ts`：`evolveAnchorDaily`：`eps_e6 *= exp(normal()*cfg.anchor.epsSigma)`——当 eps>0；eps≤0 时 `eps_e6 += |equity_e6|*0.01*normal()`（亏损公司修复/恶化随机）；另以 5% 概率注入景气冲击 `*exp(±0.1)`。`pe *= exp(normal()*cfg.anchor.peSigma)`，夹在 [8, 90]。写回 stock_state。`anchorPullPerTick` 按接口注释公式实现，Math.max/min 夹 ±0.001。
`engine/types.ts`：原样落定接口段代码（`Engine` 类型仅 `export type` 声明占位到 Task 12 实现——写 `export interface EngineDeps {…}` 供 Task 12 使用，**不得**留 TODO 注释）。

- [ ] **Step 4: 确认通过** — Run: `npm test` → PASS。
- [ ] **Step 5: Commit** — `git commit -am "feat: market regime HMM, sector AR, value anchor"`

---

### Task 9: engine/events.ts —— 事件生成与冲击释放

**Files:**
- Create: `server/src/engine/events.ts`
- Test: `server/test/engine/events.test.ts`

**Interfaces:**
- Produces:
```ts
export interface DriftItem { perTick: number; remainTicks: number; dayDecayLeft: number; dailyBase: number; }
export function generateDayEvents(db: DB, day: number, rng: Rng, cfg: Config): void;
// 日初调用：按 poisson(eventsPerDay.*) 抽当日事件数；每事件抽类型(按 weight)、目标(板块/个股均匀)、
// 触发 tick(60..1159 均匀)、冲击 X=uniform(lo,hi)；写 news(released 概念由 tick 到达即“发布”)。
export function applyEventImpacts(db: DB, ctx: { day: number; tickInDay: number }, drift: Map<string, DriftItem[]>, cfg: Config): Map<string, number>;
// 每 tick 调用：把“本 tick 到达的新闻”注入 drift 队列（instantFrac 立即入 map，其余摊 spreadTicks）；
// 消耗各股 drift 队列返回本 tick 附加对数收益 Map<code, r_event>；MKT/SEC 事件展开为对全体/板块内个股的贡献。
export function rolloverDriftDaily(drift: Map<string, DriftItem[]>): void;
// 日终：remainTicks 清零；dayDecayLeft>0 的项转为次日整日摊释（dailyBase*driftDecay^k），否则丢弃。
```
- drift 队列内存态 + 序列化：`serializeDrift(drift): string` / `restoreDrift(s): Map`（引擎快照用）。

- [ ] **Step 1: 写失败测试**（要点断言，完整拷入）

```ts
import { describe, it, expect } from 'vitest';
import { generateDayEvents, applyEventImpacts, serializeDrift, restoreDrift } from '../../src/engine/events.js';
import { openDb } from '../../src/db/database.js';
import { seedStocks } from '../../src/seed/stocks.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Rng } from '../../src/core/rng.js';

describe('events', () => {
  function setup() { const db = openDb(':memory:'); seedStocks(db, 1); return db; }
  it('同种子生成完全一致', () => {
    const a = setup(), b = setup();
    generateDayEvents(a, 3, Rng.fromSeed(11, 3, 'events'), DEFAULTS);
    generateDayEvents(b, 3, Rng.fromSeed(11, 3, 'events'), DEFAULTS);
    expect(a.prepare('SELECT type_id,target,tick,impact_e6 FROM news ORDER BY id').all())
      .toEqual(b.prepare('SELECT type_id,target,tick,impact_e6 FROM news ORDER BY id').all());
  });
  it('1000 日事件量符合泊松参数（±15%）', () => {
    const db = setup(); let n = 0;
    for (let d = 1; d <= 1000; d++) { generateDayEvents(db, d, Rng.fromSeed(1, d, 'events'), DEFAULTS); }
    n = (db.prepare('SELECT COUNT(*) c FROM news').get() as any).c;
    const expDaily = 0.3 + 0.8 + 2.5;
    expect(n).toBeGreaterThan(expDaily * 1000 * 0.85);
    expect(n).toBeLessThan(expDaily * 1000 * 1.15);
  });
  it('冲击释放守恒：instant+spread ≈ X', () => {
    const db = setup();
    db.prepare(`INSERT INTO news(day,tick,scope,target,type_id,title,impact_e6,drift_days)
      VALUES(1,100,'STK','600619','T','t',50000,0)`).run(); // X=+5%
    const drift = new Map(); let total = 0;
    for (let t = 100; t < 1160; t++) {
      const m = applyEventImpacts(db, { day: 1, tickInDay: t }, drift, DEFAULTS);
      total += m.get('600619') ?? 0;
    }
    expect(total).toBeCloseTo(0.05, 3);
  });
  it('drift 序列化往返', () => {
    const drift = new Map([['600619', [{ perTick: 1e-4, remainTicks: 5, dayDecayLeft: 2, dailyBase: 0.01 }]]]);
    expect(restoreDrift(serializeDrift(drift))).toEqual(drift);
  });
});
```

- [ ] **Step 2: 确认失败**，**Step 3: 实现**（按接口注释逐条实现；MKT 事件对每股贡献乘其 beta、SEC 事件仅板块内个股全额；标题 `{name}` 替换目标名），**Step 4: 确认通过**，**Step 5: Commit** — `git commit -am "feat: news event generation and impact release queues"`

---

### Task 10: engine/reports.ts + engine/corporate.ts —— 财报、分红、ST/退市/IPO

**Files:**
- Create: `server/src/engine/reports.ts`, `server/src/engine/corporate.ts`
- Test: `server/test/engine/corporate.test.ts`

**Interfaces:**
- Produces:
```ts
// reports.ts
export function reportDueCodes(db: DB, day: number, cfg: Config): string[];
// code 的披露日：listed_day + offset(code) + k*60，offset = fnv1a(code)%60
export function publishReport(db: DB, code: string, day: number, rng: Rng, cfg: Config): { eps_e6: number; surprise_e6: number };
// eps_rep = anchor_eps*(1+normal()*reportNoise)；expected = 上期 eps_rep（无上期则 anchor_eps）；
// surprise=(eps_rep-expected)/max(|expected|,anchor_eps*0.2)；写 reports 行；更新 equity_e6 += eps_rep；
// 更新 loss/win_streak；把 clamp(surprise*0.5,±0.10) 作为 STK 事件冲击写 news(driftDays=2, type_id='REPORT')。
// corporate.ts
export function applyStTransitions(db: DB, code: string, day: number, cfg: Config): 'none'|'st'|'delisting';
export function processDelistings(db: DB, day: number, cfg: Config): string[];  // 到期摘牌：status='delisted'，回收=最后价*recovery（对持有人：计划B前无人持有；本计划记 news 公告即可，回收记账逻辑写好但对空持仓为 no-op）
export function declareDividends(db: DB, code: string, day: number, cfg: Config): void; // 盈利期：per_share_e6=eps_rep*payoutRatio(tier)；写 dividends(ex_day=day+3)
export function applyExDividend(db: DB, day: number, cfg: Config): void;
// ex_day==day 的分红：prev_close -= round(per_share)，重算涨跌停；派现记账（Σ持仓×每股−税，经 @market→用户；空持仓= no-op）；equity_e6 -= per_share
export function scheduleIpoIfNeeded(db: DB, day: number, rng: Rng, cfg: Config): void;
// 存活<poolTarget 时：3..8 日后 IPO 同板块新股（SPARE_NAMES 取名+标记已用；代码=board 段内 max+7）；
// 定价=板块中位 PE×新 eps；listed_day=IPO 日；首日 limit 用 'IPO1'。存活≥poolTarget 时 0.5% 概率随机 IPO（上限 poolMax）。
```

- [ ] **Step 1: 写失败测试**（核心断言）

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/database.js';
import { seedStocks } from '../../src/seed/stocks.js';
import { publishReport, reportDueCodes } from '../../src/engine/reports.js';
import { applyStTransitions, declareDividends, applyExDividend, scheduleIpoIfNeeded, processDelistings } from '../../src/engine/corporate.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Rng } from '../../src/core/rng.js';

function setup() { const db = openDb(':memory:'); seedStocks(db, 1); return db; }
describe('corporate lifecycle', () => {
  it('60 日周期内每股恰好披露一次', () => {
    const db = setup(); const seen = new Map<string, number>();
    for (let d = 1; d <= 60; d++) for (const c of reportDueCodes(db, d, DEFAULTS))
      seen.set(c, (seen.get(c) ?? 0) + 1);
    expect(seen.size).toBe(48);
    for (const v of seen.values()) expect(v).toBe(1);
  });
  it('连亏2期→ST，再亏1期→delisting，20日后摘牌', () => {
    const db = setup();
    db.prepare(`UPDATE stock_state SET eps_e6=-5_000_000 WHERE code='600619'`).run();
    db.prepare(`UPDATE stock_state SET loss_streak=1 WHERE code='600619'`).run(); // 已亏1期
    publishReport(db, '600619', 61, Rng.fromSeed(1, 61, 'reports'), DEFAULTS);   // 第2期亏
    expect(applyStTransitions(db, '600619', 61, DEFAULTS)).toBe('st');
    publishReport(db, '600619', 121, Rng.fromSeed(1, 121, 'reports'), DEFAULTS); // ST后再亏
    expect(applyStTransitions(db, '600619', 121, DEFAULTS)).toBe('delisting');
    const dd = (db.prepare(`SELECT delist_at_day d FROM stocks WHERE code='600619'`).get() as any).d;
    expect(dd).toBe(141);
    expect(processDelistings(db, 141, DEFAULTS)).toContain('600619');
    expect((db.prepare(`SELECT status s FROM stocks WHERE code='600619'`).get() as any).s).toBe('delisted');
  });
  it('分红除权：昨收下调并重算涨跌停', () => {
    const db = setup();
    db.prepare(`INSERT INTO dividends(code,announced_day,ex_day,per_share_e6) VALUES('600619',1,4,2_000_000)`).run(); // 每股2元
    const before = db.prepare(`SELECT prev_close p FROM stock_state WHERE code='600619'`).get() as any;
    applyExDividend(db, 4, DEFAULTS);
    const after = db.prepare(`SELECT prev_close p, limit_up u FROM stock_state WHERE code='600619'`).get() as any;
    expect(after.p).toBe(before.p - 200);
    expect(after.u).toBe(Math.round((before.p - 200) * 1.1));
  });
  it('摘牌后触发补位 IPO，池子回到 48', () => {
    const db = setup();
    db.prepare(`UPDATE stocks SET status='delisted' WHERE code='600619'`).run();
    scheduleIpoIfNeeded(db, 150, Rng.fromSeed(2, 150, 'ipo'), DEFAULTS); // 记入 pending（实现里用 config 表存 pending json）
    let listed = 0;
    for (let d = 151; d <= 160; d++) { scheduleIpoIfNeeded(db, d, Rng.fromSeed(2, d, 'ipo'), DEFAULTS);
      listed = (db.prepare(`SELECT COUNT(*) c FROM stocks WHERE status!='delisted'`).get() as any).c; if (listed === 48) break; }
    expect(listed).toBe(48);
    const neu = db.prepare(`SELECT code,sector FROM stocks WHERE listed_day>1`).get() as any;
    expect(neu.sector).toBe('白酒饮料');
  });
});
```

- [ ] **Step 2: 确认失败**，**Step 3: 实现**（严格按接口注释；`scheduleIpoIfNeeded` 的 pending 队列存 `config` 表键 `ipo_pending`(json)，日初检查到期即上市），**Step 4: 确认通过**，**Step 5: Commit** — `git commit -am "feat: reports, dividends, ST/delist/IPO lifecycle"`

---

### Task 11: engine/pricing.ts + engine/candles.ts —— tick 定价与 K 线/指数

**Files:**
- Create: `server/src/engine/pricing.ts`, `server/src/engine/candles.ts`
- Test: `server/test/engine/pricing.test.ts`

**Interfaces:**
- Produces:
```ts
// pricing.ts
export function priceTick(db: DB, deps: { day: number; tickInDay: number; regime: RegimeState;
  rng: Rng; drift: Map<string, DriftItem[]>; flow: FlowProvider; cfg: Config }): Map<string, { price: Cents; vol: number }>;
// 对每只 status IN ('normal','st','delisting') 且已上市的股票（固定按 code 排序遍历，保证 RNG 消耗顺序）：
// r = beta*r_mkt + 0.65*r_sec + t4()*sigmaTick + r_event + anchorPull + lambda*netFlow/adv
// newPrice = clamp(round(price*exp(r)), limit_down..limit_up)；封板判定：连续竞价中价格钉在 limit 上。
// NPC 成交量 vol = round(adv/1100 * exp(normal()*0.8))，涨跌停时 *0.3。写 stock_state.price/high/low/volume + ticks 行。
// candles.ts
export function openDay(db: DB, day: number, cfg: Config): void;      // 开盘：open=null→首个连续竞价 tick 补; 这里重置 volume/high/low=prev_close
export function closeDay(db: DB, day: number): void;                  // 写 candles_day(全体存活股) + 指数两行；prev_close=close；重算涨跌停在 corporate 之后由 settlement 调 limits
export function purgeOldTicks(db: DB, day: number): void;             // 删 day-3 以前
export function indexLevel(db: DB, kind: 'COMP'|`S:${string}`): number; // 除数法：level = Σ(price*shares)/divisor；divisor 初值使 day1 开盘=3000/1000
export function adjustDivisorOnChange(db: DB, kind: string, mcapBefore: number, mcapAfter: number): void; // 成分变化日调用
```
- 指数持久化：divisor 存 `config` 键 `divisor:COMP` / `divisor:S:<sector>`；指数即时值每 tick 只进内存 + 每日收盘写 `candles_day(code='IDX:COMP' / 'IDX:S:<sector>')`。

- [ ] **Step 1: 写失败测试**（核心断言）

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/database.js';
import { seedStocks } from '../../src/seed/stocks.js';
import { priceTick } from '../../src/engine/pricing.js';
import { indexLevel, closeDay, openDay } from '../../src/engine/candles.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Rng } from '../../src/core/rng.js';

const NOFLOW = { netFlow: () => 0 };
function setup() { const db = openDb(':memory:'); seedStocks(db, 1); return db; }
describe('pricing', () => {
  it('确定性：同种子同轨迹', () => {
    const run = () => { const db = setup(); const drift = new Map();
      const st = { regime: 1 as const, sectorS: {} };
      for (let t = 60; t < 200; t++) priceTick(db, { day: 1, tickInDay: t, regime: st,
        rng: Rng.fromSeed(9, 1, 'pricing'), drift, flow: NOFLOW, cfg: DEFAULTS });
      return db.prepare(`SELECT price FROM stock_state ORDER BY code`).all(); };
    expect(run()).toEqual(run());
  });
  it('价格被涨跌停夹住', () => {
    const db = setup(); const drift = new Map([['600619', [{ perTick: 0.02, remainTicks: 999, dayDecayLeft: 0, dailyBase: 0 }]]]);
    const st = { regime: 1 as const, sectorS: {} };
    for (let t = 60; t < 400; t++) priceTick(db, { day: 1, tickInDay: t, regime: st,
      rng: Rng.fromSeed(3, 1, 'pricing'), drift, flow: NOFLOW, cfg: DEFAULTS });
    const s = db.prepare(`SELECT price, limit_up u FROM stock_state WHERE code='600619'`).get() as any;
    expect(s.price).toBe(s.u);
  });
  it('指数初值 3000，随成分价格移动', () => {
    const db = setup(); openDay(db, 1, DEFAULTS);
    expect(indexLevel(db, 'COMP')).toBeCloseTo(3000, 6);
    db.prepare(`UPDATE stock_state SET price=price*2 WHERE code='600619'`).run();
    expect(indexLevel(db, 'COMP')).toBeGreaterThan(3000);
  });
  it('收盘写日K与指数K', () => {
    const db = setup(); openDay(db, 1, DEFAULTS); closeDay(db, 1);
    expect((db.prepare(`SELECT COUNT(*) c FROM candles_day WHERE day=1`).get() as any).c).toBe(48 + 21);
  });
});
```

- [ ] **Step 2: 确认失败**，**Step 3: 实现**（`priceTick` 遍历顺序 `ORDER BY code`；每股固定消耗随机数个数：t4 用 4 uniform + NPC 量 2（normal），封板与否不改变消耗；`indexLevel` 用 REAL 计算），**Step 4: 确认通过**，**Step 5: Commit** — `git commit -am "feat: per-tick pricing with limits pinning; candles and index"`

---

### Task 12: engine/settlement.ts + engine/engine.ts —— 主循环、结算、快照与补跑

**Files:**
- Create: `server/src/engine/settlement.ts`, `server/src/engine/engine.ts`
- Test: `server/test/engine/engine.test.ts`

**Interfaces:**
- Produces:（`Engine` 类按"跨计划接口"一节签名实现）
```ts
// settlement.ts
export function runSettlement(db: DB, ctx: TickCtx, hooks: SettlementHook[], drift: Map<string, DriftItem[]>): void;
// 顺序（规格 §2）：matcher.onDayEnd → hooks(计划B) → 财报(reportDueCodes→publishReport→applyStTransitions→declareDividends)
// → applyExDividend → processDelistings → scheduleIpoIfNeeded → closeDay → rolloverDriftDaily
// → 全体存活股按 status 重算明日涨跌停（ST 用 'ST'，IPO 次日转正常）→ auditGlobal → purgeOldTicks
// → 备份（非补跑时）→ 次日准备（evolveAnchorDaily 全体 → transitionRegime → generateDayEvents(day+1)）
// engine.ts
export class Engine { /* 见跨计划接口。要点： */ }
// - initGenesis(db)：engine_state 不存在则写入 {master_seed=cfg 外部传入, genesis_ms, last_tick=-1} 并 seedStocks + openDay(1) + generateDayEvents(1)
// - advanceOne(globalTick)：由 last_tick+1 逐个推进；phase 分发：
//   auction_open/close: 每 tick 只累积；相位最后一个 tick(59/1179) 调 auctionClear：开盘价=模型价(用 pricing 的一次抽样但不写 ticks) + matcher.onAuctionClear
//   continuous: priceTick + matcher.onContinuousTick + applyEventImpacts 合并进 priceTick 的 drift 入参
//   settlement: 相位首 tick(1180) 调 runSettlement；其余 no-op
// - 每 tick 结束：UPDATE engine_state SET last_tick=?, state_json=?（regime、drift 序列化、divisors 在 config 表）——与该 tick 的全部写库同一事务
// - start(): setInterval(1000ms)：target=clock.globalTick(Date.now())，while last<target advanceOne(++last)
// - catchUpTo(nowMs): 同上循环跑到目标，isCatchUp=true（备份仅在最后一日做一次）；返回补跑数
```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/database.js';
import { Engine } from '../../src/engine/engine.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { TICKS_PER_DAY, TICK_MS } from '../../src/core/clock.js';

const G = 1_700_000_000_000;
function mk(db = openDb(':memory:')) {
  return { db, eng: new Engine({ db, cfg: DEFAULTS, masterSeed: 20260828, genesisMs: G }) };
}
describe('engine', () => {
  it('快进 5 日：日K/财报/事件按预期出现', () => {
    const { db, eng } = mk();
    eng.catchUpTo(G + 5 * 3_600_000);
    expect((db.prepare('SELECT MAX(day) d FROM candles_day').get() as any).d).toBe(5);
    expect((db.prepare('SELECT COUNT(*) c FROM candles_day WHERE code=\'IDX:COMP\'').get() as any).c).toBe(5);
    expect((db.prepare('SELECT COUNT(*) c FROM news').get() as any).c).toBeGreaterThan(0);
    const px = db.prepare('SELECT price p FROM stock_state').all() as any[];
    for (const r of px) expect(r.p).toBeGreaterThan(0);
  });
  it('补跑一致性：连续 vs 中断重启，状态逐字段一致', () => {
    const a = mk(); a.eng.catchUpTo(G + 4 * 3_600_000 + 1234 * TICK_MS);
    const b = mk(); b.eng.catchUpTo(G + 2 * 3_600_000 + 77 * TICK_MS);
    const b2 = new Engine({ db: b.db, cfg: DEFAULTS, masterSeed: 20260828, genesisMs: G }); // 重启：从 engine_state 恢复
    b2.catchUpTo(G + 4 * 3_600_000 + 1234 * TICK_MS);
    const dump = (db: any) => ({
      st: db.prepare('SELECT code,price,prev_close,limit_up,limit_down,eps_e6,volume FROM stock_state ORDER BY code').all(),
      cd: db.prepare('SELECT * FROM candles_day ORDER BY code,day').all(),
      nw: db.prepare('SELECT day,tick,scope,target,type_id,impact_e6 FROM news ORDER BY id').all(),
      es: db.prepare('SELECT last_tick FROM engine_state').get() });
    expect(dump(b.db)).toEqual(dump(a.db));
  });
  it('30 日长跑：不变量与生命周期', () => {
    const { db, eng } = mk();
    eng.catchUpTo(G + 30 * 3_600_000);
    expect((db.prepare('SELECT COUNT(*) c FROM reports').get() as any).c).toBe(24); // 48股/60日 → 30日≈24 份（offset 均匀）
    expect((db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger').get() as any).s).toBe(0);
    expect((db.prepare('SELECT COUNT(DISTINCT day) c FROM ticks').get() as any).c).toBeLessThanOrEqual(3);
  }, 120_000);
  it('实时模式 start/stop 不抛错', async () => {
    const { eng } = mk(); eng.start(); await new Promise(r => setTimeout(r, 50)); eng.stop();
  });
});
```
（第三个测试的 `reports` 数量断言依赖 offset=fnv1a(code)%60 的实际分布——实现后先跑一次把真实值填回断言，**不许**放宽为范围。）

- [ ] **Step 2: 确认失败**，**Step 3: 实现**（严格按接口注释顺序；`advanceOne` 内所有写库包在一个 `db.transaction`），**Step 4: 确认通过**（30 日长跑必须 <120s，超时先查 N+1 查询，用 prepared statement 缓存修），**Step 5: Commit** — `git commit -am "feat: engine tick loop with settlement, snapshot and deterministic catch-up"`

---

### Task 13: 备份 + scripts/simulate.ts + 全量回归

**Files:**
- Create: `server/src/engine/backup.ts`, `server/scripts/simulate.ts`
- Modify: `server/src/engine/settlement.ts`（接入 backup）
- Test: `server/test/engine/backup.test.ts`

**Interfaces:**
- Produces: `backupDaily(db: DB, dataDir: string, day: number, keep: number): string`（`VACUUM INTO '<dataDir>/backups/day-<day>.db'`，只留最近 keep 份，返回路径；`:memory:` 库跳过返回 ''）。CLI：`npm run simulate -- --days 90 --seed 42` 打印每 10 日一行（日期/指数/涨跌家数/事件数/财报数/ST 数）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { openDb } from '../../src/db/database.js';
import { backupDaily } from '../../src/engine/backup.js';

describe('backup', () => {
  it('产出文件并滚动保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-'));
    const db = openDb(join(dir, 'game.db'));
    for (let d = 1; d <= 10; d++) backupDaily(db, dir, d, 7);
    const files = readdirSync(join(dir, 'backups'));
    expect(files).toHaveLength(7);
    expect(files).toContain('day-10.db');
    expect(files).not.toContain('day-1.db');
    expect(existsSync(join(dir, 'backups', 'day-4.db'))).toBe(true);
  });
});
```

- [ ] **Step 2: 确认失败**，**Step 3: 实现**（backup + settlement 接线 + simulate CLI：`parseArgs` 解析、内存库跑 Engine.catchUpTo、console.table 输出），**Step 4: 验证**：
Run: `npm test` → 全绿；
Run: `npm run simulate -- --days 90 --seed 42` → 打印 9 行摘要且指数值在 1000–9000 之间（离谱值=模型参数 bug，回查 Task 8/11 参数是否照抄）。
- [ ] **Step 5: Commit** — `git commit -am "feat: daily backup rotation and simulate CLI"`

---

## Self-Review 结论（写计划时已执行）

1. **规格覆盖**：§2 时钟(Task 3)、§4.1 池(7)、§4.2 模型(8/11)、§4.3 事件财报(9/10)、§4.5 钉板(11)、§6 生命周期(10)、§13 表(5)、§14 参数(7)、§16 不变量(6/12)、备份(13)。§4.4 玩家撮合/滑点与 §5 交易规则属计划 B（钩子已留）；§17 部署属计划 C。无遗漏。
2. **占位符扫描**：无 TBD/TODO；seed 两个"照附录逐行转录"任务有计数+抽查测试兜底，属可验证转录而非留白。
3. **类型一致性**：`Rng.fromSeed(seed, day, stream)`、`TickCtx`、`DriftItem`、`limitPrices(kind)` 在 Task 4/7/8/9/11/12 间已交叉核对；`ACC` 常量仅 Task 5 定义、6/12 引用。

## 执行注意

- 每个 Task 的 Step 顺序不可颠倒（测试先行）；测试里的具体数字是规格的化身，**不许为过测改数字**，只许修实现。
- 发现规格与计划冲突：以规格为准并在 commit message 里注明。
- Task 12 的补跑一致性是本计划的灵魂测试，失败时优先排查"每股随机数消耗顺序/个数是否恒定"。
