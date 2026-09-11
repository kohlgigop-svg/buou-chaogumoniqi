import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ACC, type DB } from '../../src/db/database.js';
import { post, balancesOf, auditUser, auditGlobal } from '../../src/core/ledger.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = Number(db.prepare(`INSERT INTO users(username) VALUES('alice')`).run().lastInsertRowid);
});
describe('ledger', () => {
  it('发初始资金：市场→用户，两腿平衡', () => {
    post(db, 1, 0, 'GENESIS', uid, [
      { account: ACC.MARKET, bucket: 'A', amount: -10_000_000, kind: 'GENESIS' },
      { account: uid, bucket: 'A', amount: 10_000_000, kind: 'GENESIS' }]);
    expect(balancesOf(db, uid)).toEqual({ available: 10_000_000, frozen: 0 });
    auditUser(db, uid); auditGlobal(db);
  });
  it('不平衡拒绝', () => {
    expect(() => post(db, 1, 0, 'X', 0, [{ account: uid, bucket: 'A', amount: 5, kind: 'X' }])).toThrow(/unbalanced/);
  });
  it('冻结=同户 A→F', () => {
    post(db, 1, 0, 'GENESIS', uid, [
      { account: ACC.MARKET, bucket: 'A', amount: -1000, kind: 'GENESIS' },
      { account: uid, bucket: 'A', amount: 1000, kind: 'GENESIS' }]);
    post(db, 1, 1, 'FREEZE', 7, [
      { account: uid, bucket: 'A', amount: -600, kind: 'ORDER_FREEZE' },
      { account: uid, bucket: 'F', amount: 600, kind: 'ORDER_FREEZE' }]);
    expect(balancesOf(db, uid)).toEqual({ available: 400, frozen: 600 });
    auditUser(db, uid);
  });
  it('用户余额不可透支，事务回滚', () => {
    expect(() => post(db, 1, 0, 'X', 0, [
      { account: uid, bucket: 'A', amount: -1, kind: 'X' },
      { account: ACC.MARKET, bucket: 'A', amount: 1, kind: 'X' }])).toThrow(/negative/);
    expect(balancesOf(db, uid)).toEqual({ available: 0, frozen: 0 });
    expect((db.prepare('SELECT COUNT(*) c FROM ledger').get() as any).c).toBe(0);
  });
});
