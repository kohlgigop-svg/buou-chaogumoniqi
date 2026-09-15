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
import { createUser } from './auth.js';

export interface AdminDeps { db: DB; cfg: Config; now: () => number; dataDir?: string }

const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });
const SearchSchema = z.object({ q: z.string().max(32).optional() });
const ResetPwdSchema = z.object({ newPassword: z.string().min(8).max(72) });
const AnnounceSchema = z.object({ content: z.string().min(1).max(500) });
const ConfigPutSchema = z.object({ key: z.string().min(1), value: z.unknown() });
const BackupFileSchema = z.object({ file: z.string().regex(/^day-\d+\.db$/) });
const TestUserSchema = z.object({
  username: z.string().min(3).max(16).regex(/^[A-Za-z0-9_\u4e00-\u9fa5]+$/),
  password: z.string().min(8).max(72),
});

/** 前缀白名单（带点号，避免 `tradingX` 这类误匹配）。 */
const CONFIG_WHITELIST = ['trading.', 'credit.', 'loans.', 'work.', 'p2p.'];
const CONFIG_WHITELIST_EXACT = [
  'auth.ipRegPerDay',
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

  /**
   * 删除账号（**不可恢复**）—— 用于清理测试探针账号。
   *
   * 为什么需要它：封禁（ban）只是 `status='banned'`，用户行仍在库里，
   * 仍会占用每日注册名额、仍出现在统计里。清理探针必须真删。
   *
   * ⚠️ 账本不变式（`core/ledger.ts`）：
   *   - `ledger` 表有 `BEFORE DELETE` 触发器（append-only），**行删不掉**；
   *   - `auditGlobal` 要求 `SUM(ledger.amount) === 0`；
   *   - `auditUser` 只对**仍存在的用户**做勾稽。
   * 因此删除策略是：**保留 ledger 行、删掉 users 行**。探针账号的创世分录
   * 是「@market -X / 探针 +X」，两者都留在账上、和仍为 0，全局审计不受影响；
   * 而该用户不再存在，`auditUser` 也就不会再查它。**绝不能删 ledger 行**
   * （触发器会 ABORT，且会打破全局平衡）。
   *
   * 安全性：默认拒绝删除「仍在托管中」的账号（有未平仓订单 / 持仓 / 未结清
   * 借据），避免误删真实玩家；确需清理时传 `force=true`。
   * 管理员账号与系统账号（kind='system'）一律拒绝。
   */
  app.delete('/api/admin/users/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const force = (req.query as { force?: string } | undefined)?.force === 'true';

    const target = db.prepare(
      "SELECT id, username, kind, is_admin ia, cash_available cash, cash_frozen frozen FROM users WHERE id = ?",
    ).get(id) as { id: number; username: string; kind: string; ia: number; cash: number; frozen: number } | undefined;
    // kind='system' 或不存在 → 404（对外不区分，避免枚举系统账号）
    if (target === undefined || target.kind !== 'user') throw new AppError('NOT_FOUND', 404, 'user not found');
    if (target.ia === 1 || target.id === req.user.id) {
      throw new AppError('CANNOT_DELETE_ADMIN', 400, 'cannot delete an admin account');
    }

    // 托管状态盘点：任一非空即拒绝（除非 force）
    const openOrders = (db.prepare(
      "SELECT COUNT(*) c FROM orders WHERE user_id = ? AND status = 'open'").get(id) as { c: number }).c;
    const heldStocks = (db.prepare(
      'SELECT COUNT(*) c FROM holdings WHERE user_id = ? AND qty_total > 0').get(id) as { c: number }).c;
    const openLoans = (db.prepare(
      "SELECT COUNT(*) c FROM loans WHERE user_id = ? AND status IN ('active','grace','overdue')")
      .get(id) as { c: number }).c;
    const openP2p = (db.prepare(
      `SELECT COUNT(*) c FROM p2p_loans WHERE (borrower_id = ? OR lender_id = ?)
        AND status IN ('pending','active','grace','overdue')`).get(id, id) as { c: number }).c;

    const blockers = { openOrders, heldStocks, openLoans, openP2p };
    const hasState = openOrders + heldStocks + openLoans + openP2p > 0;
    if (hasState && !force) {
      throw new AppError('USER_HAS_STATE', 409,
        `user still holds managed state: ${JSON.stringify(blockers)}`);
    }

    db.transaction(() => {
      // 先清所有从属行（不含 ledger —— 触发器禁止，且必须保留以维持全局平衡）。
      //
      // ⚠️ 顺序有硬约束：`trades.order_id` 有外键指向 `orders(id)`，
      // 所以**必须先删 trades、再删 orders**，否则 `FOREIGN KEY constraint failed`。
      // 线上实测：没交易的探针账号删得掉，有交易记录的真实玩家全报 500 —— 就是这个顺序问题。
      // 注意 trades 没有指向 users 的外键，故除了自己的成交，还要删掉
      // 「挂单属于自己」的那些成交行（对手方视角）。
      db.prepare(`DELETE FROM trades WHERE user_id = ?
        OR order_id IN (SELECT id FROM orders WHERE user_id = ?)`).run(id, id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM orders WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM holdings WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM abilities WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM enrollments WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM shifts WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM credit_events WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM loans WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM p2p_loans WHERE borrower_id = ? OR lender_id = ?').run(id, id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      log(req.user.id, 'DELETE_USER', { userId: id, username: target.username, force, blockers });
    })();

    // 删除后立刻自检：全局账本必须仍平衡（ledger 行保留 → 和仍为 0）
    try {
      auditGlobal(db);
    } catch (e) {
      req.log.error(e, 'audit after user delete');
      throw new AppError('AUDIT_FAILED', 500, `post-delete audit failed: ${String(e)}`);
    }

    return { ok: true, deleted: { id, username: target.username } };
  });

  /**
   * 建**测试账号**：走与真实注册完全相同的建号事务，但**不占 IP 注册名额**。
   *
   * 为什么要它：以前做线上验证（探针脚本）只能调 `/api/auth/register`，
   * 于是每次核验都消耗真实玩家可用的 IP 名额 —— 到下午名额就没了，
   * 真人反而注册不进来。测试不该挤占真实玩家的资源。
   *
   * 语义边界：
   *   - 账号 `reg_ip` 被写成 `test:<ip>`，与真实注册的来源可区分；
   *     这些账号同时被 `auth.ipRegPerDay` 的计数排除（计数只认真实 IP），
   *     所以它们既不占名额、也**不会**把真实 IP 的计数推高。
   *   - 仅管理员可调。
   *   - 建出来的是正常玩家账号（有 100 万初始资金），用完请用
   *     `DELETE /api/admin/users/:id` 清掉，别让它们混进排行榜。
   */
  app.post('/api/admin/test-users', { preHandler: requireAdmin }, async (req) => {
    const { username, password } = TestUserSchema.parse(req.body);

    // 与真实注册共用建号事务，但 reg_ip 打 `test:` 前缀 → 不占名额
    const { userId } = await createUser(db, cfg, now(), {
      username, password, regIp: req.ip, markTest: true,
    });
    log(req.user.id, 'CREATE_TEST_USER', { userId, username });
    return { user: { id: userId, username } };
  });

  /** 列出全部测试账号（`reg_ip` 带 `test:` 前缀），便于一键清理。 */
  app.get('/api/admin/test-users', { preHandler: requireAdmin }, async () => {
    const rows = db.prepare(
      `SELECT id, username, status, created_day createdDay FROM users
        WHERE kind = 'user' AND reg_ip LIKE 'test:%' ORDER BY id`,
    ).all();
    return { users: rows };
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
