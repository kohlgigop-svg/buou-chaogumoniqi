// engine/backup.ts —— 每日备份：VACUUM INTO 产出快照 + 滚动保留最近 keep 份。
// 注意：VACUUM 不能在事务内执行 —— 调用方（Engine）必须在 advanceOne 事务提交之后调用。
import { mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/database.js';

/**
 * 备份到 <dataDir>/backups/day-<day>.db，仅保留 day 序号最大的 keep 份。
 * 内存库（无落盘文件）跳过并返回 ''；否则返回目标路径。
 */
export function backupDaily(db: DB, dataDir: string, day: number, keep: number): string {
  if (isMemoryDb(db)) return '';
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `day-${day}.db`);
  if (existsSync(target)) unlinkSync(target); // VACUUM INTO 拒绝覆盖已存在文件
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); // 单引号加倍转义路径
  // 滚动：解析 day-N.db 的 N，保留最大的 keep 个，其余删除
  const entries = readdirSync(dir)
    .map(f => ({ f, m: /^day-(\d+)\.db$/.exec(f) }))
    .filter((e): e is { f: string; m: RegExpExecArray } => e.m !== null)
    .map(e => ({ f: e.f, n: parseInt(e.m[1]!, 10) }))
    .sort((a, b) => b.n - a.n);
  for (const e of entries.slice(keep)) unlinkSync(join(dir, e.f));
  return target;
}

function isMemoryDb(db: DB): boolean {
  const name = (db as { name?: unknown }).name;
  if (typeof name === 'string') return name === ':memory:' || name === '';
  const list = db.pragma('database_list') as { name: string; file: string }[];
  const main = list.find(r => r.name === 'main');
  return main === undefined || main.file === '';
}
