# @pt/server —— 大布偶证券交易所 · 服务端

模拟炒股游戏的权威服务端：确定性行情引擎 + 撮合 + REST/WS API + SQLite 持久化。
规格见 `docs/superpowers/specs/2026-08-28-paper-trader-design.md`。

## 本地起服

```bash
npm install                 # 在仓库根执行（npm workspaces）
npm run dev -w server       # tsx watch src/index.ts，默认 http://localhost:8080
npm run start -w server     # 需先 build（node dist/index.js）
```

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DATABASE_PATH` | SQLite 文件路径（`:memory:` 亦可） | `./data/game.db` |
| `DATA_DIR` | 每日备份根目录 | `DATABASE_PATH` 所在目录 |
| `GENESIS_TS` | 创世时刻（ISO 8601 或毫秒）；决定游戏日推进与所有时间窗 | 当前整点，持久化 |
| `MASTER_SEED` | 全局随机种子；相同种子 + 相同库状态 ⇒ 完全可重放 | 随机，持久化 |
| `PORT` | HTTP 端口 | `8080` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 启动时 upsert 管理员 | 不创建 |
| `WEB_DIST` | 前端构建产物目录；设空串可强制只跑 API | `./web/dist`（存在时自动托管） |

## 测试与压测

```bash
npm test -w server                    # tsc --noEmit && vitest run
npm run simulate -w server -- --days 30   # 离线行情冒烟：每日摘要
npm run soak -w server -- --days 1000 --users 12   # 长时守恒压测
```

`soak` 选项：`--seed`（种子）、`--ops`（每用户每日操作数）、`--report`（每 N 日输出一行）、
`--cache`（落盘 `./soak.db`）、`--keep`（保留该文件）。**任一不变量被打破即以非 0 退出**。

> ⚠️ Windows 上 `better-sqlite3` 是原生模块，须用与编译时相同的 Node ABI。
> 若受管 Node 版本与已编译二进制不匹配，请用系统 Node 运行（本仓库基线为 Node 24 / ABI 137）。

## 目录速览

- `src/core/` —— 时钟、金额（整数分）、RNG（xoshiro128\*\*，按 `seed/day/stream` 分流）、复式记账 ledger
- `src/db/` —— 打开/迁移（`migrations/*.sql`，按 `user_version` 递增）
- `src/engine/` —— tick 推进与结算（`TICK_MS=3000`、`TICKS_PER_DAY=1200`）
- `src/trading/` —— 下单、限价板队列撮合、集合竞价
- `src/domain/` —— 组合估值、信誉、贷款、打工与能力
- `src/api/` —— Fastify 路由（auth/me/trading/bank/work/market/admin/ws）

## 部署与运维

### 构建与本地运行（单进程同时托管 API 与前端）

```bash
npm install            # 仓库根
npm run build          # shared → server → web，三份 dist 一次产出
npm start              # = node server/dist/index.js，默认 http://localhost:8080
```

服务端会**按需**托管前端：`WEB_DIST`（默认 `./web/dist`）存在即挂载
`@fastify/static`，并为**非 `/api`、非 `/ws`、非 `/healthz` 的 GET/HEAD** 回落 `index.html`
（SPA 路由直刷不 404）。目录不存在时**静默跳过**，服务退化为纯 API 模式。
显式配置了 `WEB_DIST` 但目录缺失时会打印警告。

> ⚠️ 三条不可动摇的约束：① `/api/*` 的 404 **必须**仍是 JSON 错误信封
> （`{code,message}`），绝不能被 HTML fallback 吞掉；② `/ws` 与 `/healthz` 同理；
> ③ 只有 `GET`/`HEAD` 才回落。`server/test/api/static.test.ts` 对这三条逐条设防。

### Docker

多阶段构建（`node:22-bookworm-slim`）：builder 装全量依赖并构建，runner 只带
`prune --omit=dev` 后的依赖 + 三份 `dist`，以非 root 用户 `node` 运行。

```bash
docker build -t paper-trader:local .
docker run --rm -p 8080:8080 \
  -e MASTER_SEED=<长随机串> \
  -e GENESIS_TS=<ISO8601 或毫秒> \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD=<强口令> \
  -e DATABASE_PATH=/data/game.db -e DATA_DIR=/data \
  -v pt-data:/data \
  paper-trader:local
```

镜像内置 `HEALTHCHECK`（30s 间隔 / 40s 启动宽限 / 3 次重试）打 `/healthz`。

> **为什么两个阶段必须同为 Node 22**：`better-sqlite3` 的 `prebuild-install`
> 按**安装时**的 Node 大版本**只下载一份**预编译二进制（不是多 ABI 并存）。
> 本机在 Node 24 下 `npm ci` 得到 ABI 137 的 `.node`，在 Node 22（ABI 127）下加载会报
> `NODE_MODULE_VERSION 137 ... requires 127`。因此**绝不可**把宿主机的
> `node_modules` 拷进镜像，必须在镜像内重装。base 用 bookworm（glibc）而非 alpine（musl）
> 也是为拿到 glibc 版预编译二进制，免去源码编译。

> **workspace 软链层级**：`npm ci` 在 `node_modules/@pt/` 下建的是**指向仓库根的软链**。
> 镜像内重建时相对路径必须是 `../../shared`（从 `node_modules/@pt/` 退两级），
> **不是** `../shared`。写错时 Node **不会**报断链，而是向上层目录逃逸、
> 意外解析到宿主机源码，报出与根因毫不相干的导出错误。诊断利器：
> `node -e "console.log(import.meta.resolve('@pt/shared'))"`。

### Zeabur

规格 §17：项目 + 服务（Dockerfile 构建）、**持久卷挂 `/data`**、环境变量注入、
免费域名 `xxx.zeabur.app`（自动 HTTPS）、健康检查 `/healthz`。

必填环境变量：`MASTER_SEED`、`GENESIS_TS`、`ADMIN_USER`、`ADMIN_PASSWORD`、
`DATABASE_PATH=/data/game.db`、`DATA_DIR=/data`、`PORT=8080`。
`MASTER_SEED` 与 `GENESIS_TS` **上线后不要再改**（改了会与已有库状态错位）。

部署后自检：

- `https://<app>.zeabur.app/healthz` → 200，`day`/`lastTick` 随时间增长；
- 直刷 `/market` 不 404（SPA fallback 生效）；
- `/api/nonexistent` → **JSON** 404（`/api` 未被吞掉）；
- 注册新账号 → 首页 ¥100,000；
- 行情页 WS 推送正常、「延迟」角标接近 0；
- **重启不丢数据（规格 §18 第 9 条）**：记录余额 → 重启服务 → 同账号数据仍在，
  `/data` 下可见 `game.db` 与 `backups/`。

完整 runbook、逐条验收结论与遗留项见
`docs/superpowers/plans/2026-09-11-plan-c-acceptance.md`。

## 已知限制

1. **引擎在结算窗内不实时落盘**：结算 tick 处于单个 SQLite 事务中，崩溃时整体回滚并重放，故保证一致性但不保证"已推送的中间态"可恢复。
2. **`/api/admin/config` 的 value 未做逐键类型校验**：仅白名单前缀（`trading.`/`credit.`/`loans.`/`work.`）约束，写入值类型由运维自担；错误类型会在下次读取时暴露。
3. **强平取价使用当日 tick 快照**（`ctx.quotes`）并以 `limit_down` 兜底；停牌/退市股在强平日无法卖出，持仓保留至可交易时。
4. **备份为单文件 `day-N.db`（`VACUUM INTO`）**，无异地/增量；`/api/admin/backups` 仅列出与下载。
5. **规格 §4.4「竞价当轮挂单净需求影响统一价」尚未实现**（V1 验收前需补齐）。
6. **单进程单写者**：引擎 tick 与 HTTP 请求共享同一 SQLite 连接，勿多实例指向同一库文件。
