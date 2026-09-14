// api/admin.ts —— 管理后台（preHandler: requireAdmin，非管理员 403）：
// 用户检索/重置密码/封禁解封、公告发布、引擎状态、总账审计、config 热更新、备份列表与下载。
// 所有写操作记入 admin_logs。
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { readdirSync, createReadStream, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { hash } from '@node-rs/argon2';
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';
import { AppError, engineDay } from './app.js';
import { valuation } from '../domain/portfolio.js';
import { auditGlobal, auditUser } from '../core/ledger.js';
import { TICK_MS, TICKS_PER_DAY } from '../core/clock.js';

export interface AdminDeps { db: DB; cfg: Config; now: () => number; dataDir?: string }

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });
const SearchSchema = z.object({ q: z.string().max(32).optional() });
const ResetPwdSchema = z.object({ newPassword: z.string().min(8).max(72) });
const AnnounceSchema = z.object({ content: z.string().min(1).max(500) });
const ConfigPutSchema = z.object({ key: z.string().min(1), value: z.unknown() });
const BackupFileSchema = z.object({ file: z.string().regex(/^day-\d+\.db$/) });

/** 前缀白名单（带点号，避免 `tradingX` 这类误匹配）。 */
const CONFIG_WHITELIST = ['trading.', 'credit.', 'loans.', 'work.', 'p2p.'];
/**
 * 精确键白名单（全等匹配）。
 *
 * 为什么不直接往上面加 `'auth.ipRegPerDay'`：白名单是 `startsWith` 匹配，
 * 那样会派生放行 `auth.ipRegPerDayX` 这类不存在的键；而 `applyOverride` 对未知
 * 路径是**静默 return**（不报错），于是接口返回「写入成功」但配置毫无变化。
 * 故精确键单独判断。
 */
const CONFIG_WHITELIST_EXACT = [
  'auth.ipRegPerDay',
  // 玩家价格冲击的两个键是**顶层**（不在 trading.* 下），故必须走精确键表。
  // 这两个值是「玩家能不能推动盘面」的总开关，运营中调它俩比调 trading.* 更常用。
  'playerImpactLambda',
  'playerImpactCap',
];

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db, cfg, now, dataDir } = deps;

  // 管理员守卫：非 is_admin → 403
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.requireAuth(req, reply);
    if (!req.user.isAdmin) throw new AppError('FORBIDDEN', 403, 'admin only');
  };

  const log = (adminId: number, action: string, detail: unknown): void => {
    db.prepare('INSERT INTO admin_logs(admin_id, action, detail) VALUES (?,?,?)')
      .run(adminId, action, JSON.stringify(detail));
  };

  /** 用户检索 + 估值摘要。 */
  app.get('/api/admin/users', { preHandler: requireAdmin }, async (req) => {
    const { q } = SearchSchema.parse(req.query);
    const rows = db.prepare(`SELECT id, username, credit, status, is_admin isAdmin,
        bankrupt_count bankruptCount, created_day createdDay FROM users WHERE kind = 'user'
        ${q !== undefined ? 'AND username LIKE ?' : ''} ORDER BY id LIMIT 200`)
      .all(...(q !== undefined ? [`%${q}%`] : [])) as { id: number }[];
    return { users: rows.map(r => ({ ...r, valuation: valuation(db, (r as { id: number }).id) })) };
  });

  /** 重置密码：argon2 重哈希 + 踢全部会话。 */
  app.post('/api/admin/users/:id/reset-password', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const { newPassword } = ResetPwdSchema.parse(req.body);
    const target = db.prepare("SELECT id FROM users WHERE id = ? AND kind = 'user'").get(id);
    if (target === undefined) throw new AppError('NOT_FOUND', 404, 'user not found');
    const pwdHash = await hash(newPassword);
    db.transaction(() => {
      db.prepare('UPDATE users SET pwd_hash = ? WHERE id = ?').run(pwdHash, id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      log(req.user.id, 'RESET_PASSWORD', { userId: id });
    })();
    return { ok: true };
  });

  /** 封禁：置 status='banned' + 踢全部会话（登录与会话中间件都会拒绝）。 */
  app.post('/api/admin/users/:id/ban', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const target = db.prepare("SELECT id FROM users WHERE id = ? AND kind = 'user'").get(id);
    if (target === undefined) throw new AppError('NOT_FOUND', 404, 'user not found');
    db.transaction(() => {
      db.prepare("UPDATE users SET status = 'banned' WHERE id = ?").run(id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      log(req.user.id, 'BAN', { userId: id });
    })();
    return { ok: true };
  });

  /** 解封。 */
  app.post('/api/admin/users/:id/unban', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const target = db.prepare("SELECT id FROM users WHERE id = ? AND kind = 'user'").get(id);
    if (target === undefined) throw new AppError('NOT_FOUND', 404, 'user not found');
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(id);
    log(req.user.id, 'UNBAN', { userId: id });
    return { ok: true };
  });

  /** 发布公告。 */
  app.post('/api/admin/announce', { preHandler: requireAdmin }, async (req) => {
    const { content } = AnnounceSchema.parse(req.body);
    const day = engineDay(db);
    db.transaction(() => {
      db.prepare('INSERT INTO announcements(day, content) VALUES (?,?)').run(day, content);
      log(req.user.id, 'ANNOUNCE', { content });
    })();
    return { ok: true };
  });

  /** 引擎状态：day / tickInDay / lastTick / 延迟秒。 */
  app.get('/api/admin/engine', { preHandler: requireAdmin }, async () => {
    const lastTick = (db.prepare('SELECT last_tick lt FROM engine_state WHERE id = 1').get() as
      { lt: number }).lt;
    const genesis = (db.prepare('SELECT genesis_ms gm FROM engine_state WHERE id = 1').get() as
      { gm: number }).gm;
    const tickInDay = ((lastTick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
    const lagSeconds = Math.max(0, Math.round((now() - genesis - (lastTick + 1) * TICK_MS) / 1000));
    return { day: engineDay(db), tickInDay, lastTick, lagSeconds };
  });

  /** 总账审计：全局平衡 + 每用户 balances 对账。 */
  app.get('/api/admin/audit', { preHandler: requireAdmin }, async () => {
    let globalOk = true, globalError: string | null = null;
    try { auditGlobal(db); } catch (e) { globalOk = false; globalError = String(e); }
    const users = db.prepare("SELECT id, username FROM users WHERE kind = 'user' ORDER BY id").all() as
      { id: number; username: string }[];
    const failures: { id: number; username: string; error: string }[] = [];
    for (const u of users) {
      try { auditUser(db, u.id); } catch (e) { failures.push({ ...u, error: String(e) }); }
    }
    return { globalOk, globalError, usersOk: failures.length === 0, checkedUsers: users.length, failures };
  });

  /** config 读取（快照）。 */
  app.get('/api/admin/config', { preHandler: requireAdmin }, async () => ({
    config: cfg, overrides: db.prepare('SELECT key, value FROM config ORDER BY key').all(),
  }));

  /**
   * config 热更新：仅白名单键（前缀 + 精确键两张表）。写 config 表 override 并以
   * `applyOverride` 原位合并到进程 cfg（顶层节点共享引用，engine/matcher/work 即时可见）。
   */
  app.put('/api/admin/config', { preHandler: requireAdmin }, async (req) => {
    const { key, value } = ConfigPutSchema.parse(req.body);
    if (!isWhitelistedKey(key)) {
      throw new AppError('CONFIG_KEY', 400, `key not in whitelist: ${key}`);
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO config(key,value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
      log(req.user.id, 'CONFIG_PUT', { key, value });
    })();
    applyOverride(cfg, key, value);
    return { ok: true, key, value };
  });

  /** 备份列表（仅 day-N.db）。 */
  app.get('/api/admin/backups', { preHandler: requireAdmin }, async () => {
    if (dataDir === undefined) return { files: [] };
    const dir = join(dataDir, 'backups');
    let files: { file: string; bytes: number }[] = [];
    try {
      files = readdirSync(dir).filter(f => /^day-\d+\.db$/.test(f))
        .map(f => ({ file: f, bytes: statSize(join(dir, f)) }));
    } catch { files = []; }
    return { files };
  });

  /** 备份下载：文件名白名单 + 路径逃逸防护。 */
  app.get('/api/admin/backups/:file', { preHandler: requireAdmin }, async (req, reply) => {
    const { file } = BackupFileSchema.parse(req.params);
    if (dataDir === undefined) throw new AppError('NOT_FOUND', 404, 'no data dir');
    const full = join(dataDir, 'backups', basename(file));
    const stream = createReadStream(full);
    reply.type('application/octet-stream');
    return reply.send(stream);
  });
}

/** 该 config 键是否允许热改：精确键全等，其余走路由前缀。 */
function isWhitelistedKey(key: string): boolean {
  if (CONFIG_WHITELIST_EXACT.includes(key)) return true;
  return CONFIG_WHITELIST.some(p => key.startsWith(p));
}

/** 把 "a.b.c" 形式的 override 原位写入 cfg（顶层节点为对象时逐层深入）。 */
function applyOverride(cfg: Config, key: string, value: unknown): void {
  const parts = key.split('.');
  let node: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    const next = node[seg];
    if (next === null || typeof next !== 'object') return; // 未知路径：忽略
    node = next as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

function statSize(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}
