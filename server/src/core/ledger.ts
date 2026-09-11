import type { DB } from '../db/database.js';
import { assertCents, type Cents } from './money.js';
export type Bucket = 'A' | 'F';
export interface Leg { account: number; bucket: Bucket; amount: Cents; kind: string; }

export function post(db: DB, day: number, tick: number, refType: string, refId: number, legs: Leg[]): void {
  if (legs.length === 0) throw new Error('empty posting');
  let sum = 0; for (const l of legs) { assertCents(l.amount); sum += l.amount; }
  if (sum !== 0) throw new Error(`unbalanced posting: ${sum}`);
  const getU = db.prepare('SELECT kind, cash_available a, cash_frozen f FROM users WHERE id=?');
  const updA = db.prepare('UPDATE users SET cash_available = cash_available + ? WHERE id=?');
  const updF = db.prepare('UPDATE users SET cash_frozen = cash_frozen + ? WHERE id=?');
  const ins = db.prepare(`INSERT INTO ledger(user_id,bucket,day,tick,kind,amount,balance_after,ref_type,ref_id)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const l of legs) {
      const u = getU.get(l.account) as { kind: string; a: number; f: number } | undefined;
      if (!u) throw new Error(`no account ${l.account}`);
      const before = l.bucket === 'A' ? u.a : u.f;
      const after = before + l.amount;
      if (u.kind === 'user' && after < 0) throw new Error(`negative balance for ${l.account}`);
      (l.bucket === 'A' ? updA : updF).run(l.amount, l.account);
      ins.run(l.account, l.bucket, day, tick, l.kind, l.amount, after, refType, refId);
    }
  })();
}
export function balancesOf(db: DB, userId: number): { available: Cents; frozen: Cents } {
  const r = db.prepare('SELECT cash_available a, cash_frozen f FROM users WHERE id=?').get(userId) as any;
  return { available: r.a, frozen: r.f };
}
export function auditUser(db: DB, userId: number): void {
  const s = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN bucket='A' THEN amount END),0) a,
    COALESCE(SUM(CASE WHEN bucket='F' THEN amount END),0) f FROM ledger WHERE user_id=?`).get(userId) as any;
  const b = balancesOf(db, userId);
  if (s.a !== b.available || s.f !== b.frozen)
    throw new Error(`ledger mismatch user=${userId} ledger=(${s.a},${s.f}) balance=(${b.available},${b.frozen})`);
}
export function auditGlobal(db: DB): void {
  const s = (db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger').get() as any).s;
  if (s !== 0) throw new Error(`global ledger sum ${s} != 0`);
}
