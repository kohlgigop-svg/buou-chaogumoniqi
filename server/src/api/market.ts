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

/**
 * 指数现值与涨跌。口径：优先当日 tick 快照，回落最新日 K（candles_day 价格 = 指数点 ×100）。
 * 抽成函数是因为 `/api/market/overview` 与新闻的「关联标的」都要它 ——
 * 两处各算一遍迟早漂移（本仓已因同类问题踩过坑）。
 */
function indexLevel(db: DB): { level: number; chgPct: number } {
  const now = db.prepare(`SELECT price FROM ticks WHERE code = 'IDX:COMP'
    ORDER BY day DESC, tick DESC LIMIT 1`).get() as { price: number } | undefined;
  const days = db.prepare(`SELECT c FROM candles_day WHERE code = 'IDX:COMP'
    ORDER BY day DESC LIMIT 2`).all() as { c: number }[];
  const level = now?.price ?? days[0]?.c ?? 300_000;
  const prev = days[1]?.c ?? days[0]?.c ?? level;
  return { level, chgPct: prev > 0 ? (level - prev) / prev : 0 };
}

/**
 * 新闻条目旁的「涨跌」—— 是关联标的**当日实际涨跌**，不是预测。
 *
 * 真实行情终端（同花顺/东方财富/Wind）挂在新闻旁的就是这个：一条新闻 + 它
 * 关联个股/板块/大盘的**实时行情快照**。没有哪家会给新闻附一个「预计涨幅」。
 *
 * ⚠️ 我们**故意不再下发 `impact_e6`**（模型内部的冲击强度）。它是前视信息：
 *    新闻在 `tick ∈ [60,1159)` 到达，冲击还没释放完，玩家看到 `+5.2%` 就知道该买什么
 *    —— 那不是「看新闻」，是「读答案」。标题本身已经给了方向（「业绩预增」= 利好），
 *    幅度交给玩家自己判断，才与真实市场同构。
 */
export interface NewsRelated { code: string | null; name: string; chgPct: number }

function newsRelatedLookup(db: DB): (scope: string, target: string | null) => NewsRelated | null {
  const rows = quoteRows(db);
  const byCode = new Map(rows.map(r => [r.code, { name: r.name, chg: chgPct(r.price, r.pc) }]));
  const bySector = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const s = bySector.get(r.sector) ?? { sum: 0, n: 0 };
    s.sum += chgPct(r.price, r.pc); s.n += 1;
    bySector.set(r.sector, s);
  }
  const idx = indexLevel(db);
  return (scope, target) => {
    if (scope === 'STK') {
      const hit = target === null ? undefined : byCode.get(target);
      // 退市股不在 quoteRows 里 → 没有行情可挂，返回 null（UI 不渲染那一段）
      return hit === undefined ? null : { code: target, name: hit.name, chgPct: hit.chg };
    }
    if (scope === 'SEC') {
      const s = target === null ? undefined : bySector.get(target);
      return s === undefined || s.n === 0 ? null : { code: null, name: target as string, chgPct: s.sum / s.n };
    }
    return { code: 'IDX:COMP', name: '大盘', chgPct: idx.chgPct };
  };
}

export async function registerMarketRoutes(app: FastifyInstance, deps: MarketDeps): Promise<void> {
  const { db } = deps;

  /** 大盘概览：指数现值+涨跌、20 板块、涨跌家数、成交额、涨跌幅前 5。 */
  app.get('/api/market/overview', async () => {
    const rows = quoteRows(db);
    const { level, chgPct: idxChg } = indexLevel(db);
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
      index: { code: 'IDX:COMP', level: level / 100, chgPct: idxChg },
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
    const news = db.prepare(`SELECT id, day, tick, scope, type_id typeId, title
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

  /**
   * 新闻流（倒序分页）。每条带 `related` = 关联标的的**当日实际涨跌**
   * （个股→该股、板块→板块均涨跌、全市场→指数）。**不下发 `impact_e6`**，理由见
   * `newsRelatedLookup` 的注释：那是前视信息，等于把答案印在新闻上。
   */
  app.get('/api/news', async (req) => {
    const { limit, before } = PageSchema.parse(req.query);
    const n = Math.min(limit ?? 50, 200);
    const conds = ['1=1']; const params: number[] = [];
    if (before !== undefined) { conds.push('id < ?'); params.push(before); }
    const rows = db.prepare(`SELECT id, day, tick, scope, target, type_id typeId, title
      FROM news WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params, n) as
      { id: number; scope: string; target: string | null }[];
    const related = newsRelatedLookup(db);
    const items = rows.map(r => ({ ...r, related: related(r.scope, r.target) }));
    const last = rows[rows.length - 1];
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
