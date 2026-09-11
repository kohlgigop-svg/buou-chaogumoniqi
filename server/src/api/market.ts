// api/market.ts —— 行情/新闻/排行（只读，多数无需鉴权）：大盘概览、全市场列表、个股详情、
// K 线、新闻流、公告、排行榜。
//
// 口径：chgPct = (price − prev_close) / prev_close（prev_close 为 0 时按 0）。
// 板块涨跌 = 板块内个股 chgPct 简单平均。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/database.js';
import { valuation } from '../domain/portfolio.js';
import { engineDay } from '../core/clock.js';

export interface MarketDeps { db: DB }

const PageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().min(1).optional(),
});
const LeaderboardSchema = z.object({ by: z.enum(['total', 'return']).optional() });
const CandlesSchema = z.object({ type: z.enum(['day', 'tick']).optional() });
const CodeParamSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

interface QuoteRow { code: string; name: string; sector: string; board: string; status: string;
  price: number; pc: number; volume: number; turnover: number; eps_e6: number; pe: number }

/** 全市场行情基表（含未退市股）。 */
function quoteRows(db: DB): QuoteRow[] {
  return db.prepare(`SELECT s.code, s.name, s.sector, s.board, s.status,
      t.price, t.prev_close pc, t.volume, t.turnover, t.eps_e6, t.pe
    FROM stocks s JOIN stock_state t ON t.code = s.code
    WHERE s.status != 'delisted' ORDER BY s.code`).all() as QuoteRow[];
}

function chgPct(price: number, pc: number): number { return pc > 0 ? (price - pc) / pc : 0; }

export async function registerMarketRoutes(app: FastifyInstance, deps: MarketDeps): Promise<void> {
  const { db } = deps;

  /** 大盘概览：指数现值+涨跌、20 板块、涨跌家数、成交额、涨跌幅前 5。 */
  app.get('/api/market/overview', async () => {
    const rows = quoteRows(db);
    // 指数现值：优先当日 tick 快照，回落最新日 K（candles_day 价格 = 指数点 ×100）。
    const idxNow = db.prepare(`SELECT price FROM ticks WHERE code = 'IDX:COMP'
      ORDER BY day DESC, tick DESC LIMIT 1`).get() as { price: number } | undefined;
    const idxDay = db.prepare(`SELECT c FROM candles_day WHERE code = 'IDX:COMP'
      ORDER BY day DESC LIMIT 2`).all() as { c: number }[];
    const level = idxNow?.price ?? idxDay[0]?.c ?? 300_000;
    const prevLevel = idxDay[1]?.c ?? idxDay[0]?.c ?? level;
    const sectors = new Map<string, number[]>();
    for (const r of rows) {
      const arr = sectors.get(r.sector) ?? [];
      arr.push(chgPct(r.price, r.pc));
      sectors.set(r.sector, arr);
    }
    const withChg = rows.map(r => ({ ...r, chg: chgPct(r.price, r.pc) }));
    const sorted = [...withChg].sort((a, b) => b.chg - a.chg);
    const top = (n: number): { code: string; name: string; chgPct: number; price: number }[] =>
      (n > 0 ? sorted.slice(0, n) : sorted.slice(n))
        .map(({ code, name, chg, price }) => ({ code, name, chgPct: chg, price }));
    return {
      index: { code: 'IDX:COMP', level: level / 100,
        chgPct: prevLevel > 0 ? (level - prevLevel) / prevLevel : 0 },
      sectors: [...sectors.entries()].map(([name, arr]) => ({
        name, chgPct: arr.reduce((a, b) => a + b, 0) / arr.length })),
      advancers: withChg.filter(r => r.chg > 0).length,
      decliners: withChg.filter(r => r.chg < 0).length,
      turnover: rows.reduce((a, r) => a + r.turnover, 0),
      topGainers: top(5),
      topLosers: top(-5),
    };
  });

  /** 全市场股票列表。 */
  app.get('/api/stocks', async () => ({
    stocks: quoteRows(db).map(r => ({
      code: r.code, name: r.name, sector: r.sector, board: r.board, status: r.status,
      st: r.status === 'st', price: r.price, chgPct: chgPct(r.price, r.pc),
      volume: r.volume, turnover: r.turnover,
    })),
  }));

  /** 个股详情：quote + 最近 8 期财报 + 近 10 条分红 + 近 20 条新闻 + 基本面。 */
  app.get('/api/stocks/:code', async (req, reply) => {
    const { code } = CodeParamSchema.parse(req.params);
    const q = quoteRows(db).find(r => r.code === code);
    if (q === undefined) return reply.status(404).send({ code: 'NOT_FOUND', message: 'stock not found' });
    const reports = db.prepare(`SELECT period_idx periodIdx, report_day reportDay, eps_e6 epsE6,
        revenue, profit, surprise_e6 surpriseE6 FROM reports WHERE code = ?
      ORDER BY period_idx DESC LIMIT 8`).all(code);
    const dividends = db.prepare(`SELECT announced_day announcedDay, ex_day exDay,
        per_share_e6 perShareE6 FROM dividends WHERE code = ? ORDER BY ex_day DESC LIMIT 10`).all(code);
    const news = db.prepare(`SELECT id, day, tick, scope, type_id typeId, title, impact_e6 impactE6
      FROM news WHERE (scope = 'STK' AND target = ?) OR (scope = 'SEC' AND target = ?)
      ORDER BY id DESC LIMIT 20`).all(code, q.sector);
    return {
      quote: { code: q.code, name: q.name, sector: q.sector, board: q.board, status: q.status,
        price: q.price, prevClose: q.pc, chgPct: chgPct(q.price, q.pc),
        volume: q.volume, turnover: q.turnover, limitUp: limitOf(db, code, 'up'),
        limitDown: limitOf(db, code, 'down') },
      reports, dividends, news,
      fundamental: { eps: q.eps_e6 / 1_000_000, pe: q.pe },
    };
  });

  /** K 线：day → 全量日 K 升序；tick → 当日分时。 */
  app.get('/api/stocks/:code/candles', async (req, reply) => {
    const { code } = CodeParamSchema.parse(req.params);
    const { type } = CandlesSchema.parse(req.query);
    const exists = db.prepare('SELECT 1 x FROM stocks WHERE code = ? AND status != \'delisted\'').get(code);
    if (exists === undefined) return reply.status(404).send({ code: 'NOT_FOUND', message: 'stock not found' });
    if (type === 'tick') {
      const day = engineDay(db);
      const candles = db.prepare(`SELECT tick, price, volume FROM ticks
        WHERE code = ? AND day = ? ORDER BY tick`).all(code, day);
      return { code, type: 'tick', day, candles };
    }
    const candles = db.prepare(`SELECT day, o, h, l, c, volume, turnover FROM candles_day
      WHERE code = ? ORDER BY day`).all(code);
    return { code, type: 'day', candles };
  });

  /** 新闻流（倒序分页）。 */
  app.get('/api/news', async (req) => {
    const { limit, before } = PageSchema.parse(req.query);
    const n = Math.min(limit ?? 50, 200);
    const conds = ['1=1']; const params: number[] = [];
    if (before !== undefined) { conds.push('id < ?'); params.push(before); }
    const items = db.prepare(`SELECT id, day, tick, scope, target, type_id typeId, title,
        impact_e6 impactE6, drift_days driftDays FROM news WHERE ${conds.join(' AND ')}
      ORDER BY id DESC LIMIT ?`).all(...params, n) as { id: number }[];
    const last = items[items.length - 1];
    return { items, nextBefore: last !== undefined ? last.id : null };
  });

  /** 公告（玩家可见）。 */
  app.get('/api/announcements', async () => ({
    items: db.prepare(`SELECT id, day, content, created_at createdAt FROM announcements
      ORDER BY id DESC LIMIT 50`).all(),
  }));

  /** 排行榜：全体非系统用户，按总资产或收益率排序，取前 100。 */
  app.get('/api/leaderboard', async (req) => {
    const { by } = LeaderboardSchema.parse(req.query);
    const users = db.prepare(`SELECT id, username, bankrupt_count bc FROM users
      WHERE kind = 'user' ORDER BY id`).all() as { id: number; username: string; bc: number }[];
    const rows = users.map(u => {
      const v = valuation(db, u.id);
      return { username: u.username, totalAssets: v.totalAssets, returnPct: v.returnPct,
        bankruptCount: u.bc, bankrupt: u.bc > 0, id: u.id };
    });
    rows.sort((a, b) => by === 'return'
      ? b.returnPct - a.returnPct || a.id - b.id
      : b.totalAssets - a.totalAssets || a.id - b.id);
    return { by: by ?? 'total', rows: rows.slice(0, 100).map(({ id, ...r }) => { void id; return r; }) };
  });
}

function limitOf(db: DB, code: string, which: 'up' | 'down'): number {
  const r = db.prepare(`SELECT limit_up u, limit_down d FROM stock_state WHERE code = ?`).get(code) as
    { u: number; d: number } | undefined;
  if (r === undefined) return 0;
  return which === 'up' ? r.u : r.d;
}
