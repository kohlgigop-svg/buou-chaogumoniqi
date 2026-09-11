// components/StockRow.tsx —— 行情列表中的一行（代码 / 名称 / 现价 / 涨跌幅 / 成交额）。
// 复用度高：行情列表、搜索结果都用它。
import { Link } from 'react-router-dom';
import type { StockRow as Stock } from '../api.js';
import { fmtMoney, fmtPct, fmtCompactMoney } from '../format.js';

export interface StockRowProps {
  stock: Stock;
  /** 是否展示成交额列（搜索结果窄列时可关掉）。 */
  showTurnover?: boolean;
}

function tone(chgPct: number): string {
  if (chgPct > 0) return 'up';
  if (chgPct < 0) return 'down';
  return 'flat';
}

export default function StockRowItem({ stock, showTurnover = true }: StockRowProps): React.JSX.Element {
  const t = tone(stock.chgPct);
  return (
    <li className="srow" data-testid="stock-row">
      <Link to={`/market/${stock.code}`} className="srow__main">
        <span className="srow__name">{stock.name}</span>
        <span className="srow__meta">
          <span className="num">{stock.code}</span>
          {stock.st ? <span className="tag tag--st">ST</span> : null}
          <span className="srow__sector">{stock.sector}</span>
        </span>
      </Link>
      <span className={`srow__chg num ${t}`} data-testid="stock-chg">{fmtPct(stock.chgPct)}</span>
      <span className="srow__price num">
        {fmtMoney(stock.price)}
        {showTurnover ? <span className="srow__sub">{fmtCompactMoney(stock.turnover)}</span> : null}
      </span>
    </li>
  );
}
