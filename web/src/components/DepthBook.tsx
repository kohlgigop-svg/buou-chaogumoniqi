// components/DepthBook.tsx —— 五档盘口。
//
// ⚠️ **服务端没有 L2 真实盘口**（README 已知限制 3）：只有现价 `price` 与涨跌停。
// 本组件由「现价 ± 最小变动」构造**展示层示意深度**，并在 UI 上**明确标注「示意」**，
// 绝不假装是真盘口 —— 否则用户会依据假数据判断流动性，属误导。
//
// 档位价差：A 股最小变动价位 0.01 元 = 1 分，故卖档 = 现价 + i 分、买档 = 现价 − i 分。
// 数量：用代码派生的确定性伪随机（同一只股票每次渲染一致），避免每秒跳动看起来像真流动。
import type { QuoteView } from '../api.js';
import { fmtMoney, fmtQty } from '../format.js';

const LEVELS = 5;

/** 由 code 派生稳定种子：同一股票每次渲染一致，不同股票各异。 */
function seedOf(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  return h;
}

/** 确定性伪随机成交量（股），按 100 取整。 */
function fakeQty(seed: number, level: number, side: 'ask' | 'bid'): number {
  const x = Math.sin(seed + level * 977 + (side === 'ask' ? 0 : 5000)) * 10000;
  const frac = x - Math.floor(x);
  // 3,000 ~ 30,000 股，取整到 100
  return Math.floor((3_000 + frac * 27_000) / 100) * 100;
}

export interface DepthBookProps {
  quote: QuoteView;
}

export default function DepthBook({ quote }: DepthBookProps): React.JSX.Element {
  const seed = seedOf(quote.code);
  const asks = Array.from({ length: LEVELS }, (_, i) => {
    const level = LEVELS - i;                        // 卖 5 → 卖 1（自上而下）
    return { label: `卖${level}`, price: quote.price + level, qty: fakeQty(seed, level, 'ask') };
  });
  const bids = Array.from({ length: LEVELS }, (_, i) => {
    const level = i + 1;                             // 买 1 → 买 5
    return { label: `买${level}`, price: Math.max(1, quote.price - level), qty: fakeQty(seed, level, 'bid') };
  });

  return (
    <div className="depth">
      <div className="depth__note">示意深度（服务端暂无 L2 真实盘口，价位由现价推算）</div>
      <ul className="depth__list">
        {/* 卖档在现价之上 → 用「涨」色（红）；买档在现价之下 → 用「跌」色（绿）。
            A 股惯例：涨红跌绿，与盘口高低价位的方向一致（勿与欧美相反）。 */}
        {asks.map(a => (
          <li key={a.label} className="depth__row" data-testid="depth-ask">
            <span className="depth__label">{a.label}</span>
            <span className="depth__price num up">{fmtMoney(a.price)}</span>
            <span className="depth__qty num">{fmtQty(a.qty)}</span>
          </li>
        ))}
        <li className="depth__last">
          <span className="depth__label">现价</span>
          <span className={`depth__price num ${quote.chgPct > 0 ? 'up' : quote.chgPct < 0 ? 'down' : 'flat'}`}>
            {fmtMoney(quote.price)}
          </span>
          <span className="depth__qty num" />
        </li>
        {bids.map(b => (
          <li key={b.label} className="depth__row" data-testid="depth-bid">
            <span className="depth__label">{b.label}</span>
            <span className="depth__price num down">{fmtMoney(b.price)}</span>
            <span className="depth__qty num">{fmtQty(b.qty)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
