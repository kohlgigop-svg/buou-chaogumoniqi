// components/FinancePanel.tsx —— 财报（近 8 期）+ 基本面（EPS/PE）+ 分红（近 10 条）。
//
// 单位口径：
// - `reports.epsE6` / `dividends.perShareE6` / `fundamental.eps` 都是 **e6**（1e6 = 1 单位）。
//   注意 `fundamental.eps` 服务端**已除以 1e6**（`market.ts:100` 的 `q.eps_e6 / 1_000_000`），
//   故它是「元」的浮点数，直接 `toFixed(2)`；而 `epsE6` 仍需 /1e6。
// - `revenue` / `profit`（单位：分）是**累计值**，直接格式化。
// - `surpriseE6` 是「超预期幅度」的 e6 比例，正为超预期。
//
// 注：**不展示「总市值」** —— 服务端 quote 未暴露总股本，无法算出真实市值。
// 编一个数字（哪怕显示 0）都比不显示更糟，故留空待服务端补字段。
import type { ReportRow, DividendRow } from '../api.js';
import { fmtMoney, fmtCompactMoney, fmtPct } from '../format.js';

/** e6 → 保留两位小数的数值文本（eps 常用）。 */
function fmtE6(v: number, digits = 2): string {
  return (v / 1e6).toFixed(digits);
}

export interface FinancePanelProps {
  reports: ReportRow[];
  dividends: DividendRow[];
  fundamental: { eps: number; pe: number };
}

export default function FinancePanel({
  reports, dividends, fundamental,
}: FinancePanelProps): React.JSX.Element {
  return (
    <div className="fin">
      <div className="fin__stats">
        <div className="stat">
          <div className="stat__label">每股收益（EPS）</div>
          <div className="stat__value num">{fundamental.eps.toFixed(2)}</div>
        </div>
        <div className="stat">
          <div className="stat__label">市盈率（PE）</div>
          <div className="stat__value num">
            {fundamental.pe > 0 ? fundamental.pe.toFixed(2) : '亏损'}
          </div>
        </div>
      </div>

      <h4 className="fin__h">近期财报</h4>
      {reports.length === 0 ? (
        <p className="fin__empty">暂无财报</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>期</th><th>披露日</th>
              <th className="ta-r">每股收益</th><th className="ta-r">营收</th>
              <th className="ta-r">净利</th><th className="ta-r">超预期</th>
            </tr>
          </thead>
          <tbody>
            {reports.map(r => (
              <tr key={r.periodIdx} data-testid="report-row">
                <td className="num">第 {r.periodIdx} 期</td>
                <td className="num">第 {r.reportDay} 日</td>
                <td className="ta-r num">{fmtE6(r.epsE6)}</td>
                <td className="ta-r num">{fmtCompactMoney(r.revenue)}</td>
                <td className={`ta-r num ${r.profit >= 0 ? 'up' : 'down'}`}>{fmtCompactMoney(r.profit)}</td>
                <td className={`ta-r num ${r.surpriseE6 > 0 ? 'up' : r.surpriseE6 < 0 ? 'down' : 'flat'}`}>
                  {fmtPct(r.surpriseE6 / 1e6)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4 className="fin__h">分红记录</h4>
      {dividends.length === 0 ? (
        <p className="fin__empty">暂无分红</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>公告日</th><th>除权日</th><th className="ta-r">每股分红</th></tr>
          </thead>
          <tbody>
            {dividends.map(d => (
              <tr key={`${d.announcedDay}-${d.exDay}`} data-testid="dividend-row">
                <td className="num">第 {d.announcedDay} 日</td>
                <td className="num">第 {d.exDay} 日</td>
                <td className="ta-r num">{fmtMoney(Math.round(d.perShareE6 / 1e4))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
