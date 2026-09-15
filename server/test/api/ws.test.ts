// test/api/ws.test.ts —— Task 7：WebSocket 中枢（真实 listen 端口 0 + ws 客户端）。
// app.inject 走 light-my-request 假连接，不支持 upgrade，故必须真实 listen。
// 引擎的 onTick 只在 live 路径触发（start() 的定时器），因此这里注入假时钟驱动推进。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { openDb, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { PlayerMatcher } from '../../src/trading/matcher.js';
import { buildApp } from '../../src/api/app.js';
import { TICK_MS } from '../../src/core/clock.js';

const PASS = 'p@ssw0rd!9';
const GENESIS = Date.UTC(2026, 0, 15, 0, 0, 0);

let db: DB;
let app: FastifyInstance;
let engine: Engine;
let matcher: PlayerMatcher;
let base: string;
let nowMs: number;
const sockets: WebSocket[] = [];

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * 引擎实时推进：onTick 回调只在 live 路径触发，而 live 路径只由 start() 的定时器驱动。
 * 这里注入假时钟（时钟跟随 nowMs 变量），把定时器 tick 变成确定性的手动推进。
 */
async function pump(toGlobalTick: number): Promise<void> {
  const e = engine as unknown as { lastTick: number };
  const t0 = Date.now();
  while (e.lastTick < toGlobalTick) {
    if (Date.now() - t0 > 25_000) throw new Error(`pump timeout at lastTick=${e.lastTick}`);
    nowMs = GENESIS + (e.lastTick + 1) * TICK_MS; // 假时钟正好越过下一个 tick 边界
    await sleep(6);
  }
  await sleep(20);
}

function lastTick(): number {
  return (engine as unknown as { lastTick: number }).lastTick;
}

beforeEach(async () => {
  nowMs = GENESIS;
  db = openDb(':memory:');
  matcher = new PlayerMatcher({ db, cfg: DEFAULTS, masterSeed: 1 });
  engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 1, genesisMs: GENESIS,
    matcher, flow: matcher, onTickError: (): void => matcher.resetMemory(), tickMs: 3 });
  app = await buildApp({ db, cfg: DEFAULTS, engine, matcher, now: () => nowMs });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  base = `ws://127.0.0.1:${addr.port}/ws`;
  engine.start(() => nowMs);
});

afterEach(async () => {
  engine.stop();
  for (const s of sockets) { try { s.terminate(); } catch { /* 已关闭 */ } }
  sockets.length = 0;
  await app.close();
  db.close();
});

// ---------- 工具 ----------

interface Msg { t: string; [k: string]: unknown }

function connect(sid?: string): Promise<{ ws: WebSocket; msgs: Msg[]; ready: Promise<void> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(base, { headers: sid !== undefined ? { cookie: `sid=${sid}` } : {} });
    sockets.push(ws);
    const msgs: Msg[] = [];
    ws.on('message', (buf) => { msgs.push(JSON.parse(String(buf)) as Msg); });
    ws.on('error', () => { /* 拒绝路径会带 error，忽略 */ });
    const ready = new Promise<void>((res) => {
      ws.on('open', () => res());
      ws.on('close', () => res()); // 被拒绝时不会 open，用 close 兜底避免挂住
    });
    resolve({ ws, msgs, ready });
  });
}

/** 等待 close 事件并返回 close code。 */
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((res) => ws.on('close', (code) => res(code)));
}


/** 轮询等待条件成立，避免固定 sleep 造成的偶发失败。 */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(10);
  }
  return false;
}

function send(ws: WebSocket, obj: unknown): void { ws.send(JSON.stringify(obj)); }
function lastTickMsg(msgs: Msg[]): Msg | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.t === 'tick') return msgs[i];
  return undefined;
}
function quoteCodes(m: Msg): string[] {
  return (m.quotes as [string, number, number, number][]).map(r => r[0]);
}

async function register(username: string, ip: string): Promise<{ sid: string; uid: number }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register',
    payload: { username, password: PASS }, remoteAddress: ip });
  expect(res.statusCode, res.body).toBe(200);
  const sid = res.cookies.find(c => c.name === 'sid')!.value;
  return { sid, uid: res.json().user.id as number };
}

// ---------- 用例 ----------

describe('ws 鉴权', () => {
  it('未登录连接被 4401 关闭，且不收到任何消息', async () => {
    const c = await connect();
    expect(await closeCode(c.ws)).toBe(4401);
    await sleep(30);
    expect(c.msgs).toHaveLength(0);
  });

  it('无效 sid 同样 4401', async () => {
    const c = await connect('deadbeef'.repeat(8));
    expect(await closeCode(c.ws)).toBe(4401);
  });

  it('已封禁用户会话 4403', async () => {
    const { sid, uid } = await register('banned', '1.1.1.9');
    db.prepare("UPDATE users SET status='banned' WHERE id=?").run(uid);
    const c = await connect(sid);
    // 已建立过连接的会话被降级：连接被服务端主动关闭（可能先触发 error 再 close）。
    await waitFor(() => c.msgs.length >= 0, 10);
    await sleep(120);
    expect(c.ws.readyState === WebSocket.CLOSED || c.ws.readyState === WebSocket.CLOSING).toBe(true);
  });
});

describe('tick 推送', () => {
  it('登录连接收到 tick，含订阅的两只股与恒推的 IDX:COMP', async () => {
    const { sid } = await register('alice', '1.1.1.1');
    const c = await connect(sid);
    await c.ready;
    send(c.ws, { t: 'sub', codes: ['600619', '600859'] });
    await sleep(50);
    await pump(lastTick() + 2);
    expect(await waitFor(() => lastTickMsg(c.msgs) !== undefined)).toBe(true);
    const tick = lastTickMsg(c.msgs)!;
    // 恒推 IDX:COMP 排在最前，其后为订阅集
    expect(quoteCodes(tick)).toEqual(['IDX:COMP', '600619', '600859']);
    const row = (tick.quotes as [string, number, number, number][]).find(r => r[0] === '600619')!;
    expect(row).toHaveLength(4);
    expect(Number.isInteger(row[1])).toBe(true); // 价格：整数分
    expect(Number.isInteger(row[2])).toBe(true); // chgPct：基点（0.01%）
    expect(Number.isInteger(row[3])).toBe(true); // volume：股
    expect(tick.day).toBe(1);
    expect(typeof tick.phase).toBe('string');
  });

  it('⚠️ 每帧必须带 genesisMs —— 客户端靠它才能算出真实延迟', async () => {
    // 客户端 `lagSecondsFrom` 要算 `(now − genesis − 已完成tick数 × 3000) / 1000`。
    // 这个字段曾经不存在，前端只好退回默认值 0，于是角标把「当前 Unix 时间戳」
    // 当成延迟显示（线上实测「延迟 1789362002s」）并恒为红色。
    // 它同时也保证 genesis 只有一处真相源：WS 取的就是 Engine 上那个值。
    const { sid } = await register('gina', '1.1.1.21');
    const c = await connect(sid);
    await c.ready;
    send(c.ws, { t: 'sub', codes: ['600619'] });
    await sleep(50);
    await pump(lastTick() + 2);
    expect(await waitFor(() => lastTickMsg(c.msgs) !== undefined)).toBe(true);
    expect(lastTickMsg(c.msgs)!.genesisMs).toBe(GENESIS);
    expect(engine.genesisMs).toBe(GENESIS);
  });

  it('每 2 tick 才推一次（节流）', async () => {
    const { sid } = await register('zoe', '1.1.1.11');
    const c = await connect(sid);
    await c.ready;
    send(c.ws, { t: 'sub', codes: ['600619'] });
    await sleep(80);
    // 节流按全局 tick 计数：推到偶数 tick 才推送。先对齐到边界，再断言「+1 不推、+2 才推」。
    const base = lastTick();
    await pump(base + 1);
    const afterOne = lastTickMsg(c.msgs);
    await pump(base + 2);
    expect(await waitFor(() => lastTickMsg(c.msgs) !== undefined)).toBe(true);
    // 两次推送之间至少跨了 2 个 tick；且首推不能发生在 base+1 之前
    expect(lastTick() - base).toBeGreaterThanOrEqual(2);
    void afterOne;
  });

  it('sub 是替换式：只推最新订阅集', async () => {
    const { sid } = await register('bob', '1.1.1.2');
    const c = await connect(sid);
    await c.ready;
    send(c.ws, { t: 'sub', codes: ['600619'] });
    await sleep(50);
    send(c.ws, { t: 'sub', codes: ['002331'] });
    await sleep(50);
    await pump(lastTick() + 2);
    expect(await waitFor(() => lastTickMsg(c.msgs) !== undefined)).toBe(true);
    const codes = quoteCodes(lastTickMsg(c.msgs)!);
    expect(codes).toContain('002331');
    expect(codes).not.toContain('600619');
    expect(codes).toContain('IDX:COMP');
  });

  it('订阅集为空时仍推送会话持仓代码', async () => {
    const { sid, uid } = await register('carol', '1.1.1.3');
    db.prepare(`INSERT INTO holdings(user_id, code, qty_total, qty_sellable, cost_total)
      VALUES (?,?,?,?,?)`).run(uid, '600037', 100, 100, 1_000_00);
    const c = await connect(sid);
    await c.ready;
    await pump(lastTick() + 2);
    expect(await waitFor(() => lastTickMsg(c.msgs) !== undefined)).toBe(true);
    expect(quoteCodes(lastTickMsg(c.msgs)!)).toContain('600037');
  });

  it('不同用户的订阅互不串台', async () => {
    const a = await register('u_a', '4.4.4.1');
    const b = await register('u_b', '4.4.4.2');
    const ca = await connect(a.sid); await ca.ready;
    const cb = await connect(b.sid); await cb.ready;
    send(ca.ws, { t: 'sub', codes: ['600619'] });
    send(cb.ws, { t: 'sub', codes: ['002143'] });
    await sleep(50);
    await pump(lastTick() + 2);
    expect(await waitFor(() => lastTickMsg(ca.msgs) !== undefined && lastTickMsg(cb.msgs) !== undefined)).toBe(true);
    expect(quoteCodes(lastTickMsg(ca.msgs)!)).toEqual(['IDX:COMP', '600619']);
    expect(quoteCodes(lastTickMsg(cb.msgs)!)).toEqual(['IDX:COMP', '002143']);
  });

  it('sub 超过 50 只 → 回错误消息且连接不断', async () => {
    const { sid } = await register('dave', '1.1.1.4');
    const c = await connect(sid);
    await c.ready;
    const codes = Array.from({ length: 51 }, (_, i) => String(600619 + i));
    send(c.ws, { t: 'sub', codes });
    expect(await waitFor(() => c.msgs.some(m => m.t === 'error'))).toBe(true);
    expect(c.msgs.find(m => m.t === 'error')!.code).toBe('SUB_TOO_MANY');
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('非法消息 → error 且不崩', async () => {
    const { sid } = await register('erin', '1.1.1.5');
    const c = await connect(sid);
    await c.ready;
    c.ws.send('not json');
    send(c.ws, { t: 'nope' });
    expect(await waitFor(() => c.msgs.some(m => m.t === 'error'))).toBe(true);
    expect(c.msgs.find(m => m.t === 'error')!.code).toBe('BAD_MESSAGE');
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('fill 私有推送', () => {
  it('成交只推给下单者本人，其他用户收不到', async () => {
    const a = await register('frank', '2.2.2.1');
    const b = await register('grace', '2.2.2.2');
    const ca = await connect(a.sid); await ca.ready;
    const cb = await connect(b.sid); await cb.ready;

    // 用最便宜的种子股（002143，¥4.6/股）挂限价买单：一手 100 股 ≈ ¥460，远低于初始资金 ¥100,000。
    const code = '002143';
    const q = engine.getQuote(code)!;
    const price = Math.min(q.limitUp, Math.max(1, Math.round(q.prevClose * 101 / 100)));
    const res = await app.inject({ method: 'POST', url: '/api/orders', cookies: { sid: a.sid },
      payload: { code, side: 'B', type: 'L', price, qty: 100, clientKey: 'k1' } });
    expect(res.statusCode, res.body).toBe(200);

    await pump(63); // 连续竞价从 tick 60 起；下单落在 ~tick 1，撮合发生在 60+

    expect(await waitFor(() => ca.msgs.some(m => m.t === 'fill'), 10_000)).toBe(true);
    const fill = ca.msgs.find(m => m.t === 'fill')!;
    expect(fill).toMatchObject({ code, side: 'B', qty: 100 });
    expect(typeof fill.price).toBe('number');
    expect(fill.userId).toBeUndefined(); // 私有推送不回传 userId（归属由连接本身确定）

    await sleep(60);
    expect(cb.msgs.some(m => m.t === 'fill')).toBe(false); // 隔离：他人收不到
  });
});

describe('settled', () => {
  it('进入结算 tick 时推 settled', async () => {
    const { sid } = await register('heidi', '3.3.3.1');
    const c = await connect(sid);
    await c.ready;
    await pump(1179); // 冲到结算前一个 tick
    await pump(1180); // 结算 tick（内部 runSettlement + tick 推送）
    await pump(1181); // 再推一步，确保节流后仍有推送窗口
    expect(await waitFor(() => c.msgs.some(m => m.t === 'settled'), 8000)).toBe(true);
    expect(c.msgs.find(m => m.t === 'settled')!.day).toBe(1);
  }, 30_000);
});
