// components/Radar.tsx —— 六维能力雷达图（**手绘 SVG，不引图表库**）。
//
// 为什么手绘：① 只需要 6 个固定顶点，图表库的通用性在这里是纯负担；
// ② 这个仓已经被 lightweight-charts 的 jsdom 环境坑过一次（缺 ResizeObserver 会崩整页），
//    再引第二个图表库等于把这个风险翻倍；③ 雷达图要跟设计令牌（CSS 变量）联动，
//    自绘 SVG 直接用 `fill="var(--primary)"` 即可，无需在 JS 里复制一份颜色。
//
// 几何口径见 `pages/lifeLogic.ts` 的 `radarPoint` / `radarVertices` / `gridRing`：
// 第 0 维在正上方，顺时针均分 60°。
import {
  ABILITY_LABEL, abilityCells, axisLabelPoint, gridRing, radarVertices,
  toPointsAttr, type AbilityCell,
} from '../pages/lifeLogic.js';

export interface RadarProps {
  /** `GET /api/abilities` 的 `abilities`（`Record<kind, level>`）。 */
  abilities: Record<string, number>;
  /** 视图边长（px）。图形半径 = size/2 − padding。 */
  size?: number;
}

const GRID_LEVELS = [0.25, 0.5, 0.75, 1] as const;

export default function Radar({ abilities, size = 260 }: RadarProps): React.JSX.Element {
  // 传 nextCourseCost 空对象即可：本组件不展示费用，只需要等级
  const cells: AbilityCell[] = abilityCells(abilities, {});
  const levels = cells.map(c => c.level);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 34;               // 留出轴标签的空间

  const shape = radarVertices(levels, cx, cy, radius);

  return (
    <div className="radar">
      <svg
        className="radar__svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`能力雷达图：${cells.map(c => `${c.label} ${c.level} 级`).join('，')}`}
        data-testid="radar-svg"
      >
        {/* 同心网格（由内到外 4 层） */}
        {GRID_LEVELS.map(t => (
          <polygon
            key={`grid-${t}`}
            data-testid="radar-grid"
            className="radar__grid"
            points={toPointsAttr(gridRing(cx, cy, radius, t))}
          />
        ))}

        {/* 六条轴线 */}
        {shape.map((p, i) => (
          <line
            key={`axis-${cells[i]?.kind ?? i}`}
            className="radar__axis"
            x1={cx} y1={cy} x2={p.x} y2={p.y}
          />
        ))}

        {/* 能力多边形 */}
        <polygon
          className="radar__area"
          data-testid="radar-area"
          points={toPointsAttr(shape)}
        />

        {/* 顶点 + 轴标签 */}
        {shape.map((p, i) => {
          const cell = cells[i];
          const label = axisLabelPoint(i, cx, cy, radius);
          return (
            <g key={`v-${cell?.kind ?? i}`}>
              <circle className="radar__dot" cx={p.x} cy={p.y} r={2.5} />
              <text
                className="radar__label"
                x={label.x}
                y={label.y}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {ABILITY_LABEL[cell?.kind ?? 'EDU']}
                <tspan className="radar__lv" dx="3">{cell?.level ?? 0}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
