// components/NewsRelatedTag.tsx —— 新闻条目旁的「关联标的 + 当日实际涨跌」。
//
// 为什么抽成组件：`News.tsx`（独立板块）与 `Market.tsx`（最新新闻卡片）都要它。
// 两处各写一份必然会漂移（比如一边改了 0% 的处理、另一边没改）—— 本仓已有同类教训。
//
// 语义（与真实行情终端一致）：挂的是**关联标的的实时行情快照**，不是对新闻影响的预测。
// 标的已退市/无行情时服务端给 `related = null`，此时**整段不渲染** ——
// 显示 `0.00%` 会让人误读成「没动」，而真相是「没有行情可挂」。
import { Link } from 'react-router-dom';
import type { NewsRelated } from '../api.js';
import { fmtPct } from '../format.js';

export default function NewsRelatedTag({ related }: {
  related?: NewsRelated | null;
}): React.JSX.Element | null {
  if (related === null || related === undefined) return null;
  const tone = related.chgPct > 0 ? 'up' : related.chgPct < 0 ? 'down' : 'flat';
  const body = (
    <>
      <span className="news__related-name">{related.name}</span>
      <span className={`news__related-chg num ${tone}`}>{fmtPct(related.chgPct)}</span>
    </>
  );
  // 板块/大盘没有详情页（code 为 null）→ 只显示文字，不做成链接
  return related.code !== null ? (
    <Link to={`/market/${related.code}`} className="news__related" data-testid="news-related">
      {body}
    </Link>
  ) : (
    <span className="news__related" data-testid="news-related">{body}</span>
  );
}
