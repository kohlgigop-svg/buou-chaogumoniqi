// test/api/static.test.ts —— Task 10：静态托管构建产物 + SPA fallback。
//
// 这个文件的**核心风险**不是"能不能返回 index.html"，而是**fallback 不能吞掉 /api**。
// SPA history 路由的直觉写法是"所有未命中都回 index.html"，而本项目 `/api/*` 的未命中
// **必须**保持 `{code:'NOT_FOUND'}` JSON 信封 —— 否则前端 `api.ts` 拿到一坨 HTML，
// 会以 `Unexpected token '<'` 的形式炸在 JSON.parse，报错完全指不到真正的原因。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../../src/db/database.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { Engine } from '../../src/engine/engine.js';
import { buildApp } from '../../src/api/app.js';

const INDEX_HTML = '<!doctype html><html><body><div id="root">SPA_SENTINEL</div></body></html>';

let db: DB;
let app: FastifyInstance;
let distDir: string;

/** 造一个像样的 `web/dist`：index.html + assets/app.js。 */
function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pt-webdist-'));
  writeFileSync(join(dir, 'index.html'), INDEX_HTML);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("asset sentinel")');
  return dir;
}

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(async () => {
  if (app !== undefined) await app.close();
  db.close();
  if (distDir !== undefined) rmSync(distDir, { recursive: true, force: true });
});

async function bootWithDist(): Promise<void> {
  distDir = makeDist();
  const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 1, genesisMs: Date.UTC(2026, 0, 15, 0, 0, 0) });
  app = await buildApp({ db, cfg: DEFAULTS, engine, webDist: distDir });
}

async function bootWithoutDist(): Promise<void> {
  const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 1, genesisMs: Date.UTC(2026, 0, 15, 0, 0, 0) });
  app = await buildApp({ db, cfg: DEFAULTS, engine });
}

// ---------- 有构建产物 ----------

describe('托管 web/dist（提供 webDist 时）', () => {
  beforeEach(async () => { await bootWithDist(); });

  it('GET / 返回 index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('SPA_SENTINEL');
  });

  it('静态资源按实际文件返回（assets/app.js）', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('asset sentinel');
  });

  it('⚠️ 未命中的 SPA 路由回 index.html（history 路由刷新不 404）', async () => {
    for (const url of ['/market', '/market/600619', '/admin', '/a/b/c/d']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} 应回 index.html`).toBe(200);
      expect(res.headers['content-type'], url).toContain('text/html');
      expect(res.body, url).toContain('SPA_SENTINEL');
    }
  });

  it('⚠️⚠️ GET /api/nonexistent 仍是 JSON 404，**绝不能被 fallback 吞成 HTML**', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    // 前端 api.ts 依赖这个信封；收到 HTML 会以 JSON.parse 报错的形式炸掉
    expect(res.json()).toHaveProperty('code');
    expect(res.body).not.toContain('SPA_SENTINEL');
  });

  it('⚠️ 已存在的 API 未命中（如 /api/stocks/NOPE）不得退化成 HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stocks/NOPE' });
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('SPA_SENTINEL');
  });

  it('⚠️ /ws 未命中不能被 fallback 接管（走 WS 升级逻辑，不是 HTML）', async () => {
    // 普通 GET 打 /ws 不是合法升级请求，但也不能回 index.html
    const res = await app.inject({ method: 'GET', url: '/ws' });
    expect(res.body).not.toContain('SPA_SENTINEL');
  });

  it('/healthz 仍正常（公开字段，不涉静态）', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('ok', true);
    expect(res.json()).toHaveProperty('lastTick');
  });

  it('POST 到未命中的 SPA 路由不返回 index.html（只 GET/HEAD 才 fallback）', async () => {
    const res = await app.inject({ method: 'POST', url: '/nonexistent/spa', payload: {} });
    expect(res.body).not.toContain('SPA_SENTINEL');
  });

  it('HEAD / 正常返回且无 body', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });
});

// ---------- 无构建产物（开发期只跑 API） ----------

describe('未提供 webDist 时（行为必须与改动前完全一致）', () => {
  beforeEach(async () => { await bootWithoutDist(); });

  it('GET / 仍是 404（不静默假装有前端）', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /market 也是 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/market' });
    expect(res.statusCode).toBe(404);
  });

  it('既有 API 不受影响（/healthz 与 /api/me 语义不变）', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    // 未登录 → 401 UNAUTHORIZED（证明路由与鉴权链完好）
    const me = await app.inject({ method: 'GET', url: '/api/me' });
    expect(me.statusCode).toBe(401);
    expect(me.json().code).toBe('UNAUTHORIZED');
  });
});

// ---------- 目录不存在（开发期最常见：never built） ----------

describe('webDist 指向不存在的目录 → 静默跳过，不崩', () => {
  it('目录不存在时应用仍能启动，且 GET / 是 404', async () => {
    const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: 1,
      genesisMs: Date.UTC(2026, 0, 15, 0, 0, 0) });
    app = await buildApp({ db, cfg: DEFAULTS, engine,
      webDist: join(tmpdir(), 'pt-definitely-not-built-xyz') });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });
});
