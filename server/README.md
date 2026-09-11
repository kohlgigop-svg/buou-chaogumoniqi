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

## 已知限制

1. **引擎在结算窗内不实时落盘**：结算 tick 处于单个 SQLite 事务中，崩溃时整体回滚并重放，故保证一致性但不保证"已推送的中间态"可恢复。
2. **`/api/admin/config` 的 value 未做逐键类型校验**：仅白名单前缀（`trading.`/`credit.`/`loans.`/`work.`）约束，写入值类型由运维自担；错误类型会在下次读取时暴露。
3. **强平取价使用当日 tick 快照**（`ctx.quotes`）并以 `limit_down` 兜底；停牌/退市股在强平日无法卖出，持仓保留至可交易时。
4. **备份为单文件 `day-N.db`（`VACUUM INTO`）**，无异地/增量；`/api/admin/backups` 仅列出与下载。
5. **规格 §4.4「竞价当轮挂单净需求影响统一价」尚未实现**（V1 验收前需补齐）。
6. **单进程单写者**：引擎 tick 与 HTTP 请求共享同一 SQLite 连接，勿多实例指向同一库文件。
