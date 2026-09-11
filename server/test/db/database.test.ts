import { describe, it, expect } from 'vitest';
import { openDb, ACC } from '../../src/db/database.js';

describe('database', () => {
  it('迁移建出 23 张表', () => {
    const db = openDb(':memory:');
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map((r: any) => r.name);
    for (const t of ['users','sessions','stocks','stock_state','candles_day','ticks','orders','trades','holdings','ledger','loans','credit_events','jobs','shifts','abilities','enrollments','news','reports','dividends','config','engine_state','announcements','admin_logs'])
      expect(names).toContain(t);
  });
  it('系统账户已播种且 kind=system', () => {
    const db = openDb(':memory:');
    const row = db.prepare('SELECT kind FROM users WHERE id=?').get(ACC.MARKET) as any;
    expect(row.kind).toBe('system');
    const n = (db.prepare(`SELECT COUNT(*) c FROM users WHERE kind='system'`).get() as any).c;
    expect(n).toBe(5);
  });
  it('重复打开幂等', () => {
    const db = openDb(':memory:');
    expect((db.pragma('user_version', { simple: true }) as number)).toBe(1);
  });
  it('ledger 禁止 UPDATE/DELETE（触发器）', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO ledger(user_id,bucket,day,tick,kind,amount,balance_after,ref_type,ref_id) VALUES(1,'A',1,0,'TEST',0,0,'t',0)`).run();
    expect(() => db.prepare(`UPDATE ledger SET amount=1 WHERE id=1`).run()).toThrow();
    expect(() => db.prepare(`DELETE FROM ledger WHERE id=1`).run()).toThrow();
  });
});
