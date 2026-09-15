// api/ws.ts —— WebSocket 中枢：会话鉴权、订阅集、tick 节流推送、私有成交回报。
// 设计要点：
//  · 鉴权在 upgrade 阶段用会话 cookie 完成（与 requireAuth 同源规则）；未登录 4401、封禁 4403。
//  · tick 推送节流为「每 2 个全局 tick 一次」，并恒推指数 IDX:COMP（由全市场行情合成），
//    其余只推该 socket 的订阅集（无订阅时回退为其持仓代码）。
//  · fill 是私有事件：只投递给 userId 匹配的连接，绝不广播。
//  · 每个 socket 有一帧待发送队列，合并同一帧内的多次推送，避免慢客户端积压。
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { TICKS_PER_DAY } from '../core/clock.js';
import type { TickCtx } from '../engine/types.js';
import type { Engine } from '../engine/engine.js';
import type { DB } from '../db/database.js';
import type { FillEvent, PlayerMatcher } from '../trading/matcher.js';

export interface WsDeps { db: DB; engine: Engine; matcher: PlayerMatcher | null;
  /** 当前毫秒；与 REST 层保持同一时钟源（测试注入可控时钟）。 */
  now?: () => number }

/** 单帧合并窗口：同一窗口内的多次推送只保留最后一份同类型快照。 */
const FLUSH_MS = 25;
/** tick 推送节流：每 N 个全局 tick 推一次。 */
const TICK_PUSH_EVERY = 2;
/** 订阅集上限。 */
const MAX_SUB = 50;
const INDEX_CODE = 'IDX:COMP';

/** 推送行：[code, price(分), chgPct(基点, 相对 prev_close), volume(股)]。 */
type QuoteRow = [string, number, number, number];

interface Client {
  ws: WebSocket;
  userId: number;
  subs: string[];
  /** 会话持仓代码缓存（登录后固定，持仓变化在下一次 sub/tick 刷新）。 */
  holdings: string[];
  pending: Map<string, unknown>; // key: 消息类型，同类型只留最新
  timer: ReturnType<typeof setTimeout> | null;
}

export async function registerWsRoutes(app: FastifyInstance, deps: WsDeps): Promise<void> {
  const { db, engine, matcher } = deps;
  const now = deps.now ?? Date.now;
  const clients = new Set<Client>();
  const byUser = new Map<number, Set<Client>>();

  await app.register(websocket);

  const push = (c: Client, key: string, payload: unknown): void => {
    c.pending.set(key, payload);
    if (c.timer !== null) return;
    c.timer = setTimeout(() => {
      c.timer = null;
      const batch = [...c.pending.values()];
      c.pending.clear();
      for (const msg of batch) {
        try { c.ws.send(JSON.stringify(msg)); } catch { /* 连接已断，由 close 清理 */ }
      }
    }, FLUSH_MS);
  };

  const err = (c: Client, code: string, message: string): void => {
    // 错误消息不合并，立即发送
    try { c.ws.send(JSON.stringify({ t: 'error', code, message })); } catch { /* ignore */ }
  };

  // ---------- 行情快照 ----------

  /** 该连接需要推送的代码列表：订阅集优先，空则回退会话持仓。 */
  const codesFor = (c: Client): string[] => (c.subs.length > 0 ? c.subs : c.holdings);

  const quoteRow = (ctx: TickCtx, code: string): QuoteRow | null => {
    const q = ctx.quotes.get(code);
    if (q === undefined || q.status === 'delisted') return null;
    // chgPct 用基点（万分之一）表示整数：round((price-prevClose)/prevClose * 10000)
    const chgBp = q.prevClose > 0
      ? Math.round(((q.price - q.prevClose) * 10_000) / q.prevClose)
      : 0;
    return [code, q.price, chgBp, q.volume];
  };

  /** 全市场合成指数：总市值基准（Σ price·shares 权重以等权近似，避免额外查股本）。 */
  const indexRow = (ctx: TickCtx): QuoteRow => {
    let sumBp = 0;
    let n = 0;
    let vol = 0;
    for (const q of ctx.quotes.values()) {
      if (q.status === 'delisted' || q.prevClose <= 0) continue;
      sumBp += Math.round(((q.price - q.prevClose) * 10_000) / q.prevClose);
      vol += q.volume;
      n++;
    }
    const avgBp = n === 0 ? 0 : Math.round(sumBp / n);
    // 指数的"价格"用基点表示（10000 = 平盘），前端按指数点位解释
    return [INDEX_CODE, 10_000 + avgBp, avgBp, vol];
  };

  const snapshot = (c: Client, ctx: TickCtx): void => {
    const rows: QuoteRow[] = [indexRow(ctx)];
    for (const code of codesFor(c)) {
      const r = quoteRow(ctx, code);
      if (r !== null) rows.push(r);
    }
    // ⚠️ `genesisMs` 必须随每一帧带上（而不是只在握手时发一次）：客户端要靠它才能
    //    与服务端用同一口径算「延迟」，而重连后客户端状态是全新的 —— 放在 tick 帧里
    //    天然自愈，也省掉一个新的消息类型。值是常量，重复传的代价可忽略。
    push(c, 'tick', { t: 'tick', genesisMs: engine.genesisMs, day: ctx.day,
      tickInDay: ctx.tickInDay, phase: ctx.phase, quotes: rows });
  };

  // ---------- 引擎订阅 ----------

  let tickCounter = 0;
  const offTick = engine.onTick((ctx: TickCtx) => {
    tickCounter++;
    const isSettle = ctx.tickInDay === TICKS_PER_DAY - 20; // 1180：结算首个 tick
    if (isSettle) {
      for (const c of clients) push(c, 'settled', { t: 'settled', day: ctx.day });
    }
    // 新闻：本 tick 产生的行情事件
    const news = db.prepare(
      'SELECT id, day, tick, scope, target, title FROM news WHERE day = ? AND tick = ? ORDER BY id',
    ).all(ctx.day, ctx.tickInDay) as { id: number; day: number; tick: number; scope: string;
      target: string | null; title: string }[];
    for (const n of news) {
      for (const c of clients) push(c, 'news', { t: 'news', item: n });
    }
    if (tickCounter % TICK_PUSH_EVERY !== 0) return;
    for (const c of clients) snapshot(c, ctx);
  });

  // fill 私有推送：按 orderId 反查归属用户，仅投递给该用户的连接。
  const offFill: () => void = matcher === null ? (): void => {} : matcher.onFill((f: FillEvent) => {
    const set = byUser.get(f.userId);
    if (set === undefined) return;
    for (const c of set) push(c, 'fill', { t: 'fill', orderId: f.orderId, code: f.code,
      side: f.side, price: f.price, qty: f.qty, commission: f.commission, stamp: f.stamp,
      transfer: f.transfer, day: f.day, tick: f.tick, orderStatus: f.orderStatus });
  });

  // ---------- 连接处理 ----------

  app.get('/ws', { websocket: true }, (conn, req: FastifyRequest) => {
    const ws = conn as unknown as WebSocket;
    const user = authenticate(db, req.raw, now);
    if (user === null) { ws.close(4401, 'unauthorized'); return; }
    if (user.status === 'banned') { ws.close(4403, 'banned'); return; }

    const c: Client = { ws, userId: user.id, subs: [], holdings: holdingsOf(db, user.id),
      pending: new Map(), timer: null };
    clients.add(c);
    let set = byUser.get(user.id);
    if (set === undefined) { set = new Set(); byUser.set(user.id, set); }
    set.add(c);

    ws.on('message', (raw: Buffer) => {
      let msg: unknown;
      try { msg = JSON.parse(String(raw)); } catch { err(c, 'BAD_MESSAGE', 'invalid json'); return; }
      const m = msg as { t?: unknown; codes?: unknown };
      if (m.t !== 'sub') { err(c, 'BAD_MESSAGE', 'unknown message type'); return; }
      if (!Array.isArray(m.codes) || m.codes.some(x => typeof x !== 'string')) {
        err(c, 'BAD_MESSAGE', 'codes must be string[]'); return;
      }
      if (m.codes.length > MAX_SUB) {
        err(c, 'SUB_TOO_MANY', `at most ${MAX_SUB} codes`); return;
      }
      c.subs = m.codes as string[]; // 替换式
      c.holdings = holdingsOf(db, user.id);
    });

    const cleanup = (): void => {
      if (c.timer !== null) { clearTimeout(c.timer); c.timer = null; }
      clients.delete(c);
      const s = byUser.get(user.id);
      if (s !== undefined) { s.delete(c); if (s.size === 0) byUser.delete(user.id); }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  // 关服时解绑引擎订阅，避免悬挂引用。
  app.addHook('onClose', async () => { offTick(); offFill(); });
}

// ---------- 鉴权与查询 ----------

interface SessionUser { id: number; status: string }

/** 在 upgrade 阶段校验会话 cookie（与 requireAuth 同规则：存在、未过期）。 */
function authenticate(db: DB, req: IncomingMessage, now: () => number): SessionUser | null {
  const sid = parseCookie(req.headers.cookie, 'sid');
  if (sid === undefined) return null;
  const row = db.prepare(`SELECT u.id, u.status, s.expires_at exp FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(sid) as
    { id: number; status: string; exp: number } | undefined;
  if (row === undefined || row.exp <= now()) return null;
  return { id: row.id, status: row.status };
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function holdingsOf(db: DB, userId: number): string[] {
  return (db.prepare('SELECT code FROM holdings WHERE user_id = ? AND qty_total > 0 ORDER BY code')
    .all(userId) as { code: string }[]).map(r => r.code);
}
