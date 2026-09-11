// components/SectorHeatmap.tsx —— 板块热力图：格子的色相表示涨/跌，深浅表示幅度。
//
// 颜色通过 CSS 变量 `--heat`（0..1）+ tone 类交给 CSS 决定（见 theme.css 的 .heat 规则），
// 组件不拼颜色字符串——这样亮/暗主题只需改 CSS，不必改 JS。
import type { SectorView } from '../api.js';
import { heatTone, heatIntensity } from '../pages/marketLogic.js';
import { fmtPct } from '../format.js';

export interface SectorHeatmapProps {
  sectors: SectorView[];
}

export default function SectorHeatmap({ sectors }: SectorHeatmapProps): React.JSX.Element {
  if (sectors.length === 0) {
    return <div className="heat heat--empty">暂无板块数据</div>;
  }
  return (
    <div className="heat" role="list">
      {sectors.map(s => (
        <div
          key={s.name}
          role="listitem"
          className={`heat__cell ${heatTone(s.chgPct)}`}
          data-testid={`sector-${s.name}`}
          style={{ '--heat': String(heatIntensity(s.chgPct)) } as React.CSSProperties}
        >
          <span className="heat__name">{s.name}</span>
          <span className="heat__chg num">{fmtPct(s.chgPct)}</span>
        </div>
      ))}
    </div>
  );
}
