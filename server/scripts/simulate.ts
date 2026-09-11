// scripts/simulate.ts —— 离线模拟 CLI：npm run simulate -- --days 90 --seed 42
// 内存库跑 Engine，每 10 日打印一行摘要，末尾打印存活/退市/价格区间。
import { parseArgs } from 'node:util';
import { openDb } from '../src/db/database.js';
import { Engine } from '../src/engine/engine.js';
import { DEFAULTS } from '../src/config/defaults.js';

const { values } = parseArgs({ options: {
  days: { type: 'string', default: '90' },
  seed: { type: 'string', default: '42' },
} });
const days = parseInt(values.days!, 10);
const seed = parseInt(values.seed!, 10);
if (!Number.isInteger(days) || days <= 0) throw new Error(`bad --days: ${values.days}`);
if (!Number.isInteger(seed)) throw new Error(`bad --seed: ${values.seed}`);

const GENESIS_MS = 1_700_000_000_000; // 固定创世时刻：输出与真实时间无关
const DAY_MS = 3_600_000;             // 1 游戏日 = 1200 tick × 3s

const db = openDb(':memory:');
const engine = new Engine({ db, cfg: DEFAULTS, masterSeed: seed, genesisMs: GENESIS_MS });

interface Row { day: number; close: string; up: number; down: number;
  news: number; reports: number; st: number }
const rows: Row[] = [];
// 分段补跑：每 10 日暂停采样一次，ST 家数取「该日结算后」的即时状态
for (let d = 10; d <= days; d += 10) {
  engine.catchUpTo(GENESIS_MS + d * DAY_MS);
  const close = (db.prepare(`SELECT c FROM candles_day WHERE code = 'IDX:COMP' AND day = ?`)
    .get(d) as { c: number } | undefined)?.c;
  const ud = db.prepare(`SELECT
      SUM(CASE WHEN c > o THEN 1 ELSE 0 END) up, SUM(CASE WHEN c < o THEN 1 ELSE 0 END) dn
    FROM candles_day WHERE day = ? AND code NOT LIKE 'IDX:%'`).get(d) as { up: number; dn: number };
  const news = (db.prepare('SELECT COUNT(*) n FROM news WHERE day <= ?').get(d) as { n: number }).n;
  const reports = (db.prepare('SELECT COUNT(*) n FROM reports WHERE report_day <= ?').get(d) as { n: number }).n;
  const st = (db.prepare(`SELECT COUNT(*) n FROM stocks WHERE status = 'st'`).get() as { n: number }).n;
  rows.push({ day: d, close: close === undefined ? 'NaN' : (close / 100).toFixed(2),
    up: ud.up, down: ud.dn, news, reports, st });
}
engine.catchUpTo(GENESIS_MS + days * DAY_MS); // days 非 10 的倍数时补足尾段

const pad = (v: string | number, w: number): string => String(v).padStart(w);
console.log(`simulate: days=${days} seed=${seed} genesis=${GENESIS_MS}`);
console.log([pad('day', 5), pad('IDX:COMP', 10), pad('涨家', 6), pad('跌家', 6),
  pad('累计新闻', 10), pad('累计财报', 10), pad('ST家数', 8)].join(''));
for (const r of rows) {
  console.log([pad(r.day, 5), pad(r.close, 10), pad(r.up, 6), pad(r.down, 6),
    pad(r.news, 10), pad(r.reports, 10), pad(r.st, 8)].join(''));
}

const alive = (db.prepare(`SELECT COUNT(*) n FROM stocks WHERE status != 'delisted'`).get() as { n: number }).n;
const delisted = (db.prepare(`SELECT COUNT(*) n FROM stocks WHERE status = 'delisted'`).get() as { n: number }).n;
const mm = db.prepare(`SELECT MIN(t.price) lo, MAX(t.price) hi FROM stock_state t
  JOIN stocks s ON s.code = t.code WHERE s.status != 'delisted'`).get() as { lo: number; hi: number };
console.log(`summary: alive=${alive} delisted=${delisted} ` +
  `minPrice=${(mm.lo / 100).toFixed(2)} maxPrice=${(mm.hi / 100).toFixed(2)}`);
db.close();
