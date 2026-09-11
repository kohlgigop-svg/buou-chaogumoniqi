import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../../src/db/database.js';

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

  it('user_version = 2', () => {
    expect(db.pragma('user_version', { simple: true }) as number).toBe(2);
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

  it('文件库 close 后重开幂等（user_version=2、jobs 仍 10 行）', () => {
    db.close();
    db = openDb(dbPath);
    expect(db.pragma('user_version', { simple: true }) as number).toBe(2);
    const n = (db.prepare('SELECT COUNT(*) c FROM jobs').get() as any).c;
    expect(n).toBe(10);
  });
});
