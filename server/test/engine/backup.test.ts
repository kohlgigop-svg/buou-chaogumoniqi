import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { openDb } from '../../src/db/database.js';
import { backupDaily } from '../../src/engine/backup.js';
import { Engine } from '../../src/engine/engine.js';
import { DEFAULTS } from '../../src/config/defaults.js';

describe('backup', () => {
  it('产出文件并滚动保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-'));
    const db = openDb(join(dir, 'game.db'));
    for (let d = 1; d <= 10; d++) backupDaily(db, dir, d, 7);
    const files = readdirSync(join(dir, 'backups'));
    expect(files).toHaveLength(7);
    expect(files).toContain('day-10.db');
    expect(files).not.toContain('day-1.db');
    expect(existsSync(join(dir, 'backups', 'day-4.db'))).toBe(true);
  });

  it('Engine 接线：补跑 2 日仅末日备份（抑制证明），VACUUM 在事务外成功', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-eng-'));
    const db = openDb(join(dir, 'game.db'));
    const G = 1_700_000_000_000;
    const eng = new Engine({ db, cfg: DEFAULTS, masterSeed: 42, genesisMs: G, dataDir: dir });
    // 故意不分块：抑制窗口（target − 1200 tick）正是断言对象，按日分块会使 gap ≤ 1200、day-1.db 存在而翻转断言；~2.4s 阻塞远小于 RPC 窗口
    eng.catchUpTo(G + 2 * 3_600_000);
    expect(existsSync(join(dir, 'backups', 'day-2.db'))).toBe(true);
    expect(existsSync(join(dir, 'backups', 'day-1.db'))).toBe(false);
    db.close(); // Windows 文件锁：清理前关闭句柄
  }, 60_000);
});
