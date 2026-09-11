// engine/candles.ts —— 日 K 线、指数（除数法）、tick 清理。全部不消耗 RNG。
import type { DB } from '../db/database.js';
import type { Config } from '../config/defaults.js';

function readDivisor(db: DB, kind: string): number | null {
  const r = db.prepare('SELECT value FROM config WHERE key = ?').get(`divisor:${kind}`) as
    { value: string } | undefined;
  return r ? Number(r.value) : null;
}
function writeDivisor(db: DB, kind: string, divisor: number): void {
  db.prepare(`INSERT INTO config(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(`divisor:${kind}`, String(divisor));
}

// 成分市值（元，REAL）：COMP 全体存活股；S:<sector> 按板块过滤（Task 12 起供结算除数调整使用）
export function mcapOf(db: DB, kind: 'COMP' | `S:${string}`): number {
  if (kind === 'COMP') {
    const r = db.prepare(`SELECT COALESCE(SUM((t.price / 100.0) * s.shares_total), 0) m
      FROM stocks s JOIN stock_state t ON t.code = s.code WHERE s.status != 'delisted'`).get() as { m: number };
    return r.m;
  }
  const r = db.prepare(`SELECT COALESCE(SUM((t.price / 100.0) * s.shares_total), 0) m
    FROM stocks s JOIN stock_state t ON t.code = s.code
    WHERE s.status != 'delisted' AND s.sector = ?`).get(kind.slice(2)) as { m: number };
  return r.m;
}

// 除数法指数：divisor 惰性初始化，使初值恰为 3000（COMP）/ 1000（板块）
export function indexLevel(db: DB, kind: 'COMP' | `S:${string}`): number {
  const mcap = mcapOf(db, kind);
  const divisor = readDivisor(db, kind);
  if (divisor === null) {
    const base = kind === 'COMP' ? 3000 : 1000;
    writeDivisor(db, kind, mcap / base);
    return base;
  }
  return mcap / divisor;
}

// 成分变化日（退市/IPO）保持指数连续：divisor *= mcapAfter/mcapBefore
export function adjustDivisorOnChange(db: DB, kind: string, mcapBefore: number, mcapAfter: number): void {
  const divisor = readDivisor(db, kind);
  if (divisor !== null && mcapBefore > 0) writeDivisor(db, kind, divisor * (mcapAfter / mcapBefore));
}

function universeSectors(db: DB): string[] {
  return (db.prepare(`SELECT DISTINCT sector FROM stocks WHERE status != 'delisted' ORDER BY sector`)
    .all() as { sector: string }[]).map(r => r.sector);
}

// 开盘：重置日内聚合（open=NULL 等首个连续竞价 tick 补），并确保指数除数已初始化
export function openDay(db: DB, day: number, _cfg: Config): void {
  db.transaction(() => {
    db.prepare(`UPDATE stock_state SET volume = 0, turnover = 0, open = NULL,
      high = prev_close, low = prev_close
      WHERE code IN (SELECT code FROM stocks WHERE status != 'delisted' AND listed_day <= ?)`).run(day);
    indexLevel(db, 'COMP'); // 惰性建除数
    for (const sec of universeSectors(db)) indexLevel(db, `S:${sec}`);
  })();
}

// 收盘：全体存活股写日 K（全天无 tick → prev_close 平 K）+ COMP/20 板块指数 K；prev_close=close
export function closeDay(db: DB, day: number): void {
  const insC = db.prepare(`INSERT INTO candles_day(code,day,o,h,l,c,volume,turnover) VALUES (?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    const rows = db.prepare(`SELECT t.code, t.price, t.prev_close pc, t.open, t.high, t.low, t.volume, t.turnover
      FROM stocks s JOIN stock_state t ON t.code = s.code
      WHERE s.status != 'delisted' AND s.listed_day <= ? ORDER BY t.code`).all(day) as
      { code: string; price: number; pc: number; open: number | null; high: number | null; low: number | null;
        volume: number; turnover: number }[];
    const setPrev = db.prepare('UPDATE stock_state SET prev_close = ? WHERE code = ?');
    for (const r of rows) {
      if (r.open === null) insC.run(r.code, day, r.pc, r.pc, r.pc, r.pc, r.volume, r.turnover); // 平 K
      else insC.run(r.code, day, r.open, r.high ?? r.price, r.low ?? r.price, r.price, r.volume, r.turnover);
      setPrev.run(r.open === null ? r.pc : r.price, r.code);
    }
    // COMP 指数 K：取今日 IDX:COMP ticks（价即指数点 ×100）；无 tick 则平 K
    const idx = db.prepare(`SELECT price FROM ticks WHERE code = 'IDX:COMP' AND day = ? ORDER BY tick`)
      .all(day) as { price: number }[];
    if (idx.length > 0) {
      const ps = idx.map(r => r.price);
      insC.run('IDX:COMP', day, ps[0]!, Math.max(...ps), Math.min(...ps), ps[ps.length - 1]!, 0, 0);
    } else {
      const lv = Math.round(indexLevel(db, 'COMP') * 100);
      insC.run('IDX:COMP', day, lv, lv, lv, lv, 0, 0);
    }
    // 板块指数：每日平 K（即时值不落 tick）
    for (const sec of universeSectors(db)) {
      const lv = Math.round(indexLevel(db, `S:${sec}`) * 100);
      insC.run(`IDX:S:${sec}`, day, lv, lv, lv, lv, 0, 0);
    }
  })();
}

// 删除 3 天以前的 tick 明细
export function purgeOldTicks(db: DB, day: number): void {
  db.prepare('DELETE FROM ticks WHERE day <= ?').run(day - 3);
}
