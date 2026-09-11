// engine/reports.ts —— 财报披露：披露排期 + 单只披露（RNG 每次恰好 2 抽：normal→next）
import type { DB } from '../db/database.js';
import { fnv1a, type Rng } from '../core/rng.js';
import type { Config } from '../config/defaults.js';

function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }

// code 的披露偏移：fnv1a(code) % 60（与 listed_day 叠加得披露日）
export function reportOffset(code: string): number { return fnv1a(code) % 60; }

// day 应披露的 code 列表：listed_day + offset + k*reportPeriodDays（k>=0），按 code 排序
export function reportDueCodes(db: DB, day: number, cfg: Config): string[] {
  const rows = db.prepare(`SELECT code, listed_day ld FROM stocks
    WHERE status != 'delisted' AND listed_day <= ? ORDER BY code`).all(day) as { code: string; ld: number }[];
  const out: string[] = [];
  for (const r of rows) {
    const off = reportOffset(r.code);
    if (day >= r.ld + off && (day - r.ld - off) % cfg.reportPeriodDays === 0) out.push(r.code);
  }
  return out;
}

// 披露一期财报：写 reports 行、更新 equity/连亏连盈、写次日开盘 REPORT 新闻（drift 2 日）
export function publishReport(db: DB, code: string, day: number, rng: Rng, cfg: Config): { eps_e6: number; surprise_e6: number } {
  const n = rng.normal(); // 抽签 1：披露噪声
  const u = rng.next();   // 抽签 2：营收倍数
  const st = db.prepare('SELECT eps_e6 FROM stock_state WHERE code = ?').get(code) as { eps_e6: number } | undefined;
  const stock = db.prepare('SELECT name, shares_total FROM stocks WHERE code = ?').get(code) as
    { name: string; shares_total: number } | undefined;
  if (!st || !stock) throw new Error(`unknown stock ${code}`);

  const epsRep = Math.round(st.eps_e6 * (1 + n * cfg.anchor.reportNoise));
  const prev = db.prepare('SELECT period_idx pi, eps_e6 FROM reports WHERE code = ? ORDER BY period_idx DESC LIMIT 1')
    .get(code) as { pi: number; eps_e6: number } | undefined;
  const expected = prev?.eps_e6 ?? st.eps_e6;
  const ratio = (epsRep - expected) / Math.max(Math.abs(expected), Math.abs(st.eps_e6) * 0.2, 1);
  const surprise_e6 = Math.round(ratio * 1e6);
  const periodIdx = (prev?.pi ?? 0) + 1;
  const profit = Math.round(epsRep * stock.shares_total / 1e4);      // 分
  const revenue = Math.round(Math.abs(profit) * (4 + u * 8));        // 分

  db.transaction(() => {
    db.prepare(`INSERT INTO reports(code,period_idx,report_day,eps_e6,revenue,profit,surprise_e6)
      VALUES (?,?,?,?,?,?,?)`).run(code, periodIdx, day, epsRep, revenue, profit, surprise_e6);
    if (epsRep < 0)
      db.prepare(`UPDATE stock_state SET equity_e6 = equity_e6 + ?, loss_streak = loss_streak + 1, win_streak = 0
        WHERE code = ?`).run(epsRep, code);
    else
      db.prepare(`UPDATE stock_state SET equity_e6 = equity_e6 + ?, win_streak = win_streak + 1, loss_streak = 0
        WHERE code = ?`).run(epsRep, code);
    // 盘后披露、次日开盘释放
    db.prepare(`INSERT INTO news(day,tick,scope,target,type_id,title,impact_e6,drift_days)
      VALUES (?,60,'STK',?,?,?,?,2)`).run(day + 1, code, 'REPORT',
      `${stock.name}披露财报，业绩${surprise_e6 >= 0 ? '超出' : '不及'}预期`,
      Math.round(clamp(ratio * 0.5, -0.10, 0.10) * 1e6));
  })();
  return { eps_e6: epsRep, surprise_e6 };
}
