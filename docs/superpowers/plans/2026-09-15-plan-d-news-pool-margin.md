# 计划 D：新闻板块 / 股票池扩容 / 融资融券（2026-09-15）

**Goal:** 在已上线的 V1（计划 A/B/C 产物）之上完成需求方 2026-09-15 提出的三项优化：
① 增加杠杆功能；② 股票池扩到上百只；③ 把每日新闻独立成一个板块。

**Spec:** `docs/superpowers/specs/2026-08-28-paper-trader-design.md`
（本计划落地后规格新增 **§21 融资融券**；§4.1/§4.3/§6/§11/§12/§13/§14/§18/§19 与
附录 A 同步修订。计划 A/B/C 中出现的「48 只」「19 表」等数字是**当时**的状态，
不再回改，以规格与代码为准。）

**分支:** `plan-b`（worktree `E:\布偶\paper-trader\.worktrees\plan-b`）—— **不合并 master**。

---

## 1. 需求原文与判断

> 「优化以下几点：1.增加杠杆功能（你根据实际股市加杠杆那一套来设计就行）；
> 2.可以尽量多加点股市，可以有上百个；3.把每日新闻独立出来一个板块
> （我不太了解实际股市如果有新闻是否会附上这个股票的涨跌，如果有那就保留，
> 如果没有就去掉）；」

第 3 点需求方自己留了一个问号，实际查证后的判断：

- 真实行情终端（同花顺 / 东方财富 / Wind）挂在新闻旁的**不是涨跌预测**，而是
  **关联标的的实时行情快照**（该股 / 该板块 / 大盘指数当时的涨跌幅）。
- 所以「涨跌」**保留**，但换成**实际涨跌**；同时把原来的 `impact_e6` 去掉 ——
  那是模型内部的冲击强度，等于把答案印在新闻上（详见 §2）。

---

## 2. 第 1 块：新闻独立板块

**提交:** `d2d0621`（feat(news): 每日新闻升为独立板块，并把新闻旁的「预测涨幅」
换成关联标的实际涨跌）

### 2.1 为什么必须去掉 `impact_e6`

新闻在 `tick ∈ [60, 1159)` 到达，而冲击要经 `eventRelease`（instant 30% +
9 个 tick 摊释 + `driftDays` 日衰减）才释放完。原来的新闻列表直接显示 `+5.2%`，
玩家看到就知道该买什么 —— **那不是看新闻，是读答案**。

处置：`/api/news` 与 `/api/stocks/:code` 的 news 子查询**都不再 SELECT**
`impact_e6` / `drift_days`（DB 里仍存，引擎要用），只下发 `related`。

### 2.2 `related` 的三种口径

| 新闻 scope | 口径 | `code` | 前端行为 |
|---|---|---|---|
| `STK` | 该股 `chgPct` | 六位代码 | `<Link>` 可跳个股页 |
| `SEC` | 板块内 `chgPct` **简单平均** | `null` | `<span>` 不可跳 |
| `MKT` | 大盘指数涨跌 | `'IDX:COMP'` | `<Link>` 可跳行情页 |

标的已退市时 `related = null`，前端**整段不渲染**（不是显示 `—`）。

实现上 `newsRelatedLookup(db)` **一次算好 code/sector/index 三张表**再逐条查，
避免 N+1（新闻列表一次 20 条）。

### 2.3 落点

- `server/src/api/market.ts` —— 抽出 `indexLevel(db)`（overview 与新闻共用）、
  新增 `NewsRelated` 与 `newsRelatedLookup(db)`。
- `web/src/components/NewsRelatedTag.tsx`（新）—— News 页与 Market 页共用，
  `data-testid="news-related"`。
- `web/src/pages/News.tsx` 标题改「**每日新闻**」；`web/src/lib/nav.ts` 把新闻提为
  一等导航项（底部 Tab 5 → **6** 项）；`Market.tsx` 最新新闻卡片改用它；
  `Stock.tsx` 相关新闻去掉涨跌标记（整页都是同一只股，标记是噪声）。

---

## 3. 第 2 块：股票池 48 → 110

**提交:** `0ca5be6`（feat(market): 股票池 48 → 110 只（老库靠 ensureStockSeeds
幂等补齐））

- `server/src/seed/stocks.ts` 重写：**110 行 / 20 板块 / 创业板 14 只**
  （沪主板 56、深主板 40、创业板 14）。`insertSeed` 导出供 topup 复用。
- `server/src/seed/topup.ts`（新）—— `ensureStockSeeds(db, day)` 幂等补齐。
- `server/src/config/defaults.ts` —— `poolTarget: 48 → 110`、`poolMax: 50 → 115`。

### 3.1 ⚠️ 扩容必须连带修指数除数

`mcapOf('COMP')` 是**全体存活股市值之和**，`indexLevel = mcap / divisor`。
凭空多 62 只股会让综合指数从 3000 点直接顶到 **5857.9**（实测）。

- 所以 topup 在插入前后各取一次 `mcapOf(kind)`，变化了就调
  `adjustDivisorOnChange(db, kind, before, after)`（`divisor *= after / before`），
  板块 `S:<sector>` 同理。
- **bootstrap 的补齐是「流程外的成分变化」**：`settlement.ts` 第 6→9 步那套
  mcapBefore/mcapAfter 只覆盖结算过程中的变化，**覆盖不到 bootstrap 的补齐**，
  所以修除数只能由 topup 自己做。
- **负向验证**：去掉除数修正，`seed.test.ts` 恰好红一条（3000 → 5857.9）。
  恢复后全绿 ⇒ 护栏不是空转。

### 3.2 另外两个坑

- `listed_day` **不能写当天** —— `limitKindOf` 判 `forDay === listedDay` 时给 IPO
  首日档（+44% / −36%）。扩容的新股一律写 `listed_day = 1`。
- `stocks.name` 有 **UNIQUE** 约束 —— `SPARE_NAMES` 与 `STOCK_SEEDS` 重名会让
  IPO 补位建股时抛错。加行时必须两边都 grep 一遍。
- `poolTarget` **必须等于** `STOCK_SEEDS.length`：小于 → IPO 补位永久停摆；
  大于 → 一启动就凭空排一堆 IPO。

---

## 4. 第 3 块：融资融券（信用交易）

**提交:** `2af7578`（feat(margin): 融资融券（信用交易）—— 2 倍杠杆、做空、
逐日盯市与 T+1 追保强平）

规格详见 §21，此处只记**实现陷阱**（每条都有测试钉住）：

| # | 陷阱 | 不这么写的后果 |
|---|---|---|
| 1 | `matcher.onDayEnd` 的日终解冻必须改成 `qty_sellable = MAX(0, qty_total − qty_margin)` | 融资买入的股票次日被解锁成可卖 = 玩家卖掉券商的抵押品 |
| 2 | 融券保证金必须含**卖出费用**（`marginUsed = A×50% + fees`） | 开仓瞬间比例 ≈149.9% < 自己的 150% 警戒线 ⇒ 一开仓就再也开不了第二笔，而现金已见底 |
| 3 | 担保物口径 = **全部**现金与持仓，不另开「信用账户现金」桶 | `ledger.bucket` 只有 `'A'/'F'`，`auditUser` 要求 Σ ledger(A) === `users.cash_available`，凭空造桶会让勾稽失守 |
| 4 | 债务**不进 ledger**；豁免残债只改表不记账 | ledger 记现金流向、不记债权；若把豁免也记账，`auditGlobal`（Σ = 0）失衡 |
| 5 | `valuation.totalAssets` 必须扣 `marginDebt` | 融资买入让股票进 `positionsValue`，借来的钱只记在 `margin_accounts.debt` ⇒ 净资产虚高 ⇒ 银行杠杆上限虚高 ⇒ 可拿信用仓当抵押去银行套更多贷款 |
| 6 | 强平买回（`forceBuy`）**允许券商垫付**，绝不因现金不足抛错 | 抛错会让整个 tick 事务回滚、结算卡死 |
| 7 | 强平豁免残债前必须确认**仓位已全平** | 否则出现「债务清了、空头还在」的无担保敞口 |
| 8 | `marginHook` 必须排在 `settlementHooks` **最后** | 它要读本日收盘价算比例，而前面的钩子会改现金与持仓 |
| 9 | 直接成交要补 `type='M'` 系统单（`client_key` 用 `MAX(orders.id)+1`） | `trades.order_id` 是 NOT NULL；粗粒度键会撞 `UNIQUE(user_id, client_key)` |

### 4.1 关键参数（默认值）

保证金比例 50%（⇒ 2 倍）· 融资日息 0.02%/日（按本金）· 融券日费率 0.025%/日
（按市值）· 开通门槛信誉 ≥650 · 融资负债上限 信誉分 × ¥2,000/分 ·
警戒线 150%（禁开新仓）· 平仓线 130%（追保，**T+1 未补足即强平**）。

### 4.2 与 NPC 银行贷款的分工

`loans` = 无抵押信用贷，钱到手随便花，按信誉分定额度；
`margin` = **有担保的杠杆交易**，钱只能买指定标的，且随市价逐日盯市。
两者独立计额度、独立强平，但**共享同一份现金与持仓**（见陷阱 #3）。
前端也刻意分成「银行 / 借贷 / 融资」三个子页（`/life/bank`、`/life/p2p`、
`/life/margin`），因为三者的门槛、抵押与话术完全不同。

---

## 5. 验证证据

| 项 | 结果 |
|---|---|
| 服务端全量 | **434 passed / 38 files**（271.6s；Phase 3 前为 397） |
| 前端全量 | **750 passed / 31 files**（Phase 3 前为 714） |
| `tsc --noEmit` | server 干净、web 干净 |
| 融资融券专项 | server 37（域 24 + API 13）、web 35（逻辑 19 + 组件 16） |
| 负向验证 ① | 去掉 topup 的除数修正 → `seed.test.ts` 恰好红一条（3000 → 5857.9） |
| 负向验证 ② | matcher 日终解冻改回旧写法 → `margin.test.ts` 恰好红一条 |
| 线上自检脚本 | `_zb_check.mjs` 41 → **48** 项（+7 项融资融券），`node --check` 通过 |

> ⚠️ 110 只股后服务端全量要 **271.6s**，前台默认超时会 SIGTERM ——
> 必须走 `run_in_background`。

---

## 6. 未做 / 挂账

- **`leverageDivisor` 是否从 300 改成 200**（银行杠杆上限的分母）：属游戏平衡
  决策，已提请需求方，**未获批，保持 300 不变**。
- **推送与部署**：本轮三个提交（`d2d0621` / `0ca5be6` / `2af7578`）尚未推 GitHub、
  尚未部署 Zeabur；线上仍跑旧版本。
- **`TICKS_PER_DAY = 1200` 在客户端有 4 份独立拷贝**：同类隐患，已排查、未改。
- **二期候选**（规格 §19）：打新申购 → 持仓质押贷 → 成就系统 → 模拟基金 →
  实操小游戏打工 → 邮箱绑定。
