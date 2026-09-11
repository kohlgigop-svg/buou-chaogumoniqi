// engine/corporate.ts —— ST/退市迁移、分红派现、IPO 补位排队
import { ACC, type DB } from '../db/database.js';
import type { Rng } from '../core/rng.js';
import type { Config } from '../config/defaults.js';
import { post } from '../core/ledger.js';
import { roundHalfUpDiv, dividendTax } from '../core/money.js';
import { limitPrices } from './limits.js';
import { SPARE_NAMES } from '../seed/stocks.js';

function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }

// 公司行为公告统一为「盘后发布、次日开盘释放」：day+1 / tick 60 / STK
function insertNews(db: DB, day: number, code: string, typeId: string, title: string): void {
  db.prepare(`INSERT INTO news(day,tick,scope,target,type_id,title,impact_e6,drift_days)
    VALUES (?,60,'STK',?,?,?,0,0)`).run(day + 1, code, typeId, title);
}

// ST / 退市整理 / 撤销 ST 状态机（财报披露后调用；不消耗 RNG）
export function applyStTransitions(db: DB, code: string, day: number, cfg: Config): 'none' | 'st' | 'delisting' {
  const s = db.prepare('SELECT status, name FROM stocks WHERE code = ?').get(code) as
    { status: string; name: string } | undefined;
  const t = db.prepare('SELECT loss_streak ls, win_streak ws, equity_e6 eq FROM stock_state WHERE code = ?')
    .get(code) as { ls: number; ws: number; eq: number } | undefined;
  if (!s || !t) throw new Error(`unknown stock ${code}`);
  if (s.status === 'normal' && t.ls >= cfg.stRule.lossToSt) {
    db.prepare(`UPDATE stocks SET status='st', st_since_day=? WHERE code=?`).run(day, code);
    insertNews(db, day, code, 'ST_FLAG', `${s.name}被实施ST警示`);
    return 'st';
  }
  if (s.status === 'st' && (t.ls >= cfg.stRule.lossToSt + cfg.stRule.stLossToDelist || t.eq < 0)) {
    db.prepare(`UPDATE stocks SET status='delisting', delist_at_day=? WHERE code=?`).run(day + cfg.stRule.delistDays, code);
    insertNews(db, day, code, 'DELIST_START', `${s.name}进入退市整理期`);
    return 'delisting';
  }
  if (s.status === 'st' && t.ws >= 2) {
    db.prepare(`UPDATE stocks SET status='normal', st_since_day=NULL WHERE code=?`).run(code);
    insertNews(db, day, code, 'ST_REMOVED', `${s.name}撤销ST警示`);
    return 'none';
  }
  return 'none';
}

// 到期摘牌：按 cfg.stRule.recovery 回收派给持有人（经 @market），清持仓，发 DELISTED 公告
export function processDelistings(db: DB, day: number, cfg: Config): string[] {
  const rows = db.prepare(`SELECT s.code, s.name, t.price FROM stocks s JOIN stock_state t ON t.code = s.code
    WHERE s.status = 'delisting' AND s.delist_at_day <= ? ORDER BY s.code`).all(day) as
    { code: string; name: string; price: number }[];
  const codes: string[] = [];
  const setDead = db.prepare(`UPDATE stocks SET status='delisted' WHERE code=?`);
  const selHold = db.prepare('SELECT user_id, qty_total FROM holdings WHERE code=? AND qty_total>0 ORDER BY user_id');
  const delHold = db.prepare('DELETE FROM holdings WHERE user_id=? AND code=?');
  db.transaction(() => {
    for (const r of rows) {
      setDead.run(r.code);
      const recovery = roundHalfUpDiv(r.price * Math.round(cfg.stRule.recovery * 1000), 1000); // 每股回收比例（分）
      for (const h of selHold.all(r.code) as { user_id: number; qty_total: number }[]) {
        post(db, day, 1180, 'delist', 0, [
          { account: ACC.MARKET, bucket: 'A', amount: -recovery * h.qty_total, kind: 'DELIST_RECOVERY' },
          { account: h.user_id, bucket: 'A', amount: recovery * h.qty_total, kind: 'DELIST_RECOVERY' },
        ]);
        delHold.run(h.user_id, r.code);
      }
      insertNews(db, day, r.code, 'DELISTED', `${r.name}摘牌退市`);
      codes.push(r.code);
    }
  })();
  return codes;
}

// 盈利期宣告分红：per_share_e6 = 最新一期 eps × payoutRatio(tier)，除权日 = day+3（不消耗 RNG）
export function declareDividends(db: DB, code: string, day: number, cfg: Config): void {
  const rep = db.prepare('SELECT eps_e6 FROM reports WHERE code = ? ORDER BY period_idx DESC LIMIT 1')
    .get(code) as { eps_e6: number } | undefined;
  if (!rep || rep.eps_e6 <= 0) return;
  const s = db.prepare('SELECT payout_tier t FROM stocks WHERE code = ?').get(code) as
    { t: 'H' | 'M' | 'L' | 'N' } | undefined;
  if (!s || s.t === 'N') return;
  const perShareE6 = Math.round(rep.eps_e6 * cfg.payoutRatio[s.t]);
  if (perShareE6 > 0)
    db.prepare('INSERT INTO dividends(code,announced_day,ex_day,per_share_e6) VALUES (?,?,?,?)')
      .run(code, day, day + 3, perShareE6);
}

// 除权除息：昨收与现价同步下调（R9②：分红不白送钱）并重算涨跌停、equity 扣减、按持仓派现（含 10% 红利税；不消耗 RNG）
export function applyExDividend(db: DB, day: number, cfg: Config): void {
  const divs = db.prepare('SELECT id, code, per_share_e6 pse FROM dividends WHERE ex_day = ? ORDER BY id')
    .all(day) as { id: number; code: string; pse: number }[];
  const selHold = db.prepare('SELECT user_id, qty_total FROM holdings WHERE code=? AND qty_total>0 ORDER BY user_id');
  for (const d of divs) {
    const dCents = roundHalfUpDiv(d.pse, 10_000);
    if (dCents === 0) continue;
    const s = db.prepare('SELECT status, board FROM stocks WHERE code = ?').get(d.code) as
      { status: string; board: 'SH' | 'SZ' | 'CY' };
    const t = db.prepare('SELECT prev_close pc FROM stock_state WHERE code = ?').get(d.code) as { pc: number };
    const newPrev = Math.max(1, t.pc - dCents);
    const kind = s.status === 'st' ? 'ST' : s.board === 'CY' ? 'CY' : s.board;
    const { up, down } = limitPrices(newPrev, kind, cfg);
    db.transaction(() => {
      db.prepare(`UPDATE stock_state SET prev_close=?, limit_up=?, limit_down=?, equity_e6 = equity_e6 - ?,
        price = MAX(1, price - ?) WHERE code=?`).run(newPrev, up, down, d.pse, dCents, d.code);
      for (const h of selHold.all(d.code) as { user_id: number; qty_total: number }[]) {
        const gross = dCents * h.qty_total;
        const tax = dividendTax(gross);
        post(db, day, 1180, 'dividend', d.id, [
          { account: ACC.MARKET, bucket: 'A', amount: -gross, kind: 'DIVIDEND' },
          { account: h.user_id, bucket: 'A', amount: gross - tax, kind: 'DIVIDEND' },
          { account: ACC.TAX, bucket: 'A', amount: tax, kind: 'DIVIDEND_TAX' },
        ]);
      }
    })();
  }
}

// ---------- IPO 补位 ----------
interface PendingIpo { sector: string; board: 'SH' | 'SZ' | 'CY'; name: string; code: string;
  price0: number; sharesTotal: number; epsE6: number; dueDay: number; }

function readCfgList<T>(db: DB, key: string): T[] {
  const r = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T[]) : [];
}
function writeCfgList(db: DB, key: string, v: unknown): void {
  db.prepare(`INSERT INTO config(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(v));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// board 段内最大数字代码（含未上市的 pending，避免同板块多缺口撞码）
function maxBoardCode(db: DB, board: string, pending: PendingIpo[]): number {
  const r = db.prepare('SELECT MAX(CAST(code AS INTEGER)) m FROM stocks WHERE board = ?').get(board) as
    { m: number | null };
  let max = r.m ?? 0;
  for (const p of pending) if (p.board === board) max = Math.max(max, parseInt(p.code, 10));
  return max;
}

function sectorMedians(db: DB, sector: string): { pe: number; eps: number; shares: number } {
  const base = `SELECT t.pe pe, t.eps_e6 eps, s.shares_total sh FROM stocks s
    JOIN stock_state t ON t.code = s.code WHERE s.status != 'delisted'`;
  let rows = db.prepare(`${base} AND s.sector = ?`).all(sector) as { pe: number; eps: number; sh: number }[];
  if (rows.length === 0) rows = db.prepare(base).all() as { pe: number; eps: number; sh: number }[]; // 全市场兜底
  return { pe: median(rows.map(r => r.pe)), eps: median(rows.map(r => r.eps)), shares: median(rows.map(r => r.sh)) };
}

function scheduleOne(db: DB, pending: PendingIpo[], usedSpares: string[],
  sector: string, board: 'SH' | 'SZ' | 'CY', day: number, delay: number, u: number): void {
  const code = String(maxBoardCode(db, board, pending) + 7).padStart(6, '0');
  const spare = (SPARE_NAMES[sector] ?? []).find(nm => !usedSpares.includes(nm));
  const name = spare ?? `${sector}实业${code.slice(3)}`;
  const med = sectorMedians(db, sector);
  const epsE6 = Math.round(med.eps * (0.8 + 0.4 * u));
  const price0 = Math.max(100, Math.round(med.pe * epsE6 / 1e4));
  const sharesTotal = Math.round(med.shares);
  pending.push({ sector, board, name, code, price0, sharesTotal, epsE6, dueDay: day + delay });
  if (spare !== undefined) usedSpares.push(spare);
}

// 日初调用。RNG 消耗固定：STEP1 到期上市 0 抽；STEP2 每个缺口 2 抽（int→next）；
// STEP3 满编且未达 poolMax 时 1 抽（触发再加 3 抽：pick→int→next）。
export function scheduleIpoIfNeeded(db: DB, day: number, rng: Rng, cfg: Config): void {
  let pending = readCfgList<PendingIpo>(db, 'ipo_pending');
  const usedSpares = readCfgList<string>(db, 'used_spares');
  const replaced = readCfgList<string>(db, 'ipo_replaced');

  // STEP 1：到期上市（无 RNG），listed_day = day+1，首日涨跌停按 IPO1
  const due = pending.filter(p => p.dueDay <= day);
  if (due.length > 0) {
    const insS = db.prepare(`INSERT INTO stocks(code,name,board,sector,shares_total,vol_tier,beta,payout_tier,listed_day,status,ipo_price)
      VALUES (?,?,?,?,?,'H',1.3,'L',?,'normal',?)`);
    const insT = db.prepare(`INSERT INTO stock_state(code,price,prev_close,limit_up,limit_down,eps_e6,pe,equity_e6,adv)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const p of due) {
      const { up, down } = limitPrices(p.price0, 'IPO1', cfg);
      const pe = clamp(p.price0 / 100 / (p.epsE6 / 1e6), 8, 90);
      insS.run(p.code, p.name, p.board, p.sector, p.sharesTotal, day + 1, p.price0);
      insT.run(p.code, p.price0, p.price0, up, down, p.epsE6, pe, p.epsE6 * 8, Math.round(p.sharesTotal * 0.005));
      insertNews(db, day, p.code, 'IPO', `${p.name}上市交易`);
    }
    pending = pending.filter(p => p.dueDay > day);
  }

  // STEP 2：缺口补位排队（每缺口 2 抽：int→next）；补最早摘牌且未被补位的同板块股
  const alive = (db.prepare(`SELECT COUNT(*) c FROM stocks WHERE status != 'delisted'`).get() as { c: number }).c;
  const deficit = cfg.poolTarget - (alive + pending.length);
  for (let i = 0; i < deficit; i++) {
    const dead = (db.prepare(`SELECT code, sector, board FROM stocks WHERE status = 'delisted'
      ORDER BY delist_at_day ASC, code ASC`).all() as { code: string; sector: string; board: 'SH' | 'SZ' | 'CY' }[])
      .find(r => !replaced.includes(r.code));
    if (!dead) break; // 无未补位的摘牌股：不消耗 RNG
    const delay = 3 + rng.int(6);
    const u = rng.next();
    scheduleOne(db, pending, usedSpares, dead.sector, dead.board, day, delay, u);
    replaced.push(dead.code);
  }

  // STEP 3：满编且未达 poolMax 时 0.5% 概率随机 IPO（pick→int→next）
  if (alive + pending.length >= cfg.poolTarget && alive + pending.length < cfg.poolMax) {
    const v = rng.next();
    if (v < 0.005) {
      const sectors = (db.prepare('SELECT DISTINCT sector FROM stocks ORDER BY sector').all() as
        { sector: string }[]).map(r => r.sector);
      const sector = rng.pick(sectors);
      const delay = 3 + rng.int(6);
      const u = rng.next();
      scheduleOne(db, pending, usedSpares, sector, 'SZ', day, delay, u);
    }
  }

  writeCfgList(db, 'ipo_pending', pending);
  writeCfgList(db, 'used_spares', usedSpares);
  writeCfgList(db, 'ipo_replaced', replaced);
}
