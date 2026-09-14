import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ACC } from '../../src/db/database.js';

/**
 * 最新迁移版本 —— **从文件名推导，不写死数字**。
 *
 * ⚠️ 原先这里硬编码 `toBe(2)`，加一个 `003_p2p.sql` 就红了。而「迁移跑到最新」
 * 这个不变量本身与具体版本号无关，写死等于每加一次迁移都要手改测试
 * —— 改的时候还很容顺手把 2 改成 3 而没想清在测什么。故改为动态取最大值。
 */
const LATEST_VERSION = Math.max(
  ...readdirSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations'))
    .filter(f => f.endsWith('.sql'))
    .map(f => parseInt(f.slice(0, 3), 10)),
);

describe('database', () => {
  it('迁移建出全部基础表（含 P2P 借据表）', () => {
    const db = openDb(':memory:');
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map((r: any) => r.name);
    for (const t of ['users','sessions','stocks','stock_state','candles_day','ticks','orders','trades','holdings','ledger','loans','credit_events','jobs','shifts','abilities','enrollments','news','reports','dividends','config','engine_state','announcements','admin_logs','p2p_loans'])
      expect(names).toContain(t);
  });
  it('系统账户已播种且 kind=system', () => {
    const db = openDb(':memory:');
    const row = db.prepare('SELECT kind FROM users WHERE id=?').get(ACC.MARKET) as any;
    expect(row.kind).toBe('system');
    const n = (db.prepare(`SELECT COUNT(*) c FROM users WHERE kind='system'`).get() as any).c;
    expect(n).toBe(5);
  });
  it('重复打开幂等：迁移已推到最新版本', () => {
    const db = openDb(':memory:');
    expect((db.pragma('user_version', { simple: true }) as number)).toBe(LATEST_VERSION);
  });
  it('ledger 禁止 UPDATE/DELETE（触发器）', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO ledger(user_id,bucket,day,tick,kind,amount,balance_after,ref_type,ref_id) VALUES(1,'A',1,0,'TEST',0,0,'t',0)`).run();
    expect(() => db.prepare(`UPDATE ledger SET amount=1 WHERE id=1`).run()).toThrow();
    expect(() => db.prepare(`DELETE FROM ledger WHERE id=1`).run()).toThrow();
  });
});
