// index.ts —— 服务启动入口：环境装配 → 分块补跑 → 实时循环 → HTTP/WS 监听 → 优雅退出。
//
// 环境变量：
//   DATABASE_PATH   SQLite 文件路径（默认 ./data/game.db；`:memory:` 亦可）
//   DATA_DIR        备份目录根（默认取 DATABASE_PATH 所在目录）
//   GENESIS_TS      创世时刻（ISO 8601 字符串或毫秒数）。缺省则取"当前整点"并持久化到 config
//   MASTER_SEED     全局随机种子（整数）。缺省则随机生成并持久化到 config
//   PORT            HTTP 端口（默认 8080）
//   ADMIN_USER / ADMIN_PASSWORD  启动时 upsert 管理员账号
//   WEB_DIST        前端构建产物目录（默认 ../web/dist，相对本仓库根）。
//                   配了才托管前端；目录不存在则静默跳过（开发期只跑 API 也正常）。
//   NODE_ENV        production 时日志更严格
//
// 补跑策略：把引擎从上次停止位置追到当前时刻。为免长时间静默，按「不超过 1 个交易日」分块
// 推进并打印进度。交易完整性由引擎自身的 tick 事务保证，分块只是调度层的切片。
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hash } from '@node-rs/argon2';
import { openDb, type DB } from './db/database.js';
import { DEFAULTS, type Config } from './config/defaults.js';
import { loadOverrides } from './config/overrides.js';
import { Engine } from './engine/engine.js';
import { GameClock, TICK_MS, TICKS_PER_DAY, engineDay } from './core/clock.js';
import { PlayerMatcher } from './trading/matcher.js';
import { ensureStockSeeds } from './seed/topup.js';
import { LoanSettlementHook } from './domain/loans.js';
import { P2pSettlementHook } from './domain/p2p.js';
import { WorkSettlementHook } from './domain/work.js';
import { buildApp } from './api/app.js';

const DEFAULT_DB = './data/game.db';
const DEFAULT_PORT = 8080;
/** 前端构建产物默认位置，相对**仓库根**（进程工作目录与部署镜像里都是根）。 */
const DEFAULT_WEB_DIST = './web/dist';

/**
 * 解析前端构建产物目录。
 *
 * 返回 `undefined` 表示"不托管前端"，让 `buildApp` 完全跳过静态注册 ——
 * 这样开发期（只跑 `server` 的 `dev` 脚本、`web/dist` 还没构建）行为与改动前一致。
 * 目录存在性由 `buildApp` 再判一次（此处只做配置解析，不吞掉"配了但路径错"的诊断）。
 */
function resolveWebDist(): string | undefined {
  const raw = process.env['WEB_DIST'] ?? DEFAULT_WEB_DIST;
  if (raw.trim() === '') return undefined;
  const abs = resolve(raw);
  // 只在"用了默认值且目录不存在"时静默跳过；显式配置了却不存在则提示，避免排查困难。
  if (!existsSync(abs)) {
    if (process.env['WEB_DIST'] !== undefined) {
      console.warn(`[bootstrap] WEB_DIST="${raw}" does not exist; frontend will not be served`);
    }
    return undefined;
  }
  return abs;
}

interface Genesis { genesisMs: number; masterSeed: number }

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return Math.trunc(n);
}

/** GENESIS_TS 接受毫秒数或 ISO 8601 字符串；缺省返回 undefined，由调用方兜底。 */
function resolveGenesisMs(): number | undefined {
  const raw = process.env['GENESIS_TS'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return Math.trunc(asNum);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`GENESIS_TS is not a valid timestamp: "${raw}"`);
  return ms;
}

function readGenesis(db: DB): Genesis | null {
  const row = db.prepare(
    `SELECT
       (SELECT value FROM config WHERE key='master_seed') AS ms,
       (SELECT value FROM config WHERE key='genesis_ms') AS gm`,
  ).get() as { ms: string | null; gm: string | null };
  if (row.ms === null || row.gm === null) return null;
  return { masterSeed: Number(row.ms), genesisMs: Number(row.gm) };
}

/** 首次启动固定创世参数；已存在则以库内值为准（重启不可漂移）。 */
function ensureGenesis(db: DB, seedDefault: number, genesisDefault: number): Genesis {
  const existing = readGenesis(db);
  if (existing !== null) return existing;
  // INSERT OR IGNORE 保证并发启动时只有一份参数胜出。
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO config(key, value) VALUES ('master_seed', ?)`)
      .run(String(seedDefault));
    db.prepare(`INSERT OR IGNORE INTO config(key, value) VALUES ('genesis_ms', ?)`)
      .run(String(genesisDefault));
  })();
  const written = readGenesis(db);
  if (written === null) throw new Error('failed to persist genesis params');
  return written;
}

/** 启动时 upsert 管理员：无则建，有则提升为管理员并重置密码。 */
async function upsertAdmin(db: DB, username: string, password: string): Promise<void> {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as
    { id: number } | undefined;
  const pwdHash = await hash(password);
  if (existing === undefined) {
    db.prepare(`INSERT INTO users(username, pwd_hash, kind, is_admin, created_day, created_at)
      VALUES (?,?, 'user', 1, 1, unixepoch())`).run(username, pwdHash);
    console.log(`[bootstrap] created admin "${username}"`);
    return;
  }
  db.prepare("UPDATE users SET is_admin = 1, pwd_hash = ?, status = 'active' WHERE id = ?")
    .run(pwdHash, existing.id);
  console.log(`[bootstrap] promoted existing user "${username}" to admin`);
}

/** 分块补跑：每块不超过一个交易日，逐块打印进度。 */
function catchUpChunked(engine: Engine, clock: GameClock, nowMs: number): number {
  const target = clock.globalTick(nowMs);
  let total = 0;
  for (;;) {
    const cur = (engine as unknown as { lastTick: number }).lastTick;
    if (cur >= target) break;
    const chunk = Math.min(target, cur + TICKS_PER_DAY);
    // catchUpTo 以「毫秒时刻」表达目标：目标 tick 恰好可推进到的时刻为 genesisMs + (chunk+1)*TICK_MS。
    total += engine.catchUpTo(clock.genesisMs + (chunk + 1) * TICK_MS);
    const reached = (engine as unknown as { lastTick: number }).lastTick;
    console.log(`[catchup] tick ${reached}/${target} (day ${clock.dayOfTick(reached)})`);
  }
  return total;
}

async function main(): Promise<void> {
  const dbPath = process.env['DATABASE_PATH'] ?? DEFAULT_DB;
  const dataDir = process.env['DATA_DIR'] ?? (dbPath === ':memory:' ? '.' : dirname(dbPath));
  const port = envInt('PORT', DEFAULT_PORT);
  const cfg: Config = DEFAULTS;

  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const db = openDb(dbPath);
  // 缺省创世取"当前整点"，便于同一环境重复启动时保持稳定。
  const genesisDefault = resolveGenesisMs() ?? Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const seedDefault = envInt('MASTER_SEED', Math.floor(Math.random() * 0x7fffffff));
  const { genesisMs, masterSeed } = ensureGenesis(db, seedDefault, genesisDefault);

  // ⚠️ 把 config 表里的热改 override 恢复进 cfg。
  // 不做这一步，热改就只是「改内存」—— 进程一重启（含每次重新部署）全部退回默认值。
  // 线上实测过：`auth.ipRegPerDay` 热改成 25，重启后又变回 20。
  const appliedOverrides = loadOverrides(db, cfg);
  if (appliedOverrides.length > 0) {
    console.log(`[bootstrap] 已恢复 ${appliedOverrides.length} 条热改配置: ${appliedOverrides.join(', ')}`);
  }

  // ⚠️ 把种子表里「库里还没有」的股票补齐（老库扩容）。必须在 Engine 之前跑：
  // 引擎恢复后立刻 catch-up，新股的 tick 行情要跟着一起补。
  // 幂等；内部会修正指数除数，避免点位跳变（见 seed/topup.ts 的注释）。
  const topped = ensureStockSeeds(db, engineDay(db));
  if (topped.added > 0) {
    console.log(`[bootstrap] 股票池扩容：新增 ${topped.added} 只（指数除数已同步修正）`);
  }

  // 撮合器既是 OrderMatcher（引擎驱动）也是 FlowProvider（定价读取上一 tick 净流）。
  const matcher = new PlayerMatcher({ db, cfg, masterSeed });
  // 计划 B 结算钩子：贷款计息/宽限/逾期/强平/破产 + 打工/课程到点结转 + 玩家间借贷到期扣款。
  const loanHook = new LoanSettlementHook({ db, cfg });
  const workHook = new WorkSettlementHook({ db, cfg, clock: new GameClock(genesisMs) });
  const p2pHook = new P2pSettlementHook({ db, cfg });
  const engine = new Engine({ db, cfg, masterSeed, genesisMs, dataDir,
    matcher, flow: matcher,
    // 事务回滚后引擎内存态会从行内快照重建；撮合器内存态同样必须回到落库状态，否则会发散。
    onTickError: (): void => matcher.resetMemory(),
    // 顺序有意义：loanHook 先跑，破产结算会把该用户的 NPC 债务豁免并置 credit=basis；
    // p2pHook 后跑，据此把该用户的 P2P 借据一并置 forgiven（出借方承担损失）。
    settlementHooks: [loanHook, workHook, p2pHook],
  });

  const clock = new GameClock(genesisMs);
  console.log(`[bootstrap] db=${dbPath} genesis=${new Date(genesisMs).toISOString()} seed=${masterSeed}`);
  // 补跑在实时循环之前完成：历史 tick 不触发 WS 推送，避免客户端被回放刷屏。
  const moved = catchUpChunked(engine, clock, Date.now());
  console.log(`[bootstrap] catch-up done, advanced ${moved} ticks`);
  engine.start();

  if (process.env['ADMIN_USER'] !== undefined && process.env['ADMIN_PASSWORD'] !== undefined) {
    await upsertAdmin(db, process.env['ADMIN_USER'], process.env['ADMIN_PASSWORD']);
  }

  const webDist = resolveWebDist();
  const app = await buildApp({ db, cfg, engine, matcher, dataDir, webDist });
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[bootstrap] listening on :${port}`
    + (webDist === undefined ? ' (api only)' : ` (serving ${webDist})`));

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`[shutdown] ${signal} received`);
    engine.stop();
    try { await app.close(); } catch (e) { console.error('[shutdown] app close failed', e); }
    try { db.close(); } catch (e) { console.error('[shutdown] db close failed', e); }
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { void shutdown(sig); });
  }
}

void main().catch((e: unknown) => {
  console.error('[fatal]', e);
  process.exit(1);
});
