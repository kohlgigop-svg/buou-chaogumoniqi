# 计划 B：玩家系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在计划 A 的行情引擎之上实现全部玩家侧系统：账号会话、交易撮合（含 T+1/涨跌停排队/滑点/费用）、信誉、贷款/强平/破产、打工/能力/课程、排行榜、REST API + WebSocket、管理后台 API，以及规格 §16(2) 的随机操作守恒压测。

**Architecture:** 同一 Node 进程内新增 Fastify HTTP/WS 层与领域模块；`PlayerMatcher` 实现计划 A 预留的 `OrderMatcher`+`FlowProvider` 接口挂入引擎；贷款/信誉/打工经 `SettlementHook` 参与日终结算；所有资金变动仍走复式 ledger。玩家动作只写库，引擎补跑重放 tick 时按库内订单确定性重放撮合。

**Tech Stack:** 计划 A 栈 + fastify ^5、@fastify/cookie、@fastify/websocket、@fastify/rate-limit、@node-rs/argon2、zod ^3（shared 包）。

**Spec:** `docs/superpowers/specs/2026-08-28-paper-trader-design.md`（§5 交易规则、§7 账号、§8 信誉、§9 贷款、§10 打工、§12 API/WS、§15 管理、§16 测试）。执行者必须同时打开规格。

## Global Constraints

- 金额一律整数"分"；费用逐笔四舍五入到分（用 `core/money.ts`，禁止另写取整）。
- **禁止 `Math.random`**；撮合随机性只用独立流 `Rng.fromSeed(seed, day, 'matching')`，其状态与被喂给它的一切输入均须在每 tick 事务内持久化（补跑重放一致性是硬约束，计划 A 的等价性测试思想延续到撮合）。
- **`ctx.rng`（定价流）对计划 B 一切代码只读禁用**——碰它就破坏行情重放。
- ledger 只追加、每笔 posting Σ=0、用户余额非负（`core/ledger.ts` 的 `post`，禁止绕过直改 `users` 余额）。
- 服务端唯一权威：所有 API 入参过 zod；资产口径全站唯一：`总资产 = 可用 + 冻结 + 持仓市值 − 未偿贷款本息`。
- 计划 A 遗留义务：①引擎 `advanceOne` 异常时须从最近快照恢复内存态（本计划 T5 落实）；②禁用 `Statement.iterate/pluck/raw`（prepare 记忆化前提）；③`ctx.quotes` 是惰性快照，撮合读取前不得先行写价。
- TypeScript strict（`npm test` 已含 `tsc --noEmit` 门禁）；每 Task 以全绿 + conventional commit 结束。

## File Structure

```
shared/src/
  schemas.ts        # zod：auth/orders/bank/work/admin 的请求 DTO（web 复用）
server/src/
  config/defaults.ts        # 扩展 Config（trading/credit/loans/work/auth 节）
  db/migrations/002_plan_b.sql  # jobs 种子 + login_attempts 表 + 索引
  api/app.ts        # buildApp(deps)：装配、错误包络 {code,message}、rate-limit、cookie
  api/auth.ts       # 注册/登录/登出/会话中间件（request.user 注入）
  api/me.ts         # /api/me、orders/trades/ledger 查询
  api/market.ts     # 行情/个股/K线/新闻/公告/排行榜
  api/trading.ts    # 下单/撤单
  api/bank.ts       # 产品/借款/还款/信誉
  api/work.ts       # 职业/排班/能力/课程
  api/admin.ts      # 管理后台（is_admin 门）
  api/ws.ts         # WebSocket 中枢
  domain/portfolio.ts   # 估值/持仓/收益率（全站唯一口径）
  domain/credit.ts      # 信誉事件引擎
  domain/loans.ts       # 贷款域 + 结算钩子（计息/逾期/强平/破产）
  domain/work.ts        # 打工域 + 惰性结转 + 结算钩子
  trading/orders.ts     # 下单校验/冻结/撤单/幂等/过期释放
  trading/matcher.ts    # PlayerMatcher（撮合 + FlowProvider + 竞价 + 日终）
  index.ts              # bootstrap：env→db→engine(+matcher/hooks)→app→listen
server/test/ …（镜像）+ test/property/random-ops.test.ts + scripts/soak.ts
```

**关键既有接口（计划 A 已定，签名以仓库为准）**：`OrderMatcher{onContinuousTick(ctx), onAuctionClear(ctx, 'open'|'close'), onDayEnd(ctx)}`；`SettlementHook{onSettlement(ctx)}`（在结算第 2 步、closeDay 之前执行）；`FlowProvider{netFlow(code): 股数}`（正=净买入，定价在撮合**之前**运行，故第 T tick 定价读到的是 T−1 tick 的净流）；`TickCtx{day,tickInDay,globalTick,phase,db,rng,cfg,quotes}`；`post(db,day,tick,refType,refId,legs)`；`ACC{MARKET:1,BANK:2,TAX:3,EMPLOYER:4,CLEARING:5}`；`Engine.onTick(cb:(ctx)=>void)` 仅 live 模式回调；`GameClock.gameMinuteAbs(nowMs)`。

## Config 扩展（T1 落定，全计划共用）

```ts
trading: { marketBufferPct: 0.02; slippageK: 0.06; boardFillProb: 0.25; boardFillRatio: [0.1, 0.5] }
auth:    { initialCash: 10_000_000; sessionDays: 30; ipRegPerDay: 5; loginLockN: 5; loginLockMin: 15 }
credit:  { min: 350; max: 850; start: 600; repayOnTime: 15; repayEarly: 20; overduePerDay: -8;
           forcedLiq: -80; bankruptcyScore: 400; shiftPoint: 1; shiftCapPer20d: 10 }
loans:   { termDays: [20, 60, 120]; graceDays: 3; penaltyMult: 2; liqOverdueDay: 10;
           leverageDivisor: 300; reliefCash: 2_000_000;
           tiers: [ // [minScore, 授信上限(分), 日息(e6，即 rate×1e6)]
             [850, 50_000_000, 300], [800, 32_000_000, 320], [750, 20_000_000, 350],
             [700, 13_000_000, 400], [650, 8_000_000, 450], [600, 5_000_000, 500],
             [550, 3_000_000, 550], [500, 2_000_000, 600] ] }   // <500 拒贷；取首个 minScore≤分数 的档
work:    { wageBonusPerPoint: 0.05; shiftsPerDay: 2; shiftGameHours: 8;
           coursePriceBase: 500_000; coursePriceMult: 1.6; courseHoursPerLevel: 8; maxLevel: 10 }
```

日息示例：万5 = 500e-6 → `rate_e6 = 500`；每交易日利息 = `roundHalfUpDiv(principal_outstanding * rate_e6, 1_000_000)`。

---

### Task 1: Config 扩展 + shared zod schemas + 002 迁移

**Files:**
- Modify: `server/src/config/defaults.ts`（追加上方 Config 扩展节，接口+DEFAULTS）
- Create: `shared/src/schemas.ts`, `shared/package.json`(加 zod 依赖), `shared/tsconfig.json`, `server/src/db/migrations/002_plan_b.sql`
- Test: `server/test/config/planb-config.test.ts`, `server/test/db/migration002.test.ts`

**Interfaces (Produces):**
```ts
// shared/src/schemas.ts —— 全部导出 zod schema 与推断类型
export const RegisterSchema = z.object({ username: z.string().min(2).max(16)
    .regex(/^[\w\u4e00-\u9fa5]+$/), password: z.string().min(8).max(72) });
export const LoginSchema = RegisterSchema;                     // 同形
export const PlaceOrderSchema = z.object({ code: z.string().regex(/^\d{6}$/),
  side: z.enum(['B','S']), type: z.enum(['L','M']),
  price: z.number().int().positive().optional(),               // 分；L 必填、M 必空（refine）
  qty: z.number().int().positive(), clientKey: z.string().min(1).max(64) })
  .refine(o => o.type === 'L' ? o.price !== undefined : o.price === undefined);
export const BorrowSchema = z.object({ amount: z.number().int().positive(), termDays: z.number().int() });
export const RepaySchema = z.object({ amount: z.number().int().positive() });
export const ShiftSchema = z.object({ jobId: z.number().int().positive() });
export const EnrollSchema = z.object({ ability: z.enum(['EDU','CODE','FIN','FIT','COMM','DESIGN']) });
export const ChangePasswordSchema = z.object({ oldPassword: z.string().min(8), newPassword: z.string().min(8).max(72) });
```
`002_plan_b.sql`：`CREATE TABLE login_attempts (username TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);`＋`INSERT OR IGNORE` 10 个职业（id 1..10，name/base_pay/min_credit/reqs 逐字取规格 §10 表：传单派发员 800 无要求；外卖骑手 1500 `[["FIT",2]]`；在线客服 1600 `[["COMM",2]]`；家教 2500 `[["EDU",3]]`；平面设计师 2800 `[["DESIGN",3],["COMM",1]]`；会计 3800 `[["FIN",4],["EDU",2]]`；初级程序员 4000 `[["CODE",4],["EDU",3]]`；高级工程师 8000 `[["CODE",7],["EDU",5]]`；投行分析师 10000 `[["FIN",7],["EDU",6],["COMM",4]]`；基金经理 15000 min_credit=700 `[["FIN",9],["EDU",7]]`；base_pay 单位分=×100）＋`CREATE INDEX idx_shifts_user ON shifts(user_id, end_gmin); CREATE INDEX idx_loans_user ON loans(user_id, status);`

- [ ] **Step 1: 失败测试**——config 测试断言上方每个键的精确值（逐键 `toBe`/`toEqual`）；migration 测试断言 `user_version=2`、jobs 10 行且 `基金经理` 行 `{base_pay:1_500_000, min_credit:700}`、login_attempts 存在、二次 openDb 幂等。
- [ ] **Step 2: 确认失败** — Run: `npm test`
- [ ] **Step 3: 实现**（shared 装 zod：workspace 内 `npm install zod@^3 -w shared`；server 依赖 `@pt/shared`）
- [ ] **Step 4: 确认通过** — Run: `npm test`
- [ ] **Step 5: Commit** — `feat: plan-b config, shared zod schemas, jobs seed migration`

---

### Task 2: Fastify 骨架 + 注册/登录/会话

**Files:**
- Create: `server/src/api/app.ts`, `server/src/api/auth.ts`
- Test: `server/test/api/auth.test.ts`

**Interfaces (Produces):**
```ts
// app.ts
export interface AppDeps { db: DB; cfg: Config; engine: Engine; matcher: PlayerMatcher | null;
  dataDir?: string; now?: () => number }        // now 注入便于测试，缺省 Date.now
export function buildApp(deps: AppDeps): Promise<FastifyInstance>;
// - @fastify/cookie + @fastify/rate-limit(global: 300/min/IP) 注册
// - setErrorHandler：zod 错误→400 {code:'VALIDATION', message}; AppError(code,status,message)→status; 其余→500 {code:'INTERNAL'}
// - GET /healthz（无鉴权）→ {ok:true, day, lastTick}
// - decorate request.user（会话中间件：cookie sid → sessions 表 → users；过期/被踢→401 {code:'UNAUTHORIZED'}）
export class AppError extends Error { constructor(public code: string, public status: number, message: string) }
// auth.ts 路由：
// POST /api/auth/register {username,password}：IP 限额（同 reg_ip 当日 UTC 注册数 ≥ cfg.auth.ipRegPerDay → 429 REG_LIMIT）；
//   用户名唯一（409 USERNAME_TAKEN）；argon2id 哈希（@node-rs/argon2 默认参数）；
//   事务内：INSERT users(credit=600, reg_ip, created_day=engine 当前 day) + 6 行 abilities(level 0)
//   + post(GENESIS: MARKET→user, cfg.auth.initialCash)；自动登录（Set-Cookie）。
// POST /api/auth/login：locked_until>now → 423 LOCKED；argon2 verify 失败→fails+1（第 loginLockN 次锁 loginLockMin 分钟）→401 BAD_CREDENTIALS；成功清零并发会话 cookie。
// POST /api/auth/logout：删会话。
// POST /api/auth/password {oldPassword,newPassword}：验旧改新，踢掉其他会话。
// 会话：sid=crypto.randomBytes(32).hex；sessions(id,user_id,expires_at)；滑动续期（访问时 expires<15天 则重置为 30 天）。
// Cookie：httpOnly, sameSite:'lax', path:'/', secure: process.env.NODE_ENV==='production'。
```

- [ ] **Step 1: 失败测试**（app.inject，全部断言状态码+body.code）：注册成功→200 且 `GET /api/me` 200、初始资金 ledger GENESIS 一条 10_000_000、abilities 6 行；重名 409；弱密码 400；同 IP 第 6 个注册 429；登录错 5 次→第 6 次 423（即使密码对）；登出后 me 401；改密后旧会话失效。
- [ ] **Step 2: 确认失败**（先 `npm install fastify@^5 @fastify/cookie@^11 @fastify/rate-limit@^10 @fastify/websocket@^11 @node-rs/argon2@^2 -w server`）
- [ ] **Step 3: 实现**（`/api/me` 本任务先返回 `{user:{id,username,credit,bankruptCount,isAdmin}}` 骨架，T3 扩全）
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: Commit** — `feat: fastify app skeleton with auth, sessions, ip/lockout limits`

---

### Task 3: 估值口径与查询 API

**Files:**
- Create: `server/src/domain/portfolio.ts`, `server/src/api/me.ts`
- Modify: `server/src/api/app.ts`（挂路由）
- Test: `server/test/domain/portfolio.test.ts`

**Interfaces (Produces):**
```ts
// portfolio.ts（纯读）
export interface Valuation { cashAvailable: Cents; cashFrozen: Cents; positionsValue: Cents;
  loansOutstanding: Cents /*本金+已计提利息(含罚息)*/; totalAssets: Cents; totalInflow: Cents /*GENESIS+RELIEF 累计*/;
  returnPct: number /*(totalAssets-totalInflow)/totalInflow，totalInflow=0 时 0*/ }
export function valuation(db: DB, userId: number): Valuation;   // positionsValue=Σ qty_total×stock_state.price（摘牌股按 0）
export function positions(db: DB, userId: number): Array<{ code; name; qtyTotal; qtySellable;
  costTotal: Cents; avgCost: Cents /*=roundHalfUpDiv(costTotal,qtyTotal)，0 股为 0*/; price: Cents; pnl: Cents; pnlPct: number }>;
// me.ts 路由：GET /api/me（user + Valuation + positions + busy 状态占位 null，T9 填充）；
// GET /api/orders?status=open|done|cancelled|expired&limit=50&before=id、GET /api/trades?…、GET /api/ledger?…（倒序分页，belongs-to-user 强校验）
```

- [ ] **Step 1: 失败测试**：手工造数（直接 SQL 插 holdings/loans/ledger + post）断言 valuation 每字段精确值；returnPct 含救济金入金口径；分页边界（before 游标、limit 上限 200）。
- [ ] **Step 2-4: RED→实现→GREEN**
- [ ] **Step 5: Commit** — `feat: canonical valuation and portfolio/query endpoints`

---

### Task 4: 下单域（校验/冻结/幂等/撤单）——不含撮合

**Files:**
- Create: `server/src/trading/orders.ts`, `server/src/api/trading.ts`
- Modify: `server/src/api/app.ts`
- Test: `server/test/trading/orders.test.ts`

**Interfaces (Produces):**
```ts
// orders.ts —— 全部在一个 db.transaction 内执行
export function placeOrder(db: DB, cfg: Config, engineDay: number, engineTick: number,
    phase: Phase, userId: number, req: PlaceOrderInput): { orderId: number; reused: boolean };
// 校验顺序与错误码（AppError）：
//  PHASE_CLOSED: phase 为 settlement，或 tickInDay∈[0..58]/[1160..1178]（竞价累积区可挂限价，撮合在 clear tick；
//                拒绝区间仅结算窗）——即：竞价+连续均可挂 L 单；M 单仅连续竞价（竞价期 M → MARKET_IN_AUCTION）
//  UNKNOWN_STOCK / STOCK_HALTED（status='delisted' 或 listed_day>day）
//  BAD_QTY: qty≤0；买入 qty%100≠0；卖出 qty>qty_sellable → INSUFFICIENT_POSITION
//  BAD_PRICE(L 单): price∉[limit_down,limit_up]
//  INSUFFICIENT_CASH(买):
//    L: freeze = price*qty + commission(price*qty) + transferFee(price*qty)
//    M: base = ceil(quote.price*(1+cfg.trading.marketBufferPct))*qty，freeze = base + commission(base)+transferFee(base)
//  幂等：UNIQUE(user_id,client_key) 冲突 → 返回既有 orderId, reused=true（不重复冻结）
//  写 orders(day=engineDay, created_tick=engineTick+1) —— 关键：created_tick 是"下一个未处理 tick"，由调用方传入 engine.lastTick+1
//  买单冻结走 post(FREEZE: user A→F)，orders.frozen=冻结额；卖单 holdings.qty_sellable -= qty
export function cancelOrder(db: DB, userId: number, orderId: number): void;
// 仅本人 open 单（NOT_FOUND/NOT_CANCELLABLE）；买：释放剩余 frozen（F→A）；卖：qty_sellable += 未成交部分；status='cancelled'
export function releaseOrderRemainder(db: DB, order, day, tick): void;  // 完结/过期共用的冻结释放原语（撮合 T5、日终 T6 复用）
// api/trading.ts：POST /api/orders（zod→placeOrder，传 engine.lastTick+1）；DELETE /api/orders/:id
```

- [ ] **Step 1: 失败测试**：每条校验一个用例（精确错误码）；冻结额精确断言（含最低佣金 5 元档）；幂等重放同 body 返回同 id 不双冻结；撤单释放额=冻结−已用；卖挂减 sellable、撤单还原。
- [ ] **Step 2-4: RED→实现→GREEN**
- [ ] **Step 5: Commit** — `feat: order placement/cancel domain with freezing and idempotency`

---

### Task 5: PlayerMatcher —— 连续竞价撮合、滑点、钉板队列、FlowProvider、引擎异常恢复

**Files:**
- Create: `server/src/trading/matcher.ts`
- Modify: `server/src/engine/engine.ts`（仅两处：①`advanceOne` 外层 catch：异常时从最近 `engine_state` 快照重建内存态（regime/rngPricing/drift）再抛出；②无其他改动）
- Test: `server/test/trading/matcher.test.ts`

**Interfaces (Produces):**
```ts
export class PlayerMatcher implements OrderMatcher, FlowProvider {
  constructor(deps: { db: DB; cfg: Config; masterSeed: number });
  onContinuousTick(ctx: TickCtx): void; onAuctionClear(ctx: TickCtx, kind): void; onDayEnd(ctx: TickCtx): void;
  netFlow(code: string): number;                       // 返回上一 tick 净成交股数（buy−sell）
  onFill(cb: (fill: FillEvent) => void): () => void;   // WS 推送用；FillEvent{userId,orderId,code,side,price,qty,fees,day,tick,orderStatus}
}
```
**行为契约（撮合核心，逐条实现）**：
1. **RNG**：独立流 `fromSeed(masterSeed, day, 'matching')`；其序列化状态存 `config['matcher_rng']`，上一 tick 净流存 `config['matcher_flow']`（JSON {code:qty}），两者随撮合同一事务更新（引擎 tick 事务内）；日切换（首次 onContinuousTick 的 day≠存量 day）时重建流。`ctx.rng` 禁用。
2. **顺序**：股票按 code 升序；单一股票内待撮合单按（买单价高优先/卖单价低优先，同价 created_tick 早优先，再同则 id 小优先）；市价单视为最优价。仅处理 `created_tick ≤ ctx.globalTick` 的 open 单（未来单跳过——补跑安全）。
3. **成交价**：以 ctx.quotes 的现价 p 为对手价。限价买成交当 `p ≤ order.price`，成交价=p；卖对称。市价单立即以 `pExec = clamp(round(p×(1±slip)), limit_down..limit_up)` 全量成交，`slip = cfg.trading.slippageK × √(qty/max(1,adv))`（buy 取 +，sell 取 −）。
4. **钉板**：`p == limit_up` 时买方向（含市价买）不即时成交而排队：每 tick 对队首至多一单，抽 `u=rng.next()`，`u < boardFillProb` 则部分成交 `fillQty = max(100, round(qty×(r0 + u×(r1−r0)))//100×100)`（r0/r1=boardFillRatio；卖出零股单不足 100 全量），否则本 tick 不成交；`p == limit_down` 卖方向对称。非钉板恢复正常规则。抽签只在存在排队单时发生（次数=DB 状态决定，补跑一致）。
5. **清算腿（每笔 fill 一个 posting，Σ=0）**：
   买：`amount=pExec×qty`, `comm=commission(amount)`, `tf=transferFee(amount)`；legs: user F −(amount+comm+tf) / MARKET A +amount / CLEARING A +(comm+tf)，kind 'TRADE_BUY'（ref=trade id）。holdings: qty_total+=qty（sellable 不加，T+1）、cost_total+=amount+comm+tf。
   卖：`stamp=stampTax(amount)` 额外；legs: MARKET A −amount / user A +(amount−comm−tf−stamp) / CLEARING A +(comm+tf) / TAX A +stamp，kind 'TRADE_SELL'。holdings: qty_total−=qty、cost_total−=roundHalfUpDiv(cost_total×qty, qty_total_before)（0 股清零）。
   trades 行记 price/qty/commission/stamp/transfer。
6. **完结释放**：买单 filled==qty 时调 `releaseOrderRemainder` 退回剩余冻结（F→A, kind 'UNFREEZE'）；部分成交继续挂。
7. **netFlow**：撮合过程累计本 tick Σ(买股数−卖股数)/code；tick 结束写入 `matcher_flow`；`netFlow()` 读的是**存量**（即上一 tick 值，因定价先于撮合）。
8. **onAuctionClear/onDayEnd 本任务占位为空**（T6 实现），但方法必须存在。
9. **引擎恢复**：engine.ts 的 catch 恢复逻辑 + 测试（人为让 hook 抛错→内存态与库一致仍可继续推进）。

- [ ] **Step 1: 失败测试**（用真实 Engine + PlayerMatcher，小步 catchUpTo 驱动；固定 seed）：
  限价买挂高于现价→当 tick 成交且成交价=现价；限价卖对称；市价买滑点=公式值（手算断言）；钉板：把某股 drift 推到涨停后挂市价买→若干 tick 内部分成交且每笔 qty 是 100 的倍数、来源于 matching 流（两次同 seed 运行 fills 完全一致）；费用与 ledger 每腿精确断言（含最低佣金）；买后当日 sellable 不增；netFlow 时滞：本 tick 大买单使**下一** tick 价格显著上移（对比无成交基线）；补跑一致性：跑 2 日含玩家订单→中断重启补跑→trades/ledger/holdings 全表 dump 相等；引擎 catch 恢复测试。
- [ ] **Step 2-4: RED→实现→GREEN**（性能：撮合查询走 `idx_orders_open`，每 tick 无订单时零开销——先 `SELECT EXISTS`）
- [ ] **Step 5: Commit** — `feat: player order matching with slippage, limit-board queue, flow feedback`

---

### Task 6: 集合竞价参与 + 日终过期/T+1 解冻

**Files:**
- Modify: `server/src/trading/matcher.ts`
- Test: `server/test/trading/auction.test.ts`

**契约**：`onAuctionClear(ctx, kind)`：以 ctx.quotes 现价（引擎竞价 tick 刚定出的开/收盘价）为统一成交价 p；所有 `created_tick ≤ globalTick` 的 open 限价单中，买价 ≥p 与卖价 ≤p 者按时间优先在 p 全量/部分成交（NPC 对手无限量——玩家体量小，接受）；清算腿同 T5。`onDayEnd(ctx)`：全部 open 单 status='expired' 并释放（买退冻结、卖还 sellable）；然后 `UPDATE holdings SET qty_sellable = qty_total WHERE qty_total > 0`（T+1 解冻，含当日买入）。**注意顺序**：onDayEnd 在结算第 1 步执行（引擎既定），早于分红/退市——退市回收按 qty_total 不受影响。

- [ ] **Step 1: 失败测试**：开盘竞价前挂单→tick59 统一价成交；不跨价单存活到连续竞价；收盘竞价后剩单日终 expired 且冻结/性质全还原；今日买入次日可卖（跨结算驱动断言 sellable）；ledger 审计恒零。
- [ ] **Step 2-4: RED→实现→GREEN**
- [ ] **Step 5: Commit** — `feat: auction participation and day-end expiry with T+1 unfreeze`

---

### Task 7: bootstrap 装配 + WebSocket

**Files:**
- Create: `server/src/index.ts`, `server/src/api/ws.ts`
- Modify: `server/src/api/app.ts`（注册 ws 插件与路由）、`server/package.json`（"dev": "tsx watch src/index.ts", "start": "node dist/index.js" 占位——构建在计划 C）
- Test: `server/test/api/ws.test.ts`

**契约**：
- `index.ts`：env `DATABASE_PATH`(默认 `./data/game.db`)、`GENESIS_TS`(必填数字，缺省=首次启动写入 config 后固定)、`MASTER_SEED`(同上固定)、`PORT`(8080)、`ADMIN_USER`/`ADMIN_PASSWORD`(启动时 upsert 管理员：无则建、有则置 is_admin=1)、`NODE_ENV`。流程：openDb→构造 PlayerMatcher/hooks(T8/T9 注入，本任务空数组)→Engine→**分块补跑**（每次 ≤1 日，循环至追平，打印进度）→engine.start()→buildApp→listen→SIGINT/SIGTERM 优雅退出（engine.stop→app.close→db.close）。
- `ws.ts`：`GET /ws`（会话鉴权，未登录 4401 关闭）。服务端维护 `Set<socket>`+每 socket 订阅集；`engine.onTick(ctx)` 节流为**每 2 tick 推一次**：`{t:'tick', day, tickInDay, phase, quotes:[[code,price,chgPct(相对 prev_close, 保留2位),volume],…仅订阅集]}`＋恒推 `IDX:COMP` 现值；matcher.onFill → 对应 userId 的 sockets 推 `{t:'fill',…FillEvent}`；结算 tick 推 `{t:'settled', day}`；新闻：onTick 时查本 tick news 行推 `{t:'news', {id,scope,target,title}}`。客户端→服务端仅 `{t:'sub', codes: string[]}`（≤50 个，替换式）。
- app.inject 不便测 ws：测试用真实 listen（端口 0）+ `ws` 客户端（devDependency `ws` + `@types/ws`）。

- [x] **Step 1: 失败测试**：登录拿 cookie→连 /ws→sub 两只股→收到含两股与 IDX:COMP 的 tick 消息；未登录连→4401；挂单成交→收到自己的 fill（别人收不到：开两个用户两条连接断言隔离）；伪造 sub 51 只→错误消息不崩。
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat: server bootstrap with chunked catch-up and websocket hub`

---

### Task 8: 信誉 + 贷款（含强平/破产结算钩子）

**Files:**
- Create: `server/src/domain/credit.ts`, `server/src/domain/loans.ts`, `server/src/api/bank.ts`
- Modify: `server/src/api/app.ts`、`server/src/index.ts`（注入 LoanSettlementHook）
- Test: `server/test/domain/loans.test.ts`

**Interfaces (Produces):**
```ts
// credit.ts
export function applyCreditEvent(db, userId, delta, reason, day): number; // clamp[cfg.credit.min,max] 写 credit_events+users.credit，返回新分
export function shiftCredit(db, userId, day): void; // reason='SHIFT' 近20日计数<shiftCapPer20d 才 +1
// loans.ts
export function loanProducts(cfg, score): Array<{termDays; rateE6; capCents}> // score<500 → []
export function borrow(db, cfg, engine, userId, amount, termDays): number;   // 门槛：分数≥500、无 overdue/grace 逾期贷、amount≤档位剩余额度、
//   未偿本息+amount ≤ 净资产×score/leverageDivisor（净资产=valuation.totalAssets，取借款前）；BANK→user 放款；loans 行(status active, due_day=day+term)
export function repay(db, cfg, engine, userId, loanId, amount): { interestPaid; principalPaid; closed };
//   先冲 accrued_interest 再冲本金；全清→status='repaid'＋credit(+15 按期 / +20 提前：day<due_day)；user→BANK
export class LoanSettlementHook implements SettlementHook { constructor(deps: { cfg; matcherFillPath: 'direct' }) }
//   onSettlement(ctx)（每交易日）：对每笔 active/grace/overdue 贷：
//   ①计息 rate=rate_e6×(status!=='active'?penaltyMult:1)；accrued+=roundHalfUpDiv(outstanding×rate,1e6)
//   ②状态推进：day>due_day→grace；day>due_day+graceDays→overdue（每日 applyCreditEvent(-8,'OVERDUE')）
//   ③day≥due_day+graceDays+liqOverdueDay→强平：持仓按市值降序逐只以现价×(1∓slip同市价单公式)全量卖出
//     （直接清算，不走订单簿；费用/印花照收；ledger 同 TRADE_SELL 腿），偿还所有该用户逾期贷（先息后本），
//     applyCreditEvent(-80,'FORCED_LIQ')；④清仓后现金仍不足偿付全部未偿本息→破产：现金全额 user→BANK 冲抵，
//     其余贷款 status='forgiven'；持仓已空；bankrupt_count+=1；credit 置 bankruptcyScore（写事件 'BANKRUPTCY'）；
//     MARKET→user 发 reliefCash（kind 'RELIEF'）；该用户所有 open 订单强制 cancelled 并释放。
// api/bank.ts：GET /api/bank/products（按我的分数）; POST /api/bank/loans; POST /api/bank/loans/:id/repay;
//   GET /api/bank/loans（含实时应还=outstanding+accrued）; GET /api/credit（分数+近 50 条事件）
```

- [x] **Step 1: 失败测试**（Engine 驱动日推进）：借款门槛矩阵（分数档/杠杆/逾期在身）；日息计提精确（含罚息×2）；grace→overdue 转换日精确；逾期第 10 日强平：卖出顺序/滑点/费用/ledger 全断言；强平后足额→贷款清、信誉 −80；不足额→破产全流程（现金冲抵、豁免、2 万救济、分数 400、开放单撤销、bankrupt_count）；按期/提前还款信誉 +15/+20；还款先息后本数值断言。
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat: credit engine and loans with grace/overdue/liquidation/bankruptcy`

---

### Task 9: 打工与能力（排班/课程/惰性结转）

**Files:**
- Create: `server/src/domain/work.ts`, `server/src/api/work.ts`
- Modify: `server/src/api/app.ts`（路由 + 全局 preHandler：登录用户先 `processDueForUser`）、`server/src/index.ts`（注入 WorkSettlementHook）
- Test: `server/test/domain/work.test.ts`

**契约**：
- 时间基：`gmin = clock.gameMinuteAbs(now)`（引擎 GameClock 暴露；测试注入 now）。班次时长 `shiftGameHours×60=480 gmin`；课程 `(level+1)×courseHoursPerLevel×60 gmin`。
- `busyUntil(db,userId)`: max(end_gmin of scheduled/working shifts, active enrollments)（无则 0）。
- `scheduleShift(db,cfg,clock,now,userId,jobId)`: 资格（reqs 全满足 + min_credit）；`start=max(gmin(now), busyUntil)`；**当日班次上限**：start 所在游戏日（`floor(start/1440)+1`）已有班次数（scheduled/working/done，按 start_gmin 归日）≥ shiftsPerDay → 429 SHIFT_CAP；插 shifts(status 'scheduled')。开始后（gmin≥start）不可取消。
- `enrollCourse(db,cfg,clock,now,userId,ability)`: level<maxLevel；费用 `roundHalfUpDiv(coursePriceBase×round(coursePriceMult**level×1e6),1e6)`——**改**：为免浮点误差，费用查表在 config 生成一次（`coursePriceBase×1.6^n` 四舍五入到分，n=0..9，T1 的 DEFAULTS 直接写十个字面量：[500_000, 800_000, 1_280_000, 2_048_000, 3_276_800, 5_242_880, 8_388_608, 13_421_773, 21_474_836, 34_359_738]）；扣费 user→EMPLOYER（kind 'COURSE_FEE'）；插 enrollments（start=max(now,busyUntil)）。
- `processDueForUser(db,cfg,clock,now,userId)`（幂等，API preHandler 调用）与 `WorkSettlementHook.onSettlement`（对全体用户调用，now=结算时刻）：
  到点班次（gmin≥end）→ status 'done'、`pay = base_pay×(1+wageBonusPerPoint×Σmax(0,level−req))` 四舍五入到分、EMPLOYER→user（kind 'WAGE', ref=shift id）、`shiftCredit`；到点课程→ status 'done'、abilities level+1。中间态（gmin≥start 且 <end）→ 'working'。
- API：GET /api/jobs（含资格布尔）; POST /api/shifts; DELETE /api/shifts/:id（仅 scheduled 且未开始）; GET /api/shifts?limit; GET /api/work/status（busyUntil/当前活动）; GET /api/abilities; POST /api/courses/enroll。`/api/me` 的 busy 字段接通。

- [x] **Step 1: 失败测试**：工资公式向量（外卖骑手 FIT4 → 1500×1.1=1650 元=165_000 分；基金经理满级 FIN10/EDU8 → 15000×(1+0.05×(1+1))=16500 元）；资格/信誉门槛拒绝；班次排队衔接（busyUntil 链）；**当日 2 班上限**（第 3 班 429，次日游戏日可再排）；课程费用表精确 10 值与总和——用 `expect(sum).toBe(90_792_635)`（= 十个字面量之和，¥907,926.35，对应规格"约 ¥90.8 万"）；惰性结转与结算钩子等价（同一时刻两路径结果一致、幂等不双发）；取消规则。
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat: jobs, shifts, abilities and courses with lazy accrual`

---

### Task 10: 行情/新闻/排行/公告 API + 管理后台

**Files:**
- Create: `server/src/api/market.ts`, `server/src/api/admin.ts`
- Modify: `server/src/api/app.ts`、`server/src/index.ts`（ADMIN_USER upsert 已在 T7，此处只挂路由）
- Test: `server/test/api/market-admin.test.ts`

**契约**：
- market.ts：`GET /api/market/overview`（IDX:COMP 现值+今日涨跌%、20 板块今日涨跌%（板块内个股按现价/prev_close 简单平均）、涨跌家数、成交额合计、涨幅/跌幅前 5）；`GET /api/stocks`（全列表：code/name/sector/board/price/chgPct/volume/turnover/status/st）；`GET /api/stocks/:code`（quote+最近 8 期财报+近 10 条分红+该股近 20 条新闻+基本面 eps/pe）；`GET /api/stocks/:code/candles?type=day|tick`（day: 全量日K；tick: 当日分时数组）；`GET /api/news?limit&before`；`GET /api/announcements`；`GET /api/leaderboard?by=total|return`（全体非系统用户 valuation，含 username/bankrupt_count/totalAssets/returnPct，排序取前 100；总资产并列按 id）。
- admin.ts（preHandler: is_admin，否则 403 FORBIDDEN；全部操作写 admin_logs{admin_id,action,detail}）：`GET /api/admin/users?q=`（模糊搜用户 + valuation 摘要）；`POST /api/admin/users/:id/reset-password {newPassword}`（argon2 重哈希 + 踢全部会话）；`POST /api/admin/users/:id/ban|unban`（ban 踢会话；banned 用户登录 403 BANNED，会话中间件拦截）；`POST /api/admin/announce {content}`；`GET /api/admin/engine`（day/tickInDay/lastTick/延迟秒=（now−genesis−lastTick×3s)）；`GET /api/admin/audit`（auditGlobal+全体 auditUser+对账摘要 JSON）；`GET /api/admin/config` / `PUT /api/admin/config {key,value}`（白名单键：trading.*/credit.*/loans.tiers/work.*——写 config 表 override 并热合并到进程 cfg（深合并后重建 cfg 对象引用，engine/matcher 持有的 cfg 通过 getter 间接读——**简化裁定**：cfg 对象用 `Object.assign` 原位变更顶层节点，各持有方即时可见）；`GET /api/admin/backups` + `GET /api/admin/backups/:file`（sendFile，仅 dataDir/backups 白名单文件名 `day-\d+.db`）。
- 注册流程补一刀：banned 状态检查加进会话中间件（T2 文件小改）。

- [x] **Step 1: 失败测试**：非管理员 403；重置密码后旧密码失效新密码可登录且旧会话被踢；封禁后被踢且不能再登录；公告玩家可见；config 白名单外键 400、白名单键改后 cfg 生效（改 shiftsPerDay 后第 3 班立即被拒）；audit 端点全绿；leaderboard 排序与破产标记；overview 字段完整性 smoke。
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat: market/news/leaderboard endpoints and admin console api`

---

### Task 11: 随机操作守恒压测 + API 全链路集成 + soak 脚本

**Files:**
- Create: `server/test/property/random-ops.test.ts`, `server/test/api/integration.test.ts`, `server/scripts/soak.ts`
- Test: 即上

**契约**：
- `random-ops.test.ts`（**150 游戏日**，timeout 480_000）：seeded 驱动器（复用 core/rng，流 'ops'）：8 用户注册；每游戏日推进 1 日（chunked catchUpTo），日间执行 30 个随机操作：下单（合法区间随机价量，30% 市价）、撤单、借款、还款、排班、报课，非法操作（超杠杆借款、超卖、涨停外价格）显式期待 AppError 且状态不变；**每 10 日断言不变量**：①全体用户 auditUser；②auditGlobal===0；③holdings 全非负且 sellable≤total；④Σ open 买单 frozen === users.cash_frozen（逐用户）；⑤orders.filled≤qty、done 单 filled==qty；⑥全体 valuation.totalAssets ≥ 0 不 NaN。结束再断言一次 + trades↔ledger 逐笔勾稽抽样 20 笔。
- `integration.test.ts`：单用户全旅程（注册→行情→限价买→等成交→查持仓→次日卖→借款→打工→报课→还款→排行→登出），全程 app.inject + engine 小步推进，每步断言业务字段。
- `scripts/soak.ts`：与 random-ops 同驱动器但 `--days 1000 --users 12`，结束打印不变量核对与运行时长（配 `npm run soak`）。**本任务验证要求**：实际执行一次 `npm run soak -- --days 1000`（约 20-35 分钟）并把摘要贴进报告——这是规格 §16(2) 的"≥1000 游戏日"证据。
- [x] **Step 1: 失败测试** → **Step 2-4: RED→实现→GREEN**（先 150 日绿，再跑 soak 1000 日）
- [x] **Step 5: Commit** — `test: random-ops conservation property suite, api journey, 1000-day soak`

> **与规格冲突的裁定（规格优先）**：本契约的不变量 ⑥ 写作 `valuation.totalAssets ≥ 0`，
> 但规格 §9 的杠杆约束只在**放款时**检查（未偿本息 ≤ 净资产 × 信誉分/300），持仓亏损后
> 净资产转负是"强平后资不抵债 → 破产"的正常前置态，唯一强制降杠杆路径是
> `due_day + 3 宽限 + 10 逾期` 的强平日。因此该不变量已按规格改为
> **「现金非负 + 估值非 NaN + 强平链条收敛」**（负净资产不再视为违规）。
> 此冲突由 150 日随机压测首跑暴露（day 50 用户净资产 −2,399,647 分，账实完全自洽）。

**规格 §16(2)「≥1000 游戏日」证据**（`npm run soak -- --days 1000 --users 12`，耗时 34m35s）：

```
soak summary: days=1000 users=12
  orders accepted=3626 rejected=9798
  borrows accepted=324 rejected=6529 repays=1043
  shifts=6717 courses=529 trades=2404
  liquidated loans=256 bankruptcies=2
  audit failures=0 invariant failures=0
  stocks alive=50 delisted=0
  ledger rows=43940 orders=4272 trades=2404
```

> 该长跑暴露并已修复两个生产缺陷：① `WorkSettlementHook` 用真实墙钟当结算时刻，
> 导致引擎补跑后所有排队班次/课程被判定"已到点"而瞬间全部发薪/结业
> （曾出现 `ledger.day≈5740` 的越界记录）；② 净资产为负时
> `borrow` 把负数送进 `roundHalfUpDiv` 抛 "bad dividend"（500/进程崩溃）。
> 详见 commit `c179163`。

---

### Task 12: 收尾加固与回归

**Files:**
- Create: `.gitattributes`（`* text=auto eol=lf`）、`server/README.md`（本地起服/环境变量/soak 说明，30 行内）
- Modify: 按本计划各审查轮遗留的 deferred-minor 清单逐条落实或明确记录不做（在 README 附"已知限制"节）
- Test: 全量回归

- [x] **Step 1**: 逐条处理台账 deferred minors（能一行修的修，决定不修的写进 README 已知限制）
- [x] **Step 2**: `npm test` 全绿三连跑（防 flake 回归）+ `npm run simulate -- --days 30` 冒烟
- [x] **Step 3: Commit** — `chore: hardening pass, gitattributes, server readme`

---

## Self-Review 结论（写计划时已执行）

1. **规格覆盖**：§5 全部规则（T4/T5/T6）、§7（T2）、§8（T8）、§9（T8）、§10（T9）、§12 REST/WS（T3/T7/T10）、§15（T10）、§16(2)(4)（T11）。§12 错误码表以 AppError code 落地（各任务枚举）。未覆盖且属计划 C：静态托管、Docker、部署。
2. **占位符扫描**：无 TBD；T9 课程费用总和断言给出显式核对程序；所有"占位为空"均在后续任务号内闭合（T5⑧→T6）。
3. **类型一致性**：PlaceOrderSchema(T1)↔placeOrder(T4)↔matcher 读 orders(T5)；FillEvent(T5)↔ws(T7)；valuation(T3)↔borrow 杠杆(T8)↔leaderboard(T10)；gameMinuteAbs(计划A)↔work(T9)。created_tick=lastTick+1 约定 T4 产、T5 消，一致。

## 执行注意

- T5 是本计划灵魂：撮合的每一次 RNG 消耗都必须由"库内可见状态"唯一决定；审查重点盯补跑一致性测试。
- 引擎文件除 T5 指定的 catch 恢复外**不得改动**；`ctx.rng` 全计划禁用。
- 发现规格与计划冲突：规格优先，commit message 注明。
