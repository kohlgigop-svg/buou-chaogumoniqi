import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export type DB = Database.Database;
export const ACC = { MARKET: 1, BANK: 2, TAX: 3, EMPLOYER: 4, CLEARING: 5 } as const;
const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
export function openDb(path: string): DB {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  const files = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
  const cur = db.pragma('user_version', { simple: true }) as number;
  for (const f of files) {
    const v = parseInt(f.slice(0, 3), 10);
    if (v > cur) db.transaction(() => {
      db.exec(readFileSync(join(MIG_DIR, f), 'utf8'));
      db.pragma(`user_version = ${v}`);
    })();
  }
  return db;
}
