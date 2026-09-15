// test/config/overrides.test.ts —— 热改白名单 + **启动时恢复**。
//
// ⚠️ 为什么专门测「恢复」：`applyOverride` 原来只在管理后台 PUT 路由里被调用，
// 进程一重启（含每次重新部署）热改值就全丢。线上实测：`auth.ipRegPerDay`
// 热改成 25，config 表里 override 还在，但重新部署后进程读到的又是 20。
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/db/database.js';
import { DEFAULTS, type Config } from '../../src/config/defaults.js';
import { loadOverrides, isWhitelistedKey, applyOverride } from '../../src/config/overrides.js';

function freshCfg(): Config {
  // 深拷贝，避免污染模块级 DEFAULTS
  return JSON.parse(JSON.stringify(DEFAULTS)) as Config;
}

function setOverride(db: DB, key: string, value: unknown): void {
  db.prepare(`INSERT INTO config(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
}

describe('loadOverrides：启动时恢复热改值', () => {
  it('⚠️ 精确键与前缀键都能恢复（模拟重启后重新读库）', () => {
    const db = openDb(':memory:');
    setOverride(db, 'auth.ipRegPerDay', 25);
    setOverride(db, 'p2p.maxTermDays', 60);

    const cfg = freshCfg();
    expect(cfg.auth.ipRegPerDay).toBe(20);      // 默认值
    const applied = loadOverrides(db, cfg);
    expect(cfg.auth.ipRegPerDay).toBe(25);      // 已恢复
    expect(cfg.p2p.maxTermDays).toBe(60);
    expect(applied).toContain('auth.ipRegPerDay');
    expect(applied).toContain('p2p.maxTermDays');
    db.close();
  });

  it('⚠️ 顶层键（不在任何前缀下）也能恢复', () => {
    const db = openDb(':memory:');
    setOverride(db, 'playerImpactLambda', 12);
    setOverride(db, 'playerImpactCap', 0.08);
    const cfg = freshCfg();
    loadOverrides(db, cfg);
    expect(cfg.playerImpactLambda).toBe(12);
    expect(cfg.playerImpactCap).toBe(0.08);
    db.close();
  });

  it('⚠️ 表里的内部状态行不得被当成 cfg 路径（master_seed/divisor:*/matcher_*）', () => {
    const db = openDb(':memory:');
    // 这些键**不是**白名单键，必须原样忽略 —— 否则 `divisor:半导体` 这种
    // 带冒号带中文的键会被拿去逐层解析 cfg，行为不可预期。
    setOverride(db, 'master_seed', 1774461179);
    setOverride(db, 'divisor:半导体', 262400000);
    setOverride(db, 'matcher_rng', { day: 5 });
    setOverride(db, 'used_spares', []);
    const cfg = freshCfg();
    const applied = loadOverrides(db, cfg);
    expect(applied).toEqual([]);
    // cfg 未被污染：没有任何名为 master_seed / matcher_rng 的顶层键
    const c = cfg as unknown as Record<string, unknown>;
    expect(c['master_seed']).toBeUndefined();
    expect(c['matcher_rng']).toBeUndefined();
    expect(c['used_spares']).toBeUndefined();
    db.close();
  });

  it('非 JSON 的裸值当作字符串，不抛错（不让启动挂掉）', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO config(key,value) VALUES (?,?)').run('p2p.note', 'raw-not-json');
    const cfg = freshCfg();
    expect(() => loadOverrides(db, cfg)).not.toThrow();
    expect((cfg.p2p as unknown as Record<string, unknown>)['note']).toBe('raw-not-json');
    db.close();
  });

  it('未知路径静默忽略（不抛错、不改任何东西）', () => {
    const cfg = freshCfg();
    const before = JSON.stringify(cfg);
    applyOverride(cfg, 'no.such.path', 1);
    expect(JSON.stringify(cfg)).toBe(before);
  });
});

describe('isWhitelistedKey：精确键全等、其余前缀', () => {
  it('三个精确键通过', () => {
    for (const k of ['auth.ipRegPerDay', 'playerImpactLambda', 'playerImpactCap']) {
      expect(isWhitelistedKey(k)).toBe(true);
    }
  });
  it('五个前缀通过', () => {
    for (const k of ['trading.slippageK', 'credit.basis', 'loans.maxRate',
      'work.shiftsPerDay', 'p2p.maxTermDays']) {
      expect(isWhitelistedKey(k)).toBe(true);
    }
  });
  it('⚠️ 精确键不派生：ipRegPerDayX 与 playerImpactLambdaX 必须被拒', () => {
    for (const k of ['auth.ipRegPerDayX', 'playerImpactLambdaX', 'playerImpactCapX']) {
      expect(isWhitelistedKey(k)).toBe(false);
    }
  });
  it('前缀必须带点号：tradingX / p2p 被拒', () => {
    for (const k of ['tradingX', 'p2p', 'creditBasis']) expect(isWhitelistedKey(k)).toBe(false);
  });
  it('未放开的 auth 子键被拒', () => {
    expect(isWhitelistedKey('auth.initialCash')).toBe(false);
    expect(isWhitelistedKey('auth.sessionDays')).toBe(false);
  });
});
