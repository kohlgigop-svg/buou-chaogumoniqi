# 计划 C：前端 SPA + 生产构建 + Zeabur 部署

> 继计划 A（行情引擎）、计划 B（玩家系统，Task 1–12 已全部完成）之后的最后一个大块。
> 规格：`docs/superpowers/specs/2026-08-28-paper-trader-design.md`（§11 前端信息架构、
> §12 API/WS 概要、§17 部署与运维、§18 验收标准）。
>
> **规格优先**：发现规格与计划冲突时以规格为准，并在 commit message 注明。

## 前置事实（开工前务必复核）

- 计划 B 结束时基线：**31 文件 / 258 项测试全绿**，`tsc --noEmit` 通过，
  `server/README.md` 记录了 6 条已知限制。
- 工作目录固定 `.worktrees/plan-b`。测试必须用系统 Node 24（ABI 137）：
  `PATH="/c/Program Files/nodejs:$PATH" ./node_modules/.bin/vitest run`。
- `web/` 目前**不存在**；npm workspaces 已在根 `package.json` 声明 `["shared","server","web"]`，
  故创建 `web/package.json` 后需重跑 `npm install` 建立 workspace 链接。
- 选型裁定：**Vite + React + TypeScript + react-router-dom + lightweight-charts，手写 CSS**
  （CSS 变量做设计令牌，不用 Tailwind / 组件库，保持依赖最小、包体最小）。
- 规格 §3：前端构建产物由 Fastify 同源托管，**无 CORS**；SPA 用 history 路由需 fallback 到 `index.html`。

## 既有 API 契约（前端必须按此写，勿臆造字段）

REST 均为 `/api` 前缀 + 会话 Cookie 鉴权。已实现的响应形状（以服务端为准）：

| 端点 | 关键字段 |
|---|---|
| `POST /auth/register` `{username,password}` | `{user:{id,username,...}}` + `Set-Cookie sid`；注册限流按 IP（每日 5） |
| `POST /auth/login` `{username,password}` | 同上；封禁账号 → 403 `BANNED`；连续失败锁定 `loginLockN/Max` |
| `POST /auth/logout` / `GET /me` | `/me` → `{user, valuation, positions, work, todayPnl}`；<br>`todayPnl = {positionPnl, cashFlow, total}`（当日盈亏，分）= 持仓当日浮盈（用 `prev_close`）+ 当日 A 桶现金净流 |
| `GET /market/overview` | `{index:{code,level,chgPct}, sectors:[{name,chgPct}], advancers, decliners, turnover, topGainers[], topLosers[]}` |
| `GET /stocks` | `{stocks:[{code,name,sector,board,status,st,price,chgPct,volume,turnover}]}` |
| `GET /stocks/:code` | `{quote:{code,name,sector,board,status,price,prevClose,chgPct,volume,turnover,limitUp,limitDown}, reports[], dividends[], news[], fundamental:{eps,pe}}` |
| `GET /stocks/:code/candles?type=day\|tick` | `{code,type,day?,candles:[{day,o,h,l,c,volume,turnover}]}` 或 `[{tick,price,volume}]` |
| `GET /news?limit&before` | `{items:[{id,day,tick,scope,target,typeId,title,impactE6,driftDays}], nextBefore}` |
| `GET /announcements` | `{items:[{id,day,content,createdAt}]}` |
| `POST /orders` `{code,side,type,price?,qty,clientKey}` | `{orderId,reused}` |
| `DELETE /orders/:id` | 204 |
| `GET /orders\|trades\|ledger?limit&before` | `{items[], nextBefore}` |
| `GET /bank/products` | `{credit, creditLow, products:[{termDays,rateE6,capCents}]}` |
| `POST /bank/loans` `{amount,termDays}` | `{loanId, loans[]}`；`POST /bank/loans/:id/repay` `{amount}` → `{interestPaid,principalPaid,closed,loans[]}` |
| `GET /bank/loans` | `{credit, loans:[{id,principal,outstanding,accruedInterest,rateE6,termDays,startDay,dueDay,status}]}` |
| `GET /credit` | `{credit, events:[{day,delta,reason,scoreAfter}]}` |
| `GET /jobs` | `{jobs:[{id,name,basePay,minCredit,reqs,eligible,wage}]}` |
| `POST /shifts` `{jobId}` | `{shiftId, shifts[]}`；`DELETE /shifts/:id` → 204；`GET /shifts` → `{shifts[]}` |
| `GET /work/status` | `{busyUntil, shift, course}` |
| `GET /abilities` | `{abilities:{EDU,CODE,FIN,FIT,COMM,DESIGN}, kinds[], nextCourseCost:{...}}` |
| `POST /courses/enroll` `{ability}` | `{enrollmentId, abilities}` |
| `GET /leaderboard?by=total\|return` | `{by, rows:[{username,totalAssets,returnPct,bankruptCount,bankrupt}]}` |
| 管理 `/admin/*` | 见计划 B Task 10；`GET /admin/config` → `{config,overrides}`；`PUT` 需 `{key,value}`（白名单前缀） |
| `GET /healthz` | 无鉴权，用于容器健康检查 |

**WebSocket `/ws`**（Cookie 鉴权；未登录 `close 4401`，封禁 `4403`）：

- ↑ `{t:'sub', codes:[...]}` —— **替换式**订阅；空数组/不订阅时回退「会话持仓」。
- ↓ `{t:'tick', day, tickInDay, phase, quotes:[[code, price, chgBp, volume], ...]}`
  首元素恒为 `['IDX:COMP', 10000+avgBp, avgBp, vol]`（**注意是基点，10000 = 平盘**，
  不是指数点位；指数点位需查 REST overview）。
- ↓ `{t:'fill', orderId, code, side, price, qty, commission, stamp, transfer, day, tick, orderStatus}`
  （**私有**，只投给下单者）
- ↓ `{t:'news', item}`、`{t:'settled', day}`、`{t:'error', code, message}`
- 推送按 `FLUSH_MS` 合并窗口批量下发；tick 快照按 `TICK_PUSH_EVERY` 抽稀（非每 tick 都推）。

**金额单位**：全链路整数「分」，前端统一用 `fmtMoney(cents)` 渲染为 `¥12,345.67`。

**错误码全集（从服务端 grep 实证，前端必须按此映射，勿臆造）**

| 域 | code | HTTP | 前端提示 |
|---|---|---|---|
| 鉴权 | `BAD_CREDENTIALS` | 401 | 用户名或密码错误 |
| 鉴权 | `UNAUTHORIZED` | 401 | 请先登录 |
| 鉴权 | `BANNED` | 403 | 账号已被封禁 |
| 鉴权 | `LOCKED` | 423 | 尝试次数过多，请稍后再试 |
| 鉴权 | `REG_LIMIT` | 429 | 今日注册名额已用完 |
| 通用 | `VALIDATION` | 400 | 输入不合法（zod 校验失败，**非 AppError**，由上表之外的分支抛出） |
| 通用 | `RATE_LIMIT` | 429 | 操作过于频繁 |
| 通用 | `HTTP_<status>` | 其他 | 网关/非 JSON 错误体的回落码（前端本地生成） |
| 通用 | `FORBIDDEN` | 403 | 无权限 |
| 通用 | `NOT_FOUND` | 404 | 资源不存在 |
| 通用 | `INTERNAL` | 500 | 服务器异常 |
| 下单 | `PHASE_CLOSED` | 400 | 结算时段不可交易 |
| 下单 | `MARKET_IN_AUCTION` | 400 | 集合竞价时段不可下市价单 |
| 下单 | `UNKNOWN_STOCK` | 404 | 标的不存在 |
| 下单 | `STOCK_HALTED` | 400 | 该股暂停交易 |
| 下单 | `BAD_QTY` | 400 | 数量非法（买入须 100 整数倍） |
| 下单 | `BAD_PRICE` | 400 | 价格超出涨跌停区间 |
| 下单 | `INSUFFICIENT_CASH` | 400 | 可用资金不足 |
| 下单 | `INSUFFICIENT_POSITION` | 400 | 可卖持仓不足 |
| 下单 | `NOT_CANCELLABLE` | 409 | 该委托不可撤销 |
| 银行 | `CREDIT_LOW` | 403 | 信誉分不足 500，暂不可借款 |
| 银行 | `LOAN_LIMIT` | 403 | 超出授信额度 |
| 银行 | `LEVERAGE` | 403 | 超出杠杆上限 / 净资产非正 |
| 银行 | `OVERDUE_EXISTS` | 403 | 存在逾期贷款，不可再借 |
| 银行 | `BAD_TERM` | 400 | 期限须为 20/60/120 天 |
| 银行 | `BAD_AMOUNT` | 400 | 金额非法 |
| 银行 | `LOAN_CLOSED` | 409 | 该笔贷款已结清或已核销 |
| 银行 | `LOAN_NOT_FOUND` | 404 | 贷款不存在 |
| 打工 | `JOB_REQUIREMENT` | 403 | 能力或信誉不满足岗位要求 |
| 打工 | `SHIFT_CAP` | 429 | 今日班次已满（每游戏日 2 班） |
| 打工 | `SHIFT_STARTED` | 409 | 班次已开始，无法取消 |
| 打工 | `SHIFT_NOT_CANCELLABLE` | 409 | 该班次不可取消 |
| 打工 | `SHIFT_NOT_FOUND` | 404 | 班次不存在 |
| 打工 | `COURSE_MAX` | 400 | 该项能力已满级 |
| 打工 | `JOB_NOT_FOUND` | 404 | 职业不存在 |
| 管理 | `CONFIG_KEY` | 400 | 该配置项不可热改 |

**ledger `kind` 全集（中文标签映射，未知 kind 回落原文）**：
`GENESIS` 初始资金、`TRADE_BUY` 买入、`TRADE_SELL` 卖出、`ORDER_FREEZE` 冻结、
`ORDER_UNFREEZE` 解冻、`ORDER_RELEASE` 释放、`WAGE` 工资、`COURSE_FEE` 课程费用、
`LOAN_DRAW` 放款、`LOAN_REPAY` 还款、`LOAN_LIQ` 强平清偿、`FORCED_SELL` 强制卖出、
`RELIEF` 救济金、`BANKRUPTCY` 破产清算、`BANKRUPTCY_FORFEIT` 破产罚没、
`DIVIDEND` 分红、`DIVIDEND_TAX` 红利税、`DELIST_RECOVERY` 退市回收。

---

## Task 1: web 工作区脚手架 + API 客户端 + 会话

**Files:**
- Create: `web/package.json`、`web/vite.config.ts`、`web/tsconfig.json`、`web/index.html`、
  `web/src/main.tsx`、`web/src/App.tsx`、`web/src/api.ts`、`web/src/format.ts`、`web/src/theme.css`
- Create: `web/test/api.test.ts`、`web/test/format.test.ts`
- Modify: 根 `package.json`（加 `dev:web` / `build:web` / `test:web` 脚本）

**契约**：
- `vite.config.ts`：`server.proxy` 把 `/api` 与 `/ws`（`ws:true`）代理到 `http://localhost:8080`，
  开发期同源假象；`build.outDir = 'dist'`。
- `web/tsconfig.json` 继承 `../tsconfig.base.json`，但 **`lib` 加 `DOM`、`jsx: react-jsx`**、
  `module/moduleResolution` 改 `ESNext`/`Bundler`（浏览器端不能用 NodeNext）。
- `format.ts`（纯函数，必测）：`fmtMoney(cents)` → `¥12,345.67`（负数 `-¥1.23`）；
  `fmtPct(x)` → `+1.23%` / `-0.45%`；`fmtBp(bp)` → 基点转百分比；`fmtSigned(cents)`；
  `fmtTime(gmin)` → 游戏分钟转 `HH:MM`；`fmtQty(n)` 千分位。
- `api.ts`：单例 `request<T>(path, init)`：`credentials:'same-origin'`、JSON 编解码、
  非 2xx 解析 `{code,message}` 抛 `ApiError{code,status,message}`；
  `onUnauthorized` 回调（401 → 跳登录）；导出 `api.get/post/del` 便捷方法；
  所有端点包成有类型的函数（auth/stocks/orders/bank/work/leaderboard/admin 分组）。
- 会话：`GET /me` 成功即视为已登录；启动时探测一次。

- [x] **Step 1: 失败测试** —— `format.test.ts` 覆盖上述每个格式化函数的边界（0、负数、进位）；
  `api.test.ts` 用 `vi.stubGlobal('fetch')`：2xx 返回解析、4xx 抛 ApiError 且 code/status 正确、
  401 触发 onUnauthorized、`request` 带 `credentials`
- [x] **Step 2-4: RED→实现→GREEN**（`npm install` 建 workspace 链接）
- [x] **Step 5: Commit** — `feat(web): vite react workspace, typed api client and formatters`

**实施记录（与计划的偏差，均已实证）**：

- **vite 必须用 7.x，不能写 `^6`**。vitest 3.2.7 的传递依赖已把 vite 7.3.6 提升到根
  `node_modules`；若 `web` 再声明 `^6.3.0`，npm 会在 `web/node_modules` 装第二份 vite 6.4.3，
  导致 `@vitejs/plugin-react` 的 `Plugin` 类型与 vite 7 的实例类型不兼容（`hotUpdate` 签名冲突），
  `tsc --noEmit` 报 `TS2769`。改为 `^7.3.6` 后单副本提升，类型冲突消失。
- **`rateE6` 是「日息 e6」不是年化**。后端 `accrue = roundHalfUpDiv(outstanding * rate_e6, 1e6)`
  逐日计提，配置档位为 300–600（= 0.03%–0.06%/日）。故 `fmtRate` 输出 `0.030%/日`，
  **不得**标注为年化，否则严重误导用户对借贷成本的判断。
- **`fmtCompactMoney` 入参是「分」**，写测试时极易把它当元（我第一版就把 `123,450,000 分`
  错写成 `1234.5万`，实为 `123.5万`）。测试用例已改为带换算注释的形式。
- **服务端错误码还有一个 `VALIDATION`（400）**，来自 zod `ZodError` 分支（`app.ts` 的
  `setErrorHandler`），**不在**上文「33 个错误码」表内（该表是从 `new AppError(` 提取的）。
  前端错误映射需一并覆盖。
- 实测：`web` 38 项测试全绿、`tsc --noEmit` 干净、`vite build` 产出 260 KB（gzip 83 KB）。
- **补充函数**（计划未列但前端必需）：`fmtSignedMoney`（带符号金额，零不带符号）、
  `fmtCompactMoney`（概览卡片紧凑金额）、`fmtRate`（日息 e6）。

---

## Task 2: 设计系统 + 底部 5 Tab 骨架 + 路由

**Files:**
- Create: `web/src/theme.css`（设计令牌）、`web/src/components/TabBar.tsx`、
  `web/src/components/AppShell.tsx`、`web/src/components/Card.tsx`、
  `web/src/components/Spinner.tsx`、`web/src/components/ErrorBox.tsx`、
  `web/src/routes.tsx`、`web/src/pages/Login.tsx`、`web/src/pages/Register.tsx`
- Create: `web/test/components.test.tsx`

**契约**：
- 令牌：色板（涨红/跌绿 —— **A 股习惯：涨红跌绿**、中性灰、背景层级、涨跌底色）、
  间距阶（4/8/12/16/24）、圆角、字号阶、`env(safe-area-inset-bottom)` 适配。
- **手机优先**：断点 `@media (min-width: 768px)` 桌面放大；`max-width:560px` 居中容器。
- `TabBar`：5 项（首页/行情/生活/榜单/我的），`NavLink` 高亮当前项，固定底部，
  `padding-bottom: calc(8px + env(safe-area-inset-bottom))`。
- `AppShell`：`<Outlet/>` + `TabBar` + 顶部标题栏（含**行情延迟角标**，Task 8 接数据）。
- 路由：`/login`、`/register`、`/`（首页）、`/market`、`/market/:code`、
  `/life`、`/leaderboard`、`/me`、`/news`、`/admin`（隐藏）。
  未登录一律重定向 `/login`；`/admin` 要求 `isAdmin`，否则显示 403 页。
- 登录/注册页：表单校验与服务端错误码中文映射（见上方「错误码全集」表：
  `BAD_CREDENTIALS`→「用户名或密码错误」、`BANNED`→「账号已被封禁」、
  `LOCKED`(423)→「尝试次数过多，请稍后再试」、`REG_LIMIT`→「今日注册名额已用完」、
  `RATE_LIMIT`→「操作过于频繁」）。

- [x] **Step 1: 失败测试** —— TabBar 渲染 5 项且当前路由项带 active 类；AppShell 在未登录时
  触发重定向到 `/login`；`/admin` 对非管理员渲染 403；错误码映射函数对已知码返回中文、
  未知码回落原文
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat(web): design tokens, app shell, bottom tabs and auth pages`

**实施记录（与计划的偏差，均已实证）**：

- **新增 `web/src/errors.ts`**（计划未列）：把 33 个 AppError 码 + `VALIDATION` +
  `HTTP_<status>` 回落码映射成中文。**未知码必须回落原文、空码给通用兜底**，
  否则用户遇到未覆盖错误时只会看到一片空白。
- **新增 `web/src/session.tsx`**（计划未列）：登录态用 React Context 而非全局变量，
  理由是**测试需要脱离网络直接构造「已登录/访客/管理员」**三种态。
  `SessionProvider` 支持 `initial` 注入以跳过启动探测。
- **`SessionApi.user` 收窄**：`strict` 下 `s.status === 'authed'` 不能把 `user` 的
  `| null` 收窄掉（两者是并列字段而非判别联合）。已提供 `isAuthed(s)` 类型谓词，
  避免调用方写两遍空检查。
- **测试环境用 `test.projects`**：`environmentMatchGlobs` 在 vitest 3.2.7 已废弃并告警，
  改为 `projects` 拆 `unit`(node) / `dom`(jsdom) 两个 project。
  组件测试需 `@testing-library/react` + `jsdom` + `setup.ts`（jest-dom 匹配器）。
- **页面占位与 Tab 标签同名**：`findByText('首页')` 会命中「页面占位」与「Tab 标签」
  两个节点而报 `Found multiple elements`。断言页面内容须限定 `{ selector: '.page-placeholder' }`，
  或优先用 `{ selector: '.tabbar__label' }` 取 Tab。
- **vite 依赖缓存需手动清理**：加完测试依赖后 `vite` 启动时尝试批量删
  `web/node_modules/.vite/deps`（18 项 + 若干）被环境的安全删除护栏拦下
  （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。手动 `rm -rf` 该缓存目录后正常。
  这是环境护栏，非代码问题。
- **视觉实证**（`chrome --headless` + puppeteer-core 临时驱动，用后已卸载、未入 lockfile）：
  底部 5 Tab 高亮随路由切换正确（首页/榜单已验）、桌面 1200px 下 TabBar 被限制在
  560px 居中容器内而非满宽拉伸。截图存 `E:\布偶\outputs\_t2_*.png`。
- **⚠️ 不要在工作树根直接跑裸 `vitest run`**。根目录**没有** `vitest.config`，默认配置会
  发现 `server/` 与 `web/` 两边的测试，但对 web 的 `.test.tsx` **既不套 jsdom 也不加载
  setup 文件**，于是 15 个 DOM 测试全挂（现象具有迷惑性：看起来像回归，实为环境缺失）。
  正确做法：根 `npm test` 已改为串联两个 workspace
  （`npm run test -w server && npm run test -w web`），各自用自己的配置；
  也可用 `npm run test:server` / `npm run test:web` 单独跑。
- 实测：web **59 项测试全绿**（unit 44 + dom 15）、`tsc --noEmit` 干净、
  `vite build` 268KB（gzip 86KB）。

---

## Task 3: 首页（四卡片 + 进行中班次课程）✅ 已完成

**Files:**
- Create: `web/src/pages/Home.tsx`、`web/src/pages/homeLogic.ts`
- Create: `web/test/home.test.tsx`、`web/test/homeLogic.test.ts`
- Modify: `web/src/api.ts`（新增 `metaApi`/`HealthView`/`gminFromHealth`）、`web/src/theme.css`

**契约**：
- 数据源：`GET /me`（`valuation.totalAssets/cashAvailable/cashFrozen/positionsValue/loansOutstanding/returnPct`、
  `positions`、`work`）+ `GET /healthz`（游戏时间，用于算进度条）。
- 四卡片：**持仓市值 / 可用资金 / 负债 / 信誉分**（信誉分颜色分档：<500 红、500–699 黄、≥700 绿）。
- 进行中：`work.shift`（职业名 + 剩余时间）与 `work.course`（能力名 + 剩余时间），
  由 `work.busyUntil` 与当前游戏时间算进度条。

- [x] **Step 1: 失败测试** —— 四卡片数值由 `/me` 正确渲染（含格式化）；信誉分档位取色；
  无持仓时渲染空态而非崩溃；班次进度百分比夹在 [0,100]
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit**

### 实施记录（与计划的偏差，均已实证）

**1. 放弃了 `AssetCurve` 与 `GET /ledger` 数据源 —— 计划中的「资产曲线」不可实现。**

原计划要用 `lightweight-charts` 的 `AreaSeries` 画总资产曲线，数据由 `GET /ledger` 的
`balance_after` 重建。用只读探针（注册用户 + 排班 + 借款 + 下单）实测后确认**三条硬阻塞**：

1. **`ledger.balance_after` 是分桶余额，不是总资产。** 一笔挂单冻结会同时写两条流水：
   `bucket='F', amount=+84001` 与 `bucket='A', amount=-84001`。若只取 `A` 桶画线，
   界面会显示成「钱凭空消失了」；取 `A+F` 之和又不是总资产（不含持仓市值与负债）。
2. **`LOAN_DRAW` 会让曲线说谎。** 借款时可用现金上升（实测 `cashAvailable: 10910889`），
   画出来像盈利，而同一时刻 `totalAssets` 仍是 `10000000`、`returnPct` 仍是 `0`。
   即「画现金」与「画总资产」会给出相反的结论。
3. **新用户只有 1 条 `GENESIS` 记录**，根本没有曲线可画（本页最高频的首屏场景就是空状态）。

**裁定**：首页只呈现**当前快照 + `valuation.returnPct` 累计收益率**，不伪造历史曲线。
理由记录在 `Home.tsx` 顶部注释中，避免后续有人「顺手补上」。

**2. 「今日盈亏」当时改为「累计收益率」；Task 7 期间**改为服务端口径后已还原为「今日盈亏」**。**

原计划写「今日盈亏 = 当日末余额 − 当日首余额」，依赖 `GET /ledger`；
Task 3 期间发现 `ledger` 分页 `limit` **上限 200 且不支持按 `day` 过滤**，活跃用户一天就可能
超过 → 会**静默算错**，故当时改用 `valuation.returnPct` 显示「累计收益」（零额外请求、语义准确）。

**Task 7 收尾时用户明确要回「今日盈亏」，改成了正确做法（服务端算，不再受分页限制）：**

- 在 `server/src/domain/portfolio.ts` 新增 `todayPnl(db, userId, day)`：
  ```
  positionPnl = Σ h.qty_total × (ss.price − ss.prev_close)   // 退市按 0，与 valuation 同口径
  cashFlow    = Σ ledger.amount WHERE bucket='A' AND day=?   // 一条聚合 SQL，无分页
  total       = positionPnl + cashFlow
  ```
- `/api/me` 追加**顶层字段** `todayPnl`（不塞进 `valuation` —— 那是累计快照口径，
  两个语义不同的数字挤一个对象里迟早被误用）。
- 前端：有 `todayPnl` 时主位显示「今日 ±¥X.XX」+ 拆解脚注「持仓 … · 现金 …」，
  累计收益率降为下方脚注；无该字段时回落显示累计收益率（兼容老服务端）。
  拆解是必要的：买入成交后**现金减、持仓增**，两个数符号相反，只给总数会让人疑惑「钱去哪了」。

**已知取舍（写在代码注释里）**：`LOAN_DRAW` 会让当日现金净流为正 → **借钱那天显示为盈利**。
这是口径的固有含义（「今天口袋里多了多少钱」），不是 bug；净资产口径看 `returnPct`。

**顺带修掉一个循环导入**：`engineDay` 原定义在 `api/app.ts`，而 `app.ts` 要 import 各 route
模块，导致 `me/auth/market/domain/loans` 四处与 `app.ts` 循环依赖。靠函数提升侥幸没炸，
现已挪到 `core/clock.ts`（不依赖任何 route），`app.ts` 保留 re-export 兼容既有 import。

**3. 游戏时间由 `GET /healthz` 推导，而非本地时钟。**

进度条需要「当前游戏时间」。新增 `gminFromHealth(h)` 纯函数（`web/src/api.ts`），
**统一以 `completed = lastTick + 1` 为基数**推导 day / tickInDay：

```ts
const completed = h.lastTick + 1;
const day = Math.floor(completed / TICKS_PER_DAY) + 1;
const tickInDay = completed % TICKS_PER_DAY;
return (day - 1) * MINS_PER_DAY + Math.floor((tickInDay / TICKS_PER_DAY) * MINS_PER_DAY);
```

首版曾对 `day` 与 `tickInDay` 用不同基数，导致日界处 gmin 非单调（`lastTick=1199` 与
`1200` 会算出相邻但基数错位的值）。统一基数后经边界测试确认单调。
**口径**：1 游戏日 = 1200 tick = 1440 游戏分。

**4. 抽出了 `homeLogic.ts` 三个纯函数，便于独立测试。**

`creditTier(score)`（三档）、`shiftProgress(start, end, now)`（夹在 [0,100]，
`span <= 0` 时返回 100 而不是除零）、`fmtRemaining(remain)`（已结束 / 分钟 / 小时 / 天）。
进度条渲染为 `role="progressbar"` + `data-testid="shift-progress"`，便于断言。

**5. 视觉验证（puppeteer-core + 系统 Chrome，用后已卸载）。**

- 构造真实数据：排班 + 借款 2,000,000/60 天 + 买入 200 股 → 截图确认四卡片、
  累计收益 `0.00%`、冻结提示 `¥10,891.11`、进度条「剩余 21 小时」、5 Tab 栏均正确。
- **冻结金额已逐分独立复算**：`5443 × 200 = 1,088,600`；佣金 `max(500, 万2.5=272) = 500`；
  过户费 `万0.1 = 11`；合计 **`1,089,111`** —— 与界面显示完全一致。
- 匿名访问 `/` 正确重定向到 `/login`；320px 视口**无横向溢出**（`scrollWidth === clientWidth`）。

**6. 已知环境坑（本轮踩到，已规避）。** 临时清理 puppeteer 依赖时，
`rm -rf node_modules/@puppeteer` 被 Git Bash 路径改写 + npm 安全删除机制联手搞坏：
npm 把该目录下 **7 个 `dist/index.js` 重命名成 `index.js.DELETE.<hash>`**，
导致 `puppeteer-core` 的传递依赖（proxy-agent / pac-proxy-agent / socks-proxy-agent /
get-uri / degenerator / data-uri-to-buffer / pac-resolver）全部 `ERR_MODULE_NOT_FOUND`。
恢复方式是逐个 `mv` 回原名。**教训：在 Git Bash 下不要对含 `@` 的 node_modules 路径用
`rm -rf`；清理临时依赖优先用 `npm uninstall --no-save`，并事后 `find node_modules -name "*.DELETE.*"` 自检。**

---

## Task 4: 行情 Tab（指数 + 板块热力图 + 涨跌幅榜 + 搜索 + 新闻流）✅ 已完成

**Files:**
- Create: `web/src/pages/Market.tsx`、`web/src/pages/News.tsx`、`web/src/pages/marketLogic.ts`
- Create: `web/src/components/SectorHeatmap.tsx`、`web/src/components/StockRow.tsx`、
  `web/src/components/SearchBox.tsx`
- Create: `web/test/market.test.tsx`、`web/test/news.test.tsx`、`web/test/marketLogic.test.ts`
- Modify: `web/src/format.ts`（新增 `fmtIndex`）、`web/src/api.ts`、`web/src/theme.css`

**契约**：
- `GET /market/overview`：顶部指数卡片（点位 + 涨跌幅）、板块热力图（色阶按 `chgPct` 映射，
  涨红跌绿、深浅程度按绝对值）、涨跌家数条、成交额。
- 涨跌幅榜：`topGainers` / `topLosers` 两个可切换列表。
- 搜索：本地按 `code` 前缀 + `name`/`sector` 包含过滤 `GET /stocks` 结果（不新增后端端点）。
- 新闻流 `/news`：倒序分页（`nextBefore` 加载更多），标题 + 游戏日 + 影响标签。
- 点任意股票 → `/market/:code`。

- [x] **Step 1: 失败测试** —— 热力图色阶函数（涨/平/跌三档 + 边界 0）；涨跌家数条宽度比例；
  搜索过滤（按码前缀命中、按名包含命中、无结果空态）；新闻分页追加去重
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit**

### 实施记录（与计划的偏差，均已实证）

**1. 发现并修正了 `NewsRow.typeId` 的类型错误（真实 bug）。**

原类型写的是 `typeId?: number`，但服务端 `news.type_id` 是 **TEXT** 列
（`001_init.sql:93`），值为事件 id 字符串（`MKT_RRR_CUT` / `STK_FRAUD_EXPOSED` /
`REPORT` / `IPO` / `ST_FLAG` / `ST_DELISTED` 等）。已改为 `typeId?: string`。
这个 bug 之前没暴露是因为 Task 3 的首页不读 `typeId`；本次实现新闻流才踩出来。

**2. 新增 `fmtIndex` —— 指数点位**不能**用 `fmtMoney`（第二次踩同类坑）。**

服务端 `overview.index.level` 已经做过 `level / 100`（`market.ts:60`，DB 里
`IDX:COMP` 存的是「指数点 ×100」），所以它是**「点」不是「分」**。
若走 `fmtMoney` 会再除一次 100：实测把 `3123.45` 渲染成 **`¥31.23`**，错两位。
新增 `fmtIndex` 不除 100、不带 `¥`，并处理 `1234.999 → 1,235.00` 的进位。
**教训同 Task 1 的 cents 坑：凡拿到一个数字，先确认它的单位再选格式化函数。**

**3. 新闻分页的**边界去重是必需项**，不是优化。**

服务端用 `id < before`（`market.ts:126`）取下一批，而 `nextBefore` 返回的是**末条 id**
（`market.ts:131`），因此相邻两页在边界上**必然重复一条**。
`mergeNews` 按 id 去重后保持倒序；已用测试锁定该行为（含「第二页重复返回 id=8」用例）。

**4. 新闻分页按钮放在 `/news` 子页，行情 Tab 只展示前 20 条。**

计划原文写「新闻流 `/news`：倒序分页」时把分页能力与行情 Tab 混在一处叙述。
裁定：行情 Tab 作为概览展示 20 条 + 「查看全部」链接跳到 `/news`，
完整分页（加载更多）落在 `/news`。理由：行情 Tab 已有 5 个卡片，
再叠无限列表会让首屏过长且加载语义混乱。

**5. 热力图颜色走 CSS 变量而非 JS 拼色串。**

组件只输出 `--heat`（0..1 强度）与 tone 类（`up`/`down`/`flat`），
颜色由 CSS 的 `color-mix(in srgb, var(--heat-color) calc(var(--heat) * 72%), var(--bg-raised))`
合成。好处：亮/暗主题只需改 CSS 变量，JS 不必知道任何色值。
平盘阈值取 `1e-9`（挡浮点噪声），饱和阈值取 5%（涨跌停通常 ±10%）。

**6. `flat` 档位不谎报方向。** `advancerRatio(0, 0)` 返回 0.5 而非 0 或 1
（休市/全平时若返回 0 会被读成「全部下跌」）。

**7. 补齐 `.tag--st` 样式。** `StockRow.tsx` 引用了 `.tag--st` 但 `theme.css` 只有 `.tag`，
ST 标签会与普通标签同色。已拆分：`.tag` 中性灰，`.tag--st` 用警示橙 + 加粗
（ST 是退市风险警示，且必须与「上涨红」区分开）。

**8. 股票行/榜单链接的可点性。** 两处都用 react-router `<Link>`（SPA 客户端路由，
非整页跳转），并给名称加主色 + hover 下划线，避免「看起来是纯文本却可点」。

**测试**：web 全量 **10 文件 / 144 项全绿**（Task 4 新增 61 项：marketLogic 22 +
market 21 + news 13 + fmtIndex 5）。`tsc --noEmit` 干净，`vite build` 282 KB（gzip 90 KB）。

**视觉验证**（puppeteer-core + 系统 Chrome，用后已按正确顺序卸载）：
- 行情页：指数 `2,993.88`（格式正确，非 `¥29.93`）、20 个板块热力图、涨跌幅榜、48 只股票列表、新闻前置。
- **搜索实测**：48 只 → 输入 `6005` → 1 只（金码软件 600589）；输入 `zzz` → 0 只 +
  空态文案「没有匹配「zzz」的股票」。
- 新闻页：标题 + 第 N 日 + scope 标签 + 影响百分比；语义正确（业绩预增 `+8.42%` 红、
  合同违约 `-5.72%` 绿）。「加载更多」按钮存在且 `nextBefore=null` 时隐藏。
- 两页在 390px 视口均**无横向溢出**；控制台唯一的 404 是 `favicon.ico`（无害，Task 10 托管静态资源后消失）。
- **回归**：server 全量 **31 文件 / 258 项全绿**（本次未改动 `server/`、`shared/` 任何文件）。

---

## Task 5: 个股页（分时/日 K + 五档盘口 + 买卖面板 + 财报 + 新闻）

**Files:**
- Create: `web/src/pages/Stock.tsx`、`web/src/components/OrderPanel.tsx`、
  `web/src/components/DepthBook.tsx`、`web/src/components/CandleChart.tsx`、
  `web/src/components/FinancePanel.tsx`
- Create: `web/src/lib/fees.ts`、`web/test/fees.test.ts`、`web/test/order-panel.test.tsx`

**契约**：
- `fees.ts`（纯函数，**必须与服务端 `core/money.ts` 逐分一致**）：
  `commission(amount) = max(500, roundHalfUp(amount*25/100000))`（万 2.5，最低 500 分）、
  `stampTax(amount) = roundHalfUp(amount*5/10000)`（卖出 0.05%）、
  `transferFee(amount) = roundHalfUp(amount/100000)`（万 0.1）。
  **已实证的服务端向量（直接抄进测试）**：

  | amount（分） | commission | stampTax | transferFee |
  |---|---|---|---|
  | 15,800,000（158 元 ×100 股） | **3950** | **7900** | **158** |
  | 52,000（0.52 元 ×100 股） | **500**（最低佣金生效） | **26** | **1** |

  `roundHalfUp(n,d)` 语义：`floor(n/d)` 后余数 `r*2 >= d` 则进位；
  **契约要求 n ≥ 0 且 d > 0**（负数抛错），前端实现同样约束，避免与服务端行为分叉。
- 盘口：`GET /stocks/:code` 的 quote + 订阅 WS tick；五档由「现价 ± 最小变动」构造的
  展示层假深度（服务端暂无 L2，**明确标注为示意**，不假装是真盘口）。
- 买卖面板：限价/市价切换、价格步进（涨跌停区间内）、数量（买须 100 整数倍）、
  可买量 = `floor(可用资金 / (价+费) / 100) * 100`、可卖量 = `qty_sellable`；
  费用预估实时显示；市价单在非连续竞价相位禁用；`clientKey` 用
  `${code}-${side}-${Date.now()}-${rand}` 保证幂等重试不重复下单。
- K 线：`CandleChart` 分时（`type=tick` 折线）/ 日 K（`type=day`，蜡烛）切换。
- 财报：`reports` 近 8 期表格 + `fundamental`（eps/pe）；分红 `dividends` 近 10 条。
- 已知限制：服务端暂不做 L2 真实盘口（README 已知限制 3 已述），故盘口标注「示意深度」。

- [x] **Step 1: 失败测试** —— `fees.test.ts` 用服务端同款向量逐分比对；可买量公式边界
  （资金刚好够 100 股 / 差 1 分 / 费用最低 500 分生效）；市价单在 `auction_open` 相位被禁用；
  `clientKey` 两次点击生成不同 key 但重试同一次请求复用同 key
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat(web): stock detail with charts, order panel and fee preview`

### 实施记录（与计划的偏差，均已实证）

**测试规模**：新增 4 个测试文件共 **97 项**（`fees.test.ts` 33、`order-panel.test.tsx` 31、
`stock.test.tsx` 24、其余 9 项并入既有文件）；web 全量 **227 项全绿**，`tsc --noEmit` 零错误。

**1. `fees.ts` 与服务端逐分交叉验证（两轮，均在真实服务端上跑）**

| 轮次 | 覆盖档位 | 结果 |
|---|---|---|
| 第一轮（`_feecross.mjs`） | 最低佣金档（名义 534,900 分，佣金取 500） | **7/7 一致** |
| 第二轮（`_feecross2.mjs`） | 按比例档（`000334` 价 5,351、量 1000，名义 5,351,000，佣金 **1338**） | 服务端 `5,352,392` = 前端 `5,352,392` ✅ |

界面上再复算一次（`000334` 现价 ¥51.83、买 100 股）：
名义 518,300 + 佣金 500 + 过户费 5 = **518,805 分 = ¥5,188.05**，与页面「预计冻结」逐分一致；
卖出侧印花税 **259 分 = ¥2.59**、净收入 **517,536 分 = ¥5,175.36**，亦逐分一致。

> 交叉验证脚本用临时注册用户 + 真实下单拿 `orders.frozen` 比对。
> ⚠️ **踩坑**：服务端注册限流 **5 次/日/IP**，第二个脚本注册过多用户会 403 —— 分轮跑时要注意配额。

**2. `Stock.tsx` 的相位推导（`phaseFromHealth`）**

用 `(lastTick + 1) % 1200` 分档，与 `core/clock.ts` 的 `phaseOfTick` 同口径（必须 `+1`，
代表「将处理本单的 tick」）。已锁进测试的**四个边界**：

| lastTick | `(lastTick+1)%1200` | 相位 | 市价单 |
|---|---|---|---|
| 58 | 59 | 开盘竞价 | 禁用 |
| 59 | 60 | **连续竞价**（≥60 才不是竞价） | 可用 |
| 1159 | 1160 | 收盘竞价 | 禁用（限价可下） |
| 1189 | 1190 | 结算 | **一律禁止下单** |

`/healthz` 不可用时回落 `continuous`（不阻塞交易，失败降级而非失败关闭）。

**3. 计划外新增文件**

- `web/src/components/CandleChart.tsx` —— lightweight-charts **v5** 的 `chart.addSeries(AreaSeries|CandlestickSeries, …)`
  （**不是** v4 的 `addAreaSeries()`，用错直接抛错）。价格 ÷100 按元展示；`ResizeObserver` 自适应；
  卸载 `chart.remove()`。
- `web/test/setup.ts` —— **必须补齐 jsdom 缺失的三个浏览器 API**，否则组件测试全崩：
  `ResizeObserver`（lightweight-charts 挂载必需，缺了会 `ReferenceError` 把**整个页面**渲染带崩，
  不只是图表不显示）、`HTMLCanvasElement.prototype.getContext`、`window.matchMedia`（fancy-canvas 依赖）。

**4. 两处「不编造数据」的主动决策**

- **不展示「今开」**：服务端 `QuoteView` 只有 `prevClose`/`price`，**没有 `open`**。
  计划里原有的那个 `KeyValue` 会被写成 `q.prevClose`，等于把昨收当今开 —— 改为展示「成交量」。
- **不展示「总市值」**：`quote` 未暴露总股本，编一个数字比不显示更糟，留空待服务端补字段。

**5. 视觉验证发现并修掉的两个问题**

- **盘口配色反了**：原实现卖档用 `down`（绿）、买档用 `up`（红）。A 股惯例是「涨红跌绿」，
  卖档价高于现价应红、买档价低于现价应绿。已改正，并补 2 项测试锁死方向与档位单调性。
- **日K空态像「图坏了」**：day 1 只有一个未收盘交易日，`/candles?type=day` 正确返回空数组，
  但 lightyweight-charts 会画出一个空坐标框。改为**空数据不建图表**，直接展示
  「暂无日K数据 / 首日尚未收盘，日K需至少一个完整交易日」。分时无数据同理。

**6. 视觉验证实测数据**（`000334`，day 1 连续竞价）

- 行情头：现价 `¥51.72`、`-4.22%`（跌绿）、昨收 `¥54.00`、成交量 `27,159,230 股`、
  成交额 `14.49亿`、涨停 `¥59.40` / 跌停 `¥48.60`——**「今开」确认已不存在**。
- 分时图正常出线；日K走空态；盘口 5 卖 + 5 买（卖红买绿）；可买 `1,900 股`。
- 390px 窄屏两页均无横向溢出（`scrollWidth === clientWidth === 390`）。
- 控制台唯一 404 是 `favicon.ico`（无害）。
- 末尾「← 返回行情」链接指向 `/market`。

**7. 关于「限价单只冻结不成交」**

页面在下单成功后的提示是「委托已提交，单号 #N。**资金已冻结，等待撮合成交**」，
而不是「已成交」——因为**撮合属原计划 T5，当前服务端不下单即成交**。
这是与本项目当前实现一致的诚实表述，不是缺陷。

---

## Task 6: 生活 Tab（打工 / 能力 / 银行）✅ 已完成

**Files:**
- Create: `web/src/pages/Life.tsx`、`web/src/pages/Work.tsx`、`web/src/pages/Abilities.tsx`、
  `web/src/pages/Bank.tsx`、`web/src/components/Radar.tsx`、`web/src/components/ProgressBar.tsx`
- Create: `web/test/work-panel.test.tsx`、`web/test/bank-panel.test.tsx`

**契约**：
- 打工：`GET /jobs` 列表（`eligible=false` 置灰并显示缺口，如「需 编程≥4」）；
  排班按钮 → `POST /shifts`（`SHIFT_CAP` 429 → 提示「今日班次已满」）；
  `GET /shifts` 我的排班（`scheduled/working/done/cancelled` 徽标），
  未开始的可取消（`DELETE`）。
- 能力：`Radar` 用 SVG 手绘六维雷达图（不引图表库）；`GET /abilities` 取档位与
  `nextCourseCost`；每维显示「Lv n → n+1，费用 ¥X，耗时 (n+1)×8 游戏小时」，
  已满级显示「已满级」；报名 → `POST /courses/enroll`。
- 银行：`GET /bank/products` 档位表（期限/额度/日息，`creditLow` 时提示提额路径）；
  借款（额度与杠杆双约束的服务端错误要正确中文映射 `LOAN_LIMIT`/`LEVERAGE`/`CREDIT_LOW`/`OVERDUE_EXISTS`）；
  `GET /bank/loans` 我的贷款（剩余应还 = `outstanding + accruedInterest`、到期日、
  状态徽标，`grace`/`overdue` 红色告警并提示「逾期第 10 交易日将强制平仓」）；
  部分/全额还款；`GET /credit` 信誉流水（`delta` 带正负色）。

- [x] **Step 1: 失败测试** —— 不合格职业置灰且不触发请求；`SHIFT_CAP` 映射中文；
  雷达图 6 个顶点坐标计算（给定等级 0/5/10 的半径）；满级课程不显示报名按钮；
  贷款状态 `overdue` 渲染告警文案；还款金额超过应还时服务端截断（UI 提示实际扣款）
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat(web): life tab with jobs, skills radar and banking`

### 实施记录（与计划的偏差，均已实证）

1. **`JobRow.reqs` 是 tuple 数组不是对象。** 计划按 `{"CODE":4}` 设想，实测服务端
   `domain/work.ts` 的 `parseReqs` 返回 `[["CODE",4],["EDU",2]]`。按对象写会静默拿不到
   任何要求（`Object.entries({})` 为空 → 显示「无要求」，但按钮却是灰的）。已改为
   `reqs: [string, number][]` 并把坑写进 `api.ts` 注释。

2. **`errors.ts` 四个闸门文案被改写。** 初版 `LEVERAGE` 写成「可借额度不足」，
   与 `INSUFFICIENT_CASH` 语义混淆；`LOAN_LIMIT`「超出授信上限」也没说清「额度」。
   改为能直接指向「该去哪改」的措辞：`CREDIT_LOW`「信誉分不足，暂无法借款」、
   `OVERDUE_EXISTS`「有逾期贷款未结清，暂无法借新贷」、`LOAN_LIMIT`「超出授信额度上限」、
   `LEVERAGE`「超出杠杆上限」。`errors.test.ts` 同步更新并新增「闸门码不得回落成英文原文」用例。

3. **`loanRateLabel` 差点产出 `0.030%/日/日`。** `format.fmtRate` **已自带 `/日` 后缀**
   （`(rateE6/1e6*100).toFixed(3) + '%/日'`），故本函数直接透传、不再拼一次。
   已加断言 `expect(loanRateLabel(300)).not.toContain('/日/日')`。

4. **`remainingCredit` 必须扣「未偿本金」而非「应还总额」。** 服务端 `LOAN_LIMIT` 比较的是
   `未偿本金合计`。实测：借 20000（未偿本金 20000）后再借 35000 → 服务端返回
   `LOAN_LIMIT: exceeds credit cap 5000000`（20,000+35,000=55,000 > 50,000），确认口径。

5. **雷达图手绘 SVG，不引图表库。** 理由写在 `Radar.tsx` 顶部：① 只有 6 个固定顶点，
   图表库是纯负担；② 这个仓已被 lightweight-charts 的 jsdom 坑过一次（缺 `ResizeObserver`
   会崩整页），再引一个等于翻倍风险；③ 自绘可直接 `fill="var(--primary-dim)"` 吃设计令牌。
   几何口径（第 0 维在正上方、顺时针 60°）抽到 `lifeLogic.ts` 便于单测，
   实测 vertices 与独立复算逐点一致（误差 < 0.01px）。

6. **`GET /api/bank/loans` 与 `POST /api/bank/loans` 同路径。** 测试 stub 必须按 `method`
   分派，否则给 `borrowStatus: 403` 会让首屏的 GET 也 403，`Promise.all` 整体 reject，
   页面进错误态 —— 症状是「找不到 product-list」，极易误判为组件坏了。

7. **视觉验证抓到「要求文案重复」。** 首次截图见每行显示「需 体质≥2需 体质≥2」：
   `job__meta` 与 `job__gap` 各渲染了一次 `requirementGap(job)`。已删掉 meta 里的那份
   （保留按钮旁那份，那是可操作的位置），并加测试锁死「每行只出现一次」。

8. **实测通过的服务端口径**（真实服务端 + 真实 DB，新用户 `t6v_1`）：
   - `/api/jobs` → `reqs: [["FIT",2]]`（确认是数组）；工资 = `base × (1 + 0.05×溢出等级和)`，
     实测「外卖骑手 ￥1,500 → ￥1,950（+30.00%）」与 `FIT=8`（req 2，溢出 6）一致。
   - `/api/bank/products` → 三档均 `rateE6: 500`（0.050%/日）、`capCents: 5_000_000`。
   - 借款 20000 → 页面「可用额度」由 ¥50,000.00 变 ¥30,000.00，**扣的是未偿本金** ✅
   - `BAD_TERM`（期限非 20/60/120）→ 400 ✅

9. **视觉验证覆盖宽度**：390 / 360 / 1280px 三档，`scrollWidth === clientWidth`，零横向溢出；
   控制台唯一 404 是 `favicon.ico`。

10. **测试与类型检查**：`web` **16 文件 / 357 项全绿**，`tsc --noEmit` 零错误。
    实测命令形态（受管 Node 22 无法加载 better-sqlite3，必须用系统 Node 24）：
    ```
    PATH="/c/Program Files/nodejs:$PATH" node node_modules/vitest/vitest.mjs run --root web
    PATH="/c/Program Files/nodejs:$PATH" node node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit
    ```
    注意 `node node_modules/.bin/tsc` 会报 `SyntaxError: missing ) after argument list`
    （那是 shell 包装脚本），必须走 `typescript/bin/tsc`。

11. **本地预览链路**：`web/vite.config.ts` 的 proxy 目标是 **`http://localhost:8080`**（不是 3000），
    故服务端须 `PORT=8080 node node_modules/tsx/dist/cli.mjs server/src/index.ts`。
    另外 vite 只绑 IPv6 `[::1]`，浏览器/curl 要用 `localhost` 而非 `127.0.0.1`。

---

## Task 7: 榜单 Tab + 我的 Tab ✅ 已完成

**Files:**
- Create: `web/src/pages/Leaderboard.tsx`、`web/src/pages/Profile.tsx`、
  `web/src/pages/Orders.tsx`、`web/src/pages/Trades.tsx`、`web/src/pages/Ledger.tsx`
- Create: `web/test/tables.test.tsx`

**契约**：
- 榜单：`GET /leaderboard?by=total|return` 切换；前三名徽标；`bankrupt` 行加「已破产」标注
  （规格 §11.4）；高亮自己（按 username 匹配）。
- 我的：四个分页表格页（当日委托 / 历史成交 / 资金流水）+ 改密码 + 退出登录。
  统一 `PagedTable` 组件：`limit/before` 游标分页 + 「加载更多」。
- `ledger` 的 `kind` 映射中文标签（`GENESIS`→初始资金、`TRADE_BUY`→买入、
  `WAGE`→工资、`LOAN_DRAW`→放款、`RELIEF`→救济金、`BANKRUPTCY`→破产清算 …），
  未知 kind 回落原文。**未知 kind 必须回落而不是渲染空白**（否则新增 kind 会静默消失）。

- [x] **Step 1: 失败测试** —— 榜单切换 `by` 后重排；破产标注仅在 `bankrupt` 时出现；
  `PagedTable` 「加载更多」用 `nextBefore` 且末页后隐藏按钮；`kind` 映射已知码中文 +
  未知码回落原文；空列表渲染空态
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat(web): leaderboard and profile tabs with paged tables`

### 实施记录（与计划的偏差，均已实证）

实际新建的文件比计划多：`web/src/pages/meLogic.ts`（纯函数层）、
`web/src/components/PagedTable.tsx`（泛型组件）、`web/src/pages/Me.tsx`（子路由容器）、
`web/test/meLogic.test.ts`；并改了 `web/src/api.ts`、`web/src/routes.tsx`、
`web/src/theme.css`、`web/test/routes.test.tsx`。

1. **⚠️ `api.ts` 里两个类型字段名是错的，本轮修掉。** 先读 `db/migrations/001_init.sql`
   才发现的：`trades` 的费用列名是 **`stamp`** / **`transfer`**，**不是** `stamp_tax` /
   `transfer_fee`；`ledger` 的关联列是 **`ref_type`** / **`ref_id`**，且**根本没有 `memo` 列**。
   按错的字段名声明 TS 不会报错（`SELECT *` 返回裸行强转），但表格里会静默渲染
   `undefined`。已按建表语句重声明，并在 `tables.test.tsx` 加断言
   `expect(...).not.toContain('undefined')` 锁死。
   **实测确认**：`/api/trades` 返回
   `{"commission":500,"stamp":0,"transfer":1,...}` —— 买入 `stamp` 为 0 是对的（印花税仅卖出）。

2. **⚠️ 服务端榜单不回 `id`。** `/api/leaderboard` 的行只有
   `username / totalAssets / returnPct / bankruptCount / bankrupt`，
   所以「高亮自己」**只能按 username 匹配**，不能按 id。`bankrupt` 是服务端算好的
   布尔（`bankrupt_count > 0`），前端不要自己从 count 推。

3. **⚠️ 分页相邻两页必然重叠一条。** 服务端 `page()` 语义是
   `id < before` + `ORDER BY id DESC LIMIT n`，且 `nextBefore = 末条 id`，
   所以第二页会**再次包含**第一页的最后一条。合并结果必须**按 id 去重**，
   否则「加载更多」后会看到重复行。已在 `mergePage` 里去重并加测试。
   另外 `nextBefore !== null` **只代表「可能还有」**，不代表一定有 ——
   末页刚好取满时按钮会多出现一次，点完才知道到底了，属可接受行为。

4. **⚠️ `ledger.kind` 实际有 20 个。** 用
   `grep -rhoE "kind: '[A-Z_]+'" server/src/ | sort -u` 枚举全量：
   `BANKRUPTCY / BANKRUPTCY_FORFEIT / COMP / COURSE_FEE / DELIST_RECOVERY / DIVIDEND /
   DIVIDEND_TAX / FORCED_SELL / GENESIS / LOAN_DRAW / LOAN_LIQ / LOAN_REPAY /
   ORDER_FREEZE / ORDER_RELEASE / ORDER_UNFREEZE / RELIEF / SH / TRADE_BUY / TRADE_SELL /
   WAGE`。`meLogic.ts` 的 `LEDGER_KIND` 必须**全覆盖**（测试断言
   「服务端全部 kind 都有映射」），未知码回落原文。

5. **⚠️ `ledger` 是双桶，`balance_after` 是该桶余额而非总资产。** 实测同一笔
   `ORDER_FREEZE` 会产生两条：`bucket: 'F'` 正数、`bucket: 'A'` 负数。
   页面加「桶」列（可用/冻结）并把余额列头写成「桶余额」+ `muted` 说明，
   避免被误读成总资产。

6. **视觉验证抓到两个真实缺陷，均已修**（首轮截图 390px）：
   - **表格逐字折行**：`table-layout: auto` 下窄屏把每列压到最窄，
     「方向」表头变两行、「撤销」按钮变两行，**流水页整表崩成竖排**
     （「买入冻结」折成 4 行、日期列折成 3 行）。修复：`PagedTable` 的表格外包一层
     `.paged__scroll`（`overflow-x: auto`），并给 `th`/`td` 加 `white-space: nowrap` ——
     溢出交给横向滚动兜，而不是把内容压扁。480px 以下再降一档字号与内距。
   - **榜单底部说明不跟榜切换**：切到「收益率榜」仍写着「总资产 = 可用 + 冻结 + …」。
     修复：说明随 `by` 变化，收益率榜改为「收益率 = (总资产 − 累计入金) ÷ 累计入金」，
     并加测试锁死（断言切榜后不得再出现总资产公式）。

7. **实测通过的服务端口径**（真实服务端 + 真实 DB，用户 `t6v_1`）：
   - `/api/leaderboard?by=total` 返回 5 行，字段与上述第 2 条一致。
   - **价格笼子**：下单价超出现价 ±10% 会被拒
     （`BAD_PRICE: price out of [4623, 5651]`），
     这是为了造「未成交委托」数据时踩到的，非前端问题。
   - 卖出无持仓 → `INSUFFICIENT_POSITION: not enough sellable shares`。
   - 委托/成交/流水三个表格用真实数据渲染：委托 3 行（含「未成交」2 + 「已成交」1）、
     成交 1 行（`¥8.81 × 100`，费用列取到真值）、流水 12 行（双桶齐全）。
     页面全文搜索无 `undefined` / `NaN`，无未翻译的英文 kind。

8. **视觉验证覆盖宽度**：390 / 360 / 1280px 三档，`scrollWidth === clientWidth`，
   零横向溢出；控制台错误 **0 条**。改密码两条本地校验实测有效：
   「新密码至少 8 位」「两次输入的新密码不一致」。

9. **测试自身的教训**：`tables.test.tsx` 曾有 2 项改密码用例失败，根因是
   **测试没填 `pw-confirm`**，触发组件的「两次不一致」本地校验而没发 POST，
   被误读成组件坏了。写临时调试用例打印 `FETCH>>>` 才确认 POST 路径正确。
   **先怀疑测试，再怀疑组件。**

10. **测试与类型检查**：`web` **18 文件 / 398 项全绿**，`tsc --noEmit` 零错误，
    `vite build` 成功（506.65 kB / gzip 162.14 kB）。

---

## Task 8: WebSocket 实时接入 + 行情延迟角标 ✅ 已完成

**Files:**
- Create: `web/src/lib/ws.ts`、`web/src/lib/useQuotes.ts`、`web/src/lib/useLag.ts`
- Create: `web/src/lib/realtime.tsx`（计划未列，见实施记录 1）
- Create: `web/test/ws.test.ts`、`web/test/useQuotes.test.tsx`、`web/test/realtime.test.tsx`
- Modify: `web/src/App.tsx`、`web/src/components/AppShell.tsx`、`web/src/theme.css`、`web/src/format.ts`

**契约**：
- `ws.ts`：`connect()` 建连（URL 由 `location` 推导，`ws:`/`wss:` 自适应）；
  指数退避重连（1s→2s→4s…上限 30s，抖动 ±20%）；`4401` 不重连（跳登录）、
  `4403` 不重连（提示封禁）；心跳超时（60s 无消息）主动重连；
  `sub(codes)` 替换式订阅；消息分派到类型化回调（`tick`/`fill`/`news`/`settled`/`error`）。
- `useQuotes(codes)`：订阅并返回 `Map<code, {price,chgBp,volume}>`；
  离页自动退订。
- `useLag()`：延迟角标 —— 用 `tick` 消息的 `day/tickInDay` 与本地时钟推算
  「最近 tick 距今秒数」（规格 §17 监控要求）；> 10s 变黄、> 30s 变红。

- [x] **Step 1: 失败测试** — `websocket client with reconnect and lag indicator`
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat(web): websocket client with reconnect and lag indicator`

### 实施记录（与计划的偏差，均已实证）

**1. 新增 `web/src/lib/realtime.tsx`（Provider）—— 计划未列。**

连接必须**全局唯一**，不能每个页面各自 `createWsClient()`：

- 每页一个连接 = 每次路由切换都重连，服务端还要维护 N 份订阅集；
  浏览器对同源 WS 连接数也有限制（HTTP/1.1 通常 6 个）。
- **延迟角标挂在 `AppShell` 标题栏上、要跨页常驻**。连接若由页面持有，切页时角标
  会闪回「连接中…」。
- 测试需要注入替身：`RealtimeProvider` 支持传 `client` 跳过真实建连，
  组件测试才能不依赖 jsdom 的 WebSocket（**jsdom 不实现 WebSocket**）。
- 仅在 `status === 'authed'` 时建连 —— 未登录连上去必然被 `4401` 拒绝，
  白跑一轮重连逻辑还刷日志。

**2. ⚠️⚠️ 发现并修掉一个会直接显示错数字的单位陷阱：WS 的 `chgBp` 是「平盘 = 0」，不是「10000 = 平盘」。**

计划原文写「**注意 `chgBp` 是基点**（10000 = 平盘）」——**这半句是错的**，且
`web/src/format.ts` 里既有的 `fmtBp(bp)` 正是按「10000 = 平盘」实现的
（`(bp - 10000) / 100`）。若照计划直接用 `fmtBp` 格式化 WS 行情，
**平盘的个股会显示成 `-100.00%`**。

端到端探针（真客户端连真服务端）第一轮就抓到了这个：抓到的帧是
`["600619",158170,11,48876]`，即 `chgBp = 11` → **`0.11%`**；而按旧口径算是 `-99.89%`。

正确口径（由服务端源码 + 实测双重确认）：

| 行 | `price` | `chgBp` | 平盘时 |
|---|---|---|---|
| `IDX:COMP`（指数） | `10000 + chgBp` | 相对平盘的偏离 | `price=10000, chgBp=0` |
| 个股 | 分 | 基点偏离量本身 | `chgBp=0` |

两者数值口径其实**一致**（都是「基点偏离量，平盘 = 0」），故换算都是 `bp / 100`。
处理方式：

- `lib/useQuotes.ts` 新增 `fmtStockChgBp` / `fmtIndexChgBp`（语义标记用，实现相同）
  与 `chgTone`（0 → `flat`）；**不使用 `fmtBp`**。
- `format.ts` 的 `fmtBp` 保留但补上醒目警告：**不要用于 WS 的 `chgBp`**，
  并写明两种口径的差异与踩坑后果。该函数目前无生产调用方（仅测试），
  故属预防性修复，不是运行期回归。
- 另注：服务端在 `prevClose === 0`（首日盘前尚无昨收）时也发 `0`，
  与「平盘」不可区分 —— 是服务端口径，前端无法分辨，按平盘处理。

**3. `useQuotes` 的订阅与退订必须拆成两个 effect。**

第一版把「替换订阅」和「卸载退订」合在一个 effect 里，被自己的测试抓到行为错误：
依赖变化时 React 先跑 cleanup（发 `sub([])`）再跑新 effect（发 `sub(newCodes)`），
服务端会收到一次「清空 → 重订」的闪烁。虽然最终订阅是对的，但**生产里表现为切股瞬间丢一帧行情**。
现拆为：订阅 effect 依赖 `[source, key]`；事件订阅/退订 effect 只依赖 `[source]`。

**4. `WsClientOptions` 的定时器刻意不用 `typeof setTimeout`。**

DOM 与 Node 的定时器签名不兼容（Node 版带 `__promisify__`），注入替身时会报
一堆结构性错误（`TS2741`）。改为只声明用到的形状
`(fn: () => void, ms: number) => TimerHandle`，`TimerHandle = unknown`。

**5. `chgPct` 命名在服务端是历史包袱。** 服务端 `QuoteRow` 注释写的是
`chgPct(基点, 相对 prev_close)`——字段名叫 `Pct` 但值是「基点」。
前端类型命名统一为 `chgBp` 以免继续误导。

**6. 心跳测试的第一版是错的（教训）。** 注入 `now: () => 0` 的假时钟后，
`now() - lastMessageAt` 恒为 0，永远不超时。**心跳判据依赖时钟会走**，
故测试必须用一个可推进的假时钟（`clockMs` 变量）。首版失败时先怀疑测试而非实现——
与 Task 7 的 `pw-confirm` 教训一致。

**7. 端到端实证（真客户端 × 真服务端，25 项断言全过）。**

单元测试里的 socket 是替身，它「按我以为的服务端行为」响应；只有真连一次才能
暴露协议理解错误。探针验证了：

- 建连 / 鉴权：无 cookie → `4401`；`sid` cookie 生效。
- tick 帧：首元素恒为 `IDX:COMP`；订阅集紧随其后；`day`/`tickInDay`/`phase` 齐全；
  四元组类型正确（price 分、chgBp 基点、volume 股 均为整数）。
- **指数自洽：`price === 10000 + chgBp`**。
- 订阅是**替换式**：换订阅后旧股消失、新股出现、指数恒推。
- 错误路径：订阅 51 只 → `SUB_TOO_MANY` 且连接不断；非法 JSON → `BAD_MESSAGE` 且连接不断。
- **tick 序列单调递增**（证明 `day/tickInDay → 全局 tick` 的换算基数正确）。
- **tick 间隔恒为 2**（证明服务端 `TICK_PUSH_EVERY = 2` 的节流语义被正确理解）。
- 延迟推算：用帧到达时刻反解 `genesis`，与真实 `genesis` 差约 2.1s
  （正是 `(completed + 1) × TICK_MS` 的预期偏差）；推算延迟 8s，落在
  节流窗口（6s）之后的合理区间。

**8. 测试与类型检查**：`web` **21 文件 / 480 项全绿**（Task 8 新增 71 项：
`ws.test.ts` 45 + `useQuotes.test.tsx` 22 + `realtime.test.tsx` 11 中的 4 项归属待核），
`tsc --noEmit` 零错误，`vite build` 成功（511.20 kB / gzip 163.82 kB）。

**9. 尚未接线（留给后续 Task）**：`fill` 事件的 toast 与「把该股加入订阅」、
`/market` 与 `/market/:code` 页面改用 `useRealtimeQuotes` 取实时价。
`useFillFeed` 已在 `realtime.tsx` 中提供，但需要一个 toast 容器（Task 9 一并做）。

---

## Task 9: 管理后台 `/admin` ✅ 已完成

**Files:**
- Create: `web/src/pages/Admin.tsx`、`web/src/pages/admin/*.tsx`
- Create: `web/test/admin.test.tsx`

**契约**（对应计划 B Task 10 的端点）：
- 守卫：非 `isAdmin` → 403 页，不渲染任何管理 UI。
- 用户表：搜索、信誉分、破产次数、封禁状态；`reset-password`（弹窗输入新密码，
  成功后提示「该用户所有会话已被踢出」）、`ban`/`unban` 二次确认。
- 公告发布；引擎状态（day/tickInDay/lastTick/lagSeconds）；审计结果
  （`globalOk`/`usersOk`/`failures` 列表）；config 热改（**只允许白名单前缀
  `trading.`/`credit.`/`loans.`/`work.`**，前端先校验前缀再发请求）；
  备份列表与下载。

- [x] **Step 1: 失败测试** —— 非管理员不渲染管理 UI；config 前端前缀校验拦住
  `auth.sessionDays`（不发请求）；封禁需二次确认；审计 `failures` 非空时红字列出
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat(web): admin console`

### 实施记录

**1. 文件清单**（`web/src/`）

| 文件 | 职责 |
|---|---|
| `pages/adminLogic.ts` | 纯逻辑：白名单前缀校验、值解析（JSON 优先/回落字符串）、字节格式化、用户过滤、备份排序 |
| `pages/Admin.tsx` | 容器：**守卫在挂载子面板之前返回** + 5 个分区导航 |
| `pages/admin/UsersPanel.tsx` | 用户表 + 封禁/解封二次确认 + 重置密码弹窗 |
| `pages/admin/AnnouncePanel.tsx` | 公告发布 + 已发布列表 |
| `pages/admin/EnginePanel.tsx` | 引擎状态 4 项 + 总账审计 |
| `pages/admin/ConfigPanel.tsx` | 当前配置一览 + 单键热改 + 值类型回显 |
| `pages/admin/BackupPanel.tsx` | 备份降序列表 + 原生下载链接 |
| `components/Confirm.tsx` | `Confirm`（含 Esc/焦点管理）+ `Toast` |

**2. ⚠️ 守卫必须写在「挂载子面板之前」，这是"不发请求"的唯一正确实现方式**

子面板各自在 `useEffect` 里 `load()`。如果把权限判断写进每个子面板，它已经跑过了，
请求已经出去了，守卫就只是"事后遮掩"。所以 `Admin` 是**唯一**的守卫点，且必须在
`return` 之前短路：

```tsx
if (!isAuthed(session) || !session.user.isAdmin) {
  return <div className="page-error" data-testid="admin-forbidden">…</div>;
}
```

生产链路上 `routes.tsx` 的 `RequireAdmin` 已包住本页，`Admin` 内的守卫属于**纵深防御**
（测试直接渲染 `<Admin/>`、将来若有人挂到别处而忘了包守卫）。文案与 `RequireAdmin`
统一为「无权限访问管理后台」，避免两条路径给出两种 403。

测试用 `calls.filter(c => c.url.includes('/api/admin/')).toHaveLength(0)` 锁死这一点。

**3. ⚠️ 两条色系不能混用：「方向色」vs「语义色」**

`theme.css` 原有 `.tone-up`/`.tone-down` 是**方向色**，跟 A 股红涨绿跌走：
`tone-up` 是**红**、`tone-down` 是**绿**。拿它表达"好/坏"会语义错位 ——
给"对账失败"加 `tone-up` 虽然显示红，但名字里的 `up` 会被读成"上涨"。

故新增一组**语义色**（与涨跌方向解耦），放在同一处并加了警告注释：

```css
.tone-good    { color: var(--down);    }  /* 绿：正常、通过 */
.tone-warning { color: var(--warning); }  /* 黄：需注意 */
.tone-danger  { color: var(--up);      }  /* 红：异常、失败、封禁 */
```

审计失败列表用 `tone-danger`，封禁状态用 `tone-danger`，用户表正常态用中性 `tone-flat`
（避免满屏红绿）。

**4. `lagTone` 的档位名与 CSS 类名不同名**，必须显式映射

`lagTone()` 回 `'ok' | 'warn' | 'danger'`，而 CSS 类叫 `tone-good`/`tone-warning`/
`tone-danger` —— `ok ≠ good`。用模板串拼接会拼出 `.tone-ok`（不存在，静默无色）。
改为显式查表：

```tsx
const LAG_CLASS: Record<ReturnType<typeof lagTone>, string> = {
  ok: 'tone-good', warn: 'tone-warning', danger: 'tone-danger',
};
```

**5. tick 计数器**不要**用 `fmtQty`**

`fmtQty` 是给"股数/数量"用的（带千分位）。`lastTick`/`tickInDay` 是**递增序数**
（游标），`3,012` 这种写法会让人误以为是金额或股量。改用 `fmtTick`（裸数字），
便于直接和日志里的 tick 号对照。

**6. ⚠️⚠️ 端到端实证抓到 4 个单元测试**无法**发现的契约事实**

替身 fetch 按"我以为的服务端返回"响应，是循环论证 —— 与 Task 8 的 `chgBp` 单位错误
同源。故写了真客户端逻辑 × 真 Fastify 服务端的探针（**98 项断言全过，跑完即删**）。
其中 4 项是只有真服务端才会暴露的：

| # | 事实 | 影响与处置 |
|---|---|---|
| ① | `GET /api/admin/users` 的 `isAdmin` 是 **0/1 整数**，不是 `boolean`（`/api/auth/*`、`/api/me` 才用 `=== 1` 显式转换） | `api.ts` 的 `AdminUserRow.isAdmin` 从 `boolean` 改为 `number`；`UsersPanel` 改用 `=== 1`。测试替身同步改成 `0`/`1`，避免替身"比真服务端好说话" |
| ② | 全新库未跑 tick 时 **`lastTick === -1`**（哨兵值，不是 0） | 服务端 `((lt % 1200) + 1200) % 1200` 得 `1199`；而 JS 原生 `-1 % 1200 === -1`。**客户端绝不能自己算 `tickInDay`**，必须用服务端值 |
| ③ | **白名单只校验前缀，不校验字段存在性**：`work.noSuchField` 会**真的**写进 config | 白名单挡的是"非热改小节"，挡不住"小节内错别字"。`ConfigPanel` 的 toast 回显完整键名供自查（原本误用响应里的 `r.key`，缺字段时会打印 `undefined`，已改为回显**发送的键**）|
| ④ | **未登录 → `UNAUTHORIZED`；已登录非管理员 → `FORBIDDEN`**，两个不同码 | `errors.ts` 对 `FORBIDDEN` 有专门文案，`UNAUTHORIZED` 走全局 401 拦截（跳登录）；两者不能混为一谈 |

**7. ⚠️ 响应缺字段会把整个后台白屏 —— 4 个面板都加了字段防御**

真服务端在异常/代理场景下可能返回缺字段的体。`setUsers(r.users)` 后再
`filterUsers(users, …)` 会对 `undefined` 求值抛错，React 会**卸载整棵树**，
管理后台变成一片空白。宁可"显示空表"也不要白屏：

```tsx
setUsers(Array.isArray(r.users) ? r.users : []);
```

同类修复：`AnnouncePanel`（`r.items`）、`BackupPanel`（`r.files`）、
`ConfigPanel`（`r.config ?? {}`）、`EnginePanel`（`a.failures ?? []`）。

**这是被 `routes.test.tsx` 的一条既有断言抓出来的**：该测试的 fetch 替身对
`/api/admin/users` 落到默认 `{ok:true}`，导致 `UsersPanel` 崩掉、整页空白。

**8. Admin 是「容器 + 分区导航」，默认只挂载用户表**

刻意不一次性挂载 5 个面板：那会让首屏同时打 5 个 admin 接口（含**昂贵的全库逐用户
对账**）。故组件测试新增 `renderAdminAt(session, tabId)` 辅助，各分区测试先显式切过去。

**9. 分区导航（5 个）**：用户 / 公告 / 引擎·审计 / 配置 / 备份。
未做「admin_logs 审计日志」分区 —— 服务端已在写 `admin_logs`，但没有读取端点，
属后续可选项（需要先加 `GET /api/admin/logs`）。

**10. 测试与类型检查**：`web` **23 文件 / 546 项全绿**（Task 9 新增 59 项：
`adminLogic.test.ts` 32 + `admin.test.tsx` 27；另 `routes.test.tsx` 1 项断言从
"占位文案"改为"后台容器已挂载"）。两侧 `tsc --noEmit` 零错误。
`vite build` 成功（529.89 kB / gzip 168.90 kB）。

**11. 顺带完成 Task 8 遗留的 toast 容器**：`components/Confirm.tsx` 里的 `Toast`
（testid `admin-toast`，`tone` 为 `ok`/`error`）已可复用给 `useFillFeed` 的成交提示。

**12. 已验证但未做的取舍**：`BackupPanel` 用原生 `<a href>` 下载（几十 MB 二进制走
fetch 要先全进内存再拼 Blob，慢且要自己回收 URL），代价是**拿不到错误响应** ——
403/404 只会得到一个失败的下载。探针已确认"文件不存在时不返回 200"，
故 UI 上应保证正常路径可用，异常路径靠备份列表本身的存在性来兜。

---

## Task 10: Fastify 托管构建产物 + SPA fallback + 多阶段 Dockerfile

**Files:**
- Modify: `server/src/api/app.ts`（静态托管 + SPA fallback）、`server/src/index.ts`（注入 webDist）
- Create: `Dockerfile`、`.dockerignore`
- Create: `server/test/api/static.test.ts`

**契约**：
- **新增依赖**：`@fastify/static`（`server` 的 dependency，当前**未安装**，需 `npm install`）。
- `AppDeps.webDist?: string`：给定目录时注册 `@fastify/static`（`root: webDist`,
  `wildcard: false`，避免自己接管 `/*`）并**新增** `app.setNotFoundHandler`（当前 `app.ts`
  只有 `setErrorHandler`，无 404 处理器，属全新代码）：对非 `/api/*`、非 `/ws`、
  非 `/healthz` 的 `GET`/`HEAD` 请求 `reply.sendFile('index.html')`（SPA history 路由）；
  其余路径保持默认 JSON 404。`/api/*` 未命中必须仍返回 `{code:'NOT_FOUND'}`，
  **fallback 绝不能吞掉 `/api`** —— 必测。
- `server/src/index.ts`：把 `webDist`（默认 `../web/dist`，可由 `WEB_DIST` 环境变量覆盖）
  注入 `buildApp`；目录不存在时静默跳过（开发期只跑 API 也不报错）。
- 未提供 `webDist` 时行为完全不变（既有 258 项测试不得受影响）。
- `Dockerfile` 多阶段（规格 §17）：`node:22-bookworm-slim`；
  builder 装依赖 → `npm run build -w web` + server tsc → runner 只带
  `node_modules`（prod）+ `server/dist` + `web/dist`，非 root 用户，
  `EXPOSE 8080`，`HEALTHCHECK` 打 `/healthz`，`CMD node server/dist/index.js`。
- **`better-sqlite3` ABI 说明**：该包走 prebuilt 二进制（当前实装 12.11.1），
  `npm ci` 时会按目标 Node 大版本自动拉取对应 ABI。因此 builder 与 runner
  **必须同为 Node 22**（镜像内一致性由 Dockerfile 保证）；这不同于本机开发环境
  （本机用系统 Node 24 / ABI 137，与受管 Node 22 不兼容 —— 见 `server/README.md`）。
  若镜像内构建失败，回退方案是 builder 阶段装 `python3 make g++` 走源码编译。
- `.dockerignore` 排除 `node_modules`、`data`、`*.db`、`.git`、`web/dist`。

- [x] **Step 1: 失败测试** —— 有 webDist 时 `GET /` 返回 index.html；
  `GET /some/spa/route` 返回 index.html；`GET /api/nonexistent` 仍是 JSON 404 而非 HTML；
  `GET /healthz` 正常；无 webDist 时 `GET /` 仍是 404
- [x] **Step 2-4: RED→实现→GREEN**
- [x] **Step 5: Commit** — `feat(server): host spa build artefact and add multi-stage dockerfile`

### 实施记录（与计划的偏差，均已实证）

**测试规模**：新增 `server/test/api/static.test.ts` **13 项**；`static.test.ts` 单独 13/13 全绿、
`web` 维持 **23 文件 / 546 项全绿**；shared / server / web 三侧 `tsc --noEmit` 均零错误。

> ⚠️ **server 全量跑时有 1 项失败，但已证明是 HEAD 就存在的既有缺陷，与本 Task 无关。**
> 详见下面第 6 节 —— 这是一个被上一会话**误判为 flaky**的真实 bug，本会话用探针定位到了根因。

---

**1. ⚠️⚠️ 计划里"`start` 脚本本来就能跑"是错的 —— 它是一个从未被执行过的缺口**

计划 Task 10 只要求"托管构建产物"，没提**服务端自己**能不能以生产方式启动。
实测 `node server/dist/index.js` 当场两连崩：

| 崩溃 | 根因 | 修复 |
|---|---|---|
| `ERR_MODULE_NOT_FOUND: shared/src/schemas.js` | `@pt/shared` 是**纯 TS 源码包**（`main: src/index.ts`），而 Node 原生 ESM 加载器**不能加载 `.ts`**。开发期一直靠 vitest/tsx 的转译才没暴露 —— 也就是说根 `start` 脚本**从来没有真正跑通过**，只是从没人以生产方式起过服务。 | 给 shared 加 `tsconfig.build.json` + `build` 脚本，`exports.default` 指 `dist/index.js`，`types` 仍指源码（类型检查不必等构建产物） |
| `ENOENT: scandir .../dist/db/migrations` | `tsc` 只输出 `.js`，`.sql` 迁移**不会**被拷贝；而 `openDb` 是运行时 `readdirSync(MIG_DIR)` 读目录 | 新增 `server/scripts/copy-assets.mjs`（用 Node `cpSync`，Windows 本机与 Linux 镜像行为一致），挂在 server 的 `build` 脚本里 |

所以根 `package.json` 的 `build` 顺序**必须**是 shared → server → web，
且 `server/dist` 里必须同时有 `.js` 与 `db/migrations/*.sql`。这两条都写进 Dockerfile 注释了。

---

**2. ⚠️⚠️ Dockerfile 里 workspace 符号链接的坑：相对层级是 `../../`，不是 `../`**

`npm ci` 在 workspaces 下会建 `node_modules/@pt/shared -> <仓库根>/shared`，且是**绝对路径**软链。
绝对路径在 Docker 里恰好能存活（两阶段 `/app` 一致），**但一旦软链断掉，Node 不会报错，
而是继续向上层目录查找** —— 这是整个 Task 10 最隐蔽的一处：

| 写法 | 实际解析到 | 后果 |
|---|---|---|
| `ln -sfn ../shared`（错） | `/app/node_modules/shared`（不存在）→ 向上逃逸 | Node 一路找到宿主机 `…/shared/src/index.ts`，`exports.default` 形同虚设，报 `does not provide an export named 'ChangePasswordSchema'` —— **完全指不到根因** |
| `ln -sfn ../../shared`（对） | `/app/node_modules/@pt/../../shared` = `/app/shared` | 命中 `dist/index.js`，正常 |

启动日志实证（`import.meta.resolve`）：
- 错：`file:///E:/%E5%B8%83%E5%81%B6/paper-trader/shared/src/index.ts` ← 逃逸到宿主机
- 对：`file:///E:/%E5%B8%83%E5%81%B6/paper-trader/_runner/shared/dist/index.js`

因此 Dockerfile 的 `COPY` 之后**必须**显式重建为相对软链（`mkdir -p` + `ln -sfn`），
不能依赖"COPY 把 npm 造的绝对软链原样搬过来"。

---

**3. ⚠️ `setNotFoundHandler` 必须显式排除 `/api`、`/ws`、`/healthz`**

SPA history fallback 的直觉写法是"未命中一律回 index.html"。本项目 `/api/*` 的未命中
**必须**保持 `{code:'NOT_FOUND'}` JSON 信封 —— 否则前端 `api.ts` 拿到 HTML 会以
`Unexpected token '<'` 炸在 `JSON.parse`，报错完全指不到"URL 打错了"。

故三个排除 + **只对 `GET`/`HEAD` fallback**（POST 到不存在的路径回 index.html 毫无意义，
还会掩盖写接口打错）。这条有专门的测试锁死（`static.test.ts` 里 4 条断言）。

---

**4. 本机无 Docker，改用「本地 Node 模拟两阶段」做等价验证**

本机**没有** docker / podman，WSL 也被安全策略拦（`wsl.exe` 在程序黑名单里），
故 `docker build` 无法在本机执行。改为在 `paper-trader/_dockersim`、`_runner` 两个临时目录
**逐条复刻 Dockerfile 的每条指令**，实证结果是等价的：

| 步骤 | 模拟方式 | 结果 |
|---|---|---|
| builder 装依赖 | `npm ci`（全量，含 dev） | 290 包 ✓ |
| builder 构建 | `npm run build`（shared→server→web） | 三阶段全过，web 529.90 kB / gzip 168.90 kB ✓ |
| 裁生产依赖 | `npm prune --omit=dev` | 移除 162 包；**workspace 软链仍在**；fastify / @fastify/static / better-sqlite3 / @node-rs/argon2 / zod 全在 ✓ |
| runner 文件集 | 只拷 `package.json` + 三份 `dist` + 裁剪后 `node_modules` | 按 Dockerfile 的 COPY 清单逐个搬 ✓ |
| runner 启动 | `node server/dist/index.js` | 启动成功，日志 `listening on :8099 (serving …/web/dist)` ✓ |

端点实证（真 curl）：

| 路径 | 结果 |
|---|---|
| `/healthz` | 200 JSON `{"ok":true,"day":2,"lastTick":1208}` ✓ |
| `/` | 200 `text/html` ✓ |
| `/market`、`/admin` | 200 `text/html`（SPA fallback）✓ |
| `/api/nonexistent` | **404 `application/json` `{"code":"NOT_FOUND",...}`**（未被 fallback 吞掉）✓ |
| `/api/me` | 401 ✓ |
| `/ws` | 404 且非 HTML ✓ |
| `/assets/index-*.js` | 200，`content-length: 529898` **与磁盘字节数一致** ✓ |
| HEALTHCHECK 命令逐字执行 | `node -e "fetch(...).then(r=>process.exit(r.ok?0:1))"` 语义正确 ✓ |

---

**5. ⚠️ 勘误：计划里 `better-sqlite3` 的 ABI 说明**（重要，影响已验证结论）

计划原文说"该包走 prebuilt 二进制，`npm ci` 时会按目标 Node 大版本自动拉取对应 ABI"。
**实证不成立**：本机 `npm ci` 拉下来的是 **ABI 137（Node 24）** 的 prebuilt，
在受管 Node 22（ABI 127）下加载直接失败：

```
Error: The module '…\better_sqlite3.node' was compiled against a different Node.js version
using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127.
```

即 prebuilt **不是多份**，而是按**安装时**的 Node 大版本选定一份。结论：
- builder 与 runner 同为 `node:22-bookworm-slim` 这一条**依然必须遵守**（plan 说对了）；
- 但理由要说清：是"builder 在 Node 22 里安装 → 拉到 Node 22 的 prebuilt → runner 也是 Node 22 才匹配"，
  **不是**"Node 会自动按目标版本拉"；
- 换 Node 大版本重新 `npm ci` 是**必须**的，拷贝宿主机 `node_modules` 进镜像会 ABI 不匹配
  （这正是 `.dockerignore` 排除 `node_modules` 的另一层原因）。
- 兜底方案保持计划原样：镜像内构建失败则 builder 装 `python3 make g++` 走源码编译。

---

**6. `.dockerignore` 的两条原则**

① 镜像内会重新生成的（`node_modules`、`**/dist`）都不传 —— 否则宿主机（Windows）的产物会
盖掉 Linux 镜像里的构建输出，或把 Windows 版原生二进制带进去（= 上面那个 ABI 坑）。
② 不该进镜像的（`data`、`*.db`、`.git`、`.worktrees`、`.git-broken-backup`、`.env*`）都不传。

---

**7. ⚠️⚠️ 顺带查实一个既有缺陷（**不属本 Task 范围，未修**）：`SHIFT_CAP` 测试的假设是错的**

server 全量跑时 `test/api/market-admin.test.ts` 有 1 项稳定失败：
`config：白名单外键 400；白名单键改后热生效（shiftsPerDay=1 → 第 2 班被拒）`，
报 `expected 200 to be 429`。上一会话把它判为"测试顺序 flake"，**本会话证明这个判断是错的 ——
它是确定性失败，且根因在测试的假设，不在被测代码。**

**证据链（三步，均实证）：**

1. **失败与我的改动无关**：把 `server/src/api/app.ts` 临时还原成 `HEAD` 版本再跑，
   失败**一模一样**（`expected 200 to be 429`）。且失败涉及的三文件
   （`market-admin.test.ts` / `domain/work.ts` / `api/work.ts` / `api/admin.ts`）本会话**从未改动**
   （`git diff --stat HEAD -- <这些路径>` 为空）。
2. **失败不是 flake**：单独跑该文件，连续两次都是 `16 passed | 1 failed`，稳定复现。
3. **真根因（探针实测）**：`scheduleShift` 用
   `start = max(nowGmin, busyUntil)`，即第 2 班从第 1 班的**下班时刻**开始排。
   第 1 班占 8 游戏小时，若它跨过午夜，第 2 班的 `start` 就落在**下一个游戏日**，
   而日上限查询是 `CAST(start_gmin/1440 AS INTEGER)+1 = <当天>` —— 查的是新的一天（0 班），
   自然不触发 `SHIFT_CAP`。探针输出：

   ```
   PROBE3 shiftsPerDay = 1          ← 配置确实生效了
   PROBE3 s1 = 200  s2 = 200 undefined   ← 第 2 班没被拒
   PROBE3 shift#1 start_gmin=8274222 (day 5746) end_gmin=8274702 (day 5747) working
   PROBE3 shift#2 start_gmin=8274702 (day 5747) end_gmin=8275182 (day 5747) scheduled
   PROBE3 nowGmin = 8274222 (day 5746)
   ```

   → 第 1 班 day 5746 → 5747 跨日；第 2 班落在 day **5747**（新的一天）。
   **`shiftsPerDay=1` 完全正确，"同一天第 2 班被拒"的语义也是对的；
   错的是测试假定"连排两次必然落在同一游戏日"。**

**顺带查实的另一处（同一测试文件的隐患，亦未修）**：`applyOverride` 是**原位改写**
`DEFAULTS` 单例（`admin.ts` 的 `applyOverride` 直接把 `cfg.work.shiftsPerDay = 1` 写进去），
而测试是 `buildApp({ cfg: DEFAULTS })` 共享同一对象。探针实证：写入后
`DEFAULTS.work.shiftsPerDay` 从 `2` 变 `1`，且**下一个用例读到的仍是 `1`**
（跨用例状态泄漏）。当前该文件里这个用例恰好排在最后，所以暂时没被咬到；
但只要有人**在它后面**再加一个依赖 `shiftsPerDay` 的用例，就会莫名失败。

**建议的修法（留给后续，不在 Task 10 里做，避免混入无关改动）**：
- 测试侧：给 `buildApp` 传 `structuredClone(DEFAULTS)` 而不是共享单例；
  并把"连排两次"改成"在同一游戏日内连排"（例如断言 `s1`/`s2` 的 `start_gmin` 落在同一 day，
  或把 `shiftGameHours` 一起调小以确保不跨日）。
- 或产品侧：若"每日上限"本意是"每个**自然日**的班次"而非"每 24 小时"，
  则 `scheduleShift` 的跨日行为本身也需要重新定义（这属规格澄清，需先回规格确认）。

---

## Task 11: 本地端到端验收 + 部署到 Zeabur

**Files:**
- Create: `docs/superpowers/plans/2026-09-11-plan-c-acceptance.md`（验收记录）
- Modify: `server/README.md`（部署章节）

**契约**：
- 本地：`npm run build` 全量构建 → 起服务 → 用浏览器走完规格 §18 的验收清单
  （注册→下单成交→T+1 卖出→借款还款→打工报课→榜单→管理后台），
  并**截图留档**关键页面；确认无 CORS、WS 实时推送正常、延迟角标跳动。
- Docker：本地 `docker build` 成功并跑起来 `/healthz` 返回 200。
- Zeabur（规格 §17）：项目 + 服务、持久卷挂 `/data`、环境变量
  （`MASTER_SEED`/`GENESIS_TS`/`ADMIN_USER`/`ADMIN_PASSWORD`/`DATABASE_PATH=/data/game.db`）；
  部署后 `https://<app>.zeabur.app` 可访问；重启后持久卷数据不丢（规格 §18 第 9 条）。
- **此项需要用户提供 Zeabur 账号或授权**；无法自动完成时，产出可执行的部署清单
  与 `zeabur.json`/环境变量模板，并把待办明确交给用户。

- [x] **Step 1**: 本地全量构建 + 浏览器端到端走查 + 截图
- [x] **Step 2**: Docker 本地构建与运行验证
- [x] **Step 3**: Zeabur 部署（或产出部署清单待用户执行）
- [x] **Step 4: Commit** — `docs: plan c local acceptance and deployment runbook`

### Task 11 实施记录（2026-09-11）

**产物**：

- `docs/superpowers/plans/2026-09-11-plan-c-acceptance.md` —— 验收记录（§18 九条逐条对照、
  三轮探针结果、截图清单、部署 runbook、勘误与遗留）
- `zeabur.env.example` —— 环境变量模板（可直接粘贴进 Zeabur Variables）
- `server/README.md` —— 新增「部署与运维」章节；环境变量表补 `WEB_DIST`

**验收方式**：真实 Chrome（`--headless=new` + CDP，零依赖，Node 内置 `WebSocket`/`fetch` 直连
DevTools 协议）对**真启动的生产构建产物**发起三轮探针，共 **74/74 断言全绿**：

| 轮次 | 脚本 | 断言 | 通过 | 覆盖重点 |
|---|---|---:|---:|---|
| 1 | `_acc_cdp.mjs` | 40 | 40 | 渲染/注册登录/各页面/admin 403/WS 自洽/375px 移动端/控制台与网络审计 |
| 2 | `_acc_order.mjs` | 23 | 23 | 初始资金、GENESIS 流水、下单成交、**幂等**、报课排班、后台四分区、**总账审计**、公告、config 白名单、备份 |
| 3 | `_acc_t1.mjs` | 11 | 11 | **T+1**（`qtySellable=0` + 卖出被拒 `INSUFFICIENT_POSITION`）、`lastTick` 单调、WS 订阅替换 |

截图 19 张留档并逐张人工核验渲染正常（清单见验收文档 §4；截图与探针脚本属临时产物，
收尾时已清理未入库）。

**关键实证**：

- **T+1 双侧生效**：服务端拒绝（400 `INSUFFICIENT_POSITION`）与前端「可卖」显示 0 同时成立
  —— 只做 UI 禁用而不做服务端拒绝是不可接受的。
- **下单幂等**：同 `clientKey` 重发返回同一 `orderId` 且 `reused:true`。
- **费用向量**：`commission=500`(¥5.00) / `stamp=0` / `transfer=1`，与服务端 `core/money.ts`
  冻结向量表同源。
- **总账审计**：`{"globalOk":true,"usersOk":true,"checkedUsers":4,"failures":[]}`。
- **375px 无横向溢出**：`/market` 与 `/market/000003` 溢出均为 **0px**。

**Step 2 降级说明**：本机**无** docker/podman，且 `wsl.exe` 被安全策略列入程序黑名单
（不可申请放行），无法执行 `docker build`。改为**在 scratch 目录逐条复刻 Dockerfile 每条指令**
（`npm ci` 290 包 → `npm run build` → `npm prune --omit=dev` 移除 162 包且 workspace 软链与
运行时依赖全保留 → 严格按 COPY 清单组装 → 重建软链 → 真启动），并逐端点实测：
`/healthz` 200 JSON、`/`·`/market`·`/admin` 200 HTML、**`/api/nonexistent` 404 JSON（未被吞）**、
`/api/me` 401、`/ws` 404 非 HTML、`/assets/index-*.js` `content-length: 529898` 与磁盘一致。
镜像构建逻辑与运行时布局**功能正确**；「Docker 引擎自身能否完成构建」这一平台行为
留待真机确认（风险低）。

**Step 3 降级说明**：Zeabur 需外部账号/授权，按计划允许的降级路径产出可执行 runbook
（§5）与 `zeabur.env.example`，**待办明确交给用户**。

**验收暴露的问题**：

1. **我的探针自身写错 6 处契约**（**非应用 bug**，已全部修正）：
   `side` 应为 `'B'`（非 `'buy'`）、`type` 应为 `'M'`/`'L'`（非 `'market'`）、
   `ability` 应为 `'FIT'` 等六个大写码（非 `'physique'`）、公告发布端点是
   `POST /api/admin/announce`（**单数**）、排行榜真实 DOM 是
   `<ul data-testid="lb-list">`（非 `<table>`）、启动清理被 bulk-delete 守卫拦截。
   另注：个股路由是 **`/market/:code`**（非 `/stock/:code`）。
2. **`SHIFT_CAP` 测试跨日假设错误**（既有缺陷，**未修**，超范围）：
   上轮误判为 flaky，本轮三步证明为**确定性失败**（还原 `app.ts` 到 HEAD 后失败一模一样）。
   真根因：`scheduleShift` 的 `start = max(nowGmin, busyUntil)` 使第 2 班从第 1 班下班时刻排起，
   第 1 班跨午夜时第 2 班落进**下一个游戏日**，而日上限按 `start_gmin` 算天 → 查到 0 班 →
   不触发 `SHIFT_CAP`。实测：`shift#1` 8274222(day 5746)→8274702(day 5747)，
   `shift#2` 8274702(day 5747)。**产品行为正确，错的是测试假定「连排必然同日」**。
   建议测试侧改用 `structuredClone(DEFAULTS)` + 同游戏日内连排。
3. **`applyOverride` 原位改写 `DEFAULTS` 单例**（既有隐患，**未修**）：
   `admin.ts` 的 `applyOverride(cfg,...)` 直接改 `cfg.work.shiftsPerDay`，而测试
   `buildApp({cfg: DEFAULTS})` 共享同一对象 → 实测 `2` 变 `1` 且**下个用例仍读到 `1`**
   （跨用例泄漏）。当前该用例恰好排最后故未被咬到。建议读取时深拷贝或 `buildApp` 内
   `structuredClone`。
4. **环境假象**：运行日志 `[backup] Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`
   是沙箱删除守卫拦截备份轮转，引擎继续正常推进，**非应用缺陷**，生产环境不存在该守卫。

**遗留（不属计划 C 范围）**：规格 §4.4「竞价当轮挂单净需求影响统一价」仍待实现
（README 已知限制 5，V1 验收前需补齐）。计划 C 闭合了计划 B 六条限制中的「前端未做」与
「部署未做」两条。

---

## Self-Review 结论（写计划时已执行）

1. **规格覆盖**：§11 五个 Tab + 个股页 + `/admin` 对应 T2–T9；§12 REST/WS 契约在
   「既有 API 契约」一节逐字段固定，T1/T5/T8 依此实现；§17 部署对应 T10/T11；
   §18 验收清单对应 T11。
2. **占位符扫描**：无 TBD。唯一显式"不做"项：服务端 L2 真实盘口（规格未要求，
   T5 以"示意深度"标注并写进 README 已知限制）。
3. **类型一致性**：`fees.ts` 必须与服务端 `core/money.ts` 同向量
   （T5 Step 1 已附**实证**向量表：3950/500/7900/26/158/1）；
   WS 的 `chgBp` 基点语义在 T1 契约表、T8 实现与测试三处一致；
   `valuation` 字段名以服务端 `portfolio.ts` 为准（已核：`cashAvailable`/`cashFrozen`/
   `positionsValue`/`loansOutstanding`/`totalAssets`/`totalInflow`/`returnPct`）。
4. **已实证、非猜测的事实**（写计划时逐条 grep / 运行核对）：
   - 错误码全集（33 个）与 HTTP 状态：`grep -rho "'[A-Z_]\{4,\}'" src/api src/domain src/trading`。
     特别注意登录失败码是 **`BAD_CREDENTIALS`**、锁定是 **`LOCKED`(423)**、
     注册限流是 **`REG_LIMIT`(429)** —— 无 `LOGIN_LOCKED`/`RATE_LIMITED` 这类码。
   - `ledger.kind` 全集（18 个）来自 `grep -rho "kind: '[A-Z_]*'" src/`。
   - 费用向量来自实跑 `tsx` 调用服务端 `money.ts`。
   - `app.ts` 目前**只有** `setErrorHandler`，**没有** `setNotFoundHandler`（T10 为全新代码）。
   - `@fastify/static` **未安装**（T10 需新增依赖）。
   - `web/` 目录**不存在**，但根 `workspaces` 已声明 `web`（T1 需重跑 `npm install`）。
5. **风险点**：① `better-sqlite3` 在 Docker 里的 ABI（T10 已给回退方案）；
   ② SPA fallback 误吞 `/api`（T10 Step 1 专门覆盖）；
   ③ 前端 `tsconfig` 不能沿用 NodeNext（T1 已注明需改 `Bundler` + `DOM` + `react-jsx`）；
   ④ Zeabur 需外部账号（T11 已标注降级路径：产出部署清单交用户执行）。

## 与计划 B 的衔接

- 计划 B 的 DONE_MARKER 与 6 条已知限制：本计划把其中「前端未做」与「部署未做」两条闭合；
  「规格 §4.4 竞价当轮挂单净需求影响统一价」仍为独立待办，**不属本计划范围**。
- 不改动引擎文件；不改动计划 B 已冻结的域逻辑（除非测试暴露缺陷，届时单独提交并注明）。
