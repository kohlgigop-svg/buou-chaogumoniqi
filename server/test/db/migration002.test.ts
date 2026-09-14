import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../../src/db/database.js';

/**
 * 最新迁移版本（从文件名推导）。
 * 本文件测的是 002 自己引入的东西（jobs / login_attempts / 索引），
 * 但 `user_version` 反映的是**跑到哪儿了**，故不能写死 2 —— 加一个 003 就白红一次。
 */
const LATEST_VERSION = Math.max(
  ...readdirSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations'))
    .filter(f => f.endsWith('.sql'))
    .map(f => parseInt(f.slice(0, 3), 10)),
);

describe('migration 002_plan_b', () => {
  let dir: string;
  let dbPath: string;
  let db: DB;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pt-mig002-'));
    dbPath = join(dir, 'test.db');
    db = openDb(dbPath);
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('002 已应用（user_version ≥ 2，且库整体推到最新）', () => {
    const v = db.pragma('user_version', { simple: true }) as number;
    expect(v).toBeGreaterThanOrEqual(2);
    expect(v).toBe(LATEST_VERSION);
  });

  it('jobs 播种 10 行', () => {
    const n = (db.prepare('SELECT COUNT(*) c FROM jobs').get() as any).c;
    expect(n).toBe(10);
  });

  it('基金经理: base_pay=1_500_000, min_credit=700', () => {
    const row = db.prepare('SELECT base_pay, min_credit FROM jobs WHERE name=?').get('基金经理') as any;
    expect(row).toBeTruthy();
    expect(row.base_pay).toBe(1_500_000);
    expect(row.min_credit).toBe(700);
  });

  it('除基金经理外 min_credit 均为 NULL', () => {
    const n = (db.prepare('SELECT COUNT(*) c FROM jobs WHERE min_credit IS NULL').get() as any).c;
    expect(n).toBe(9);
  });

  it('外卖骑手 reqs 解析为 [["FIT",2]]', () => {
    const row = db.prepare('SELECT reqs FROM jobs WHERE name=?').get('外卖骑手') as any;
    expect(JSON.parse(row.reqs)).toEqual([['FIT', 2]]);
  });

  it('login_attempts 表存在', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='login_attempts'`).get();
    expect(row).toBeTruthy();
  });

  it('两个索引存在', () => {
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((r: any) => r.name);
    expect(names).toContain('idx_shifts_user');
    expect(names).toContain('idx_loans_user');
  });

  it('文件库 close 后重开幂等（版本不再前进、jobs 仍 10 行）', () => {
    db.close();
    db = openDb(dbPath);
    expect(db.pragma('user_version', { simple: true }) as number).toBe(LATEST_VERSION);
    const n = (db.prepare('SELECT COUNT(*) c FROM jobs').get() as any).c;
    expect(n).toBe(10);
  });
});
