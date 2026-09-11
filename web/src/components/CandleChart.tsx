// components/CandleChart.tsx —— K 线图（分时折线 / 日 K 蜡烛），基于 lightweight-charts v5。
//
// 口径与坑位：
// - **价格单位是「分」**，但图表纵轴按「元」展示更可读，故消费时统一 ÷100。
//   这样不需要在 series 里做价格格式化 hack，浮点误差也只在展示层（≤2 位小数）。
// - v5 的 API 是 `chart.addSeries(AreaSeries|CandlestickSeries, opts)`，
//   不是 v4 的 `addAreaSeries()`；用错会直接抛错。
// - 分时图只有 `{tick, price, volume}`，**没有 `time` 字段**，需要把 tick 序号映射成
//   时间轴。这里用游戏分钟推一个「当日 UTC 秒」的伪时间，保证横轴按交易时段线性铺开。
// - 组件卸载必须 `chart.remove()`，否则 ResizeObserver 残留会报错。
import { useEffect, useRef } from 'react';
import { createChart, AreaSeries, CandlestickSeries, type IChartApi } from 'lightweight-charts';
import type { CandlesResult } from '../api.js';

/** 1 游戏日 = 1200 tick = 1440 游戏分。分时横轴按此把 tick 映射到「分钟」。 */
const TICKS_PER_DAY = 1200;
const MINS_PER_DAY = 1440;

/** 涨红跌绿（A 股惯例）——从 CSS 变量同步，避免颜色两处定义。 */
const UP = '#f5455c';
const DOWN = '#17c964';

export interface CandleChartProps {
  data: CandlesResult;
  height?: number;
}

/** tick 序号 → lightweight-charts 的时间值（秒）。用固定交易日基准，仅作像素坐标。 */
function tickToTime(day: number, tick: number): number {
  // 基准取 2000-01-01 UTC，加 (day-1) 天 + 当日分钟数；纯粹为线性铺开横轴
  const base = Date.UTC(2000, 0, 1) / 1000;
  const daySec = (day - 1) * 86_400;
  const minIntoDay = Math.floor((tick / TICKS_PER_DAY) * MINS_PER_DAY);
  return base + daySec + minIntoDay * 60;
}

export default function CandleChart({ data, height = 260 }: CandleChartProps): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const empty = data.candles.length === 0;

  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    // 空数据不建图表：lightweight-charts 在无 series 数据时会画出一个空坐标框，
    // 看起来像「图坏了」。此时直接让外层展示空态文案更诚实。
    if (data.candles.length === 0) return;

    const chart = createChart(box, {
      height,
      layout: { background: { color: 'transparent' }, textColor: '#a8b0bd', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(42,47,58,0.6)' }, horzLines: { color: 'rgba(42,47,58,0.6)' } },
      rightPriceScale: { borderColor: '#2a2f3a' },
      timeScale: { borderColor: '#2a2f3a', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScale: false,
      handleScroll: false,
    });
    chartRef.current = chart;

    if (data.type === 'tick') {
      const series = chart.addSeries(AreaSeries, {
        lineColor: UP, topColor: 'rgba(245,69,92,0.28)', bottomColor: 'rgba(245,69,92,0.02)',
        lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
      });
      series.setData(data.candles.map(c => ({
        time: tickToTime(data.day, c.tick) as never,
        value: c.price / 100,
      })));
    } else {
      const series = chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
        wickUpColor: UP, wickDownColor: DOWN,
      });
      series.setData(data.candles.map(c => ({
        time: tickToTime(c.day, 0) as never,
        open: c.o / 100, high: c.h / 100, low: c.l / 100, close: c.c / 100,
      })));
    }
    chart.timeScale().fitContent();

    // 容器宽度自适应
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined && w > 0) chart.applyOptions({ width: Math.floor(w) });
    });
    ro.observe(box);

    return () => {
      ro.disconnect();
      chart.remove();          // 必须移除，否则残留 ResizeObserver 会抛错
      chartRef.current = null;
    };
  }, [data, height]);

  return (
    <div className="chart">
      {/* 空数据时不渲染画布容器，避免出现空坐标框被误读成渲染故障 */}
      {empty ? (
        <div className="chart__blank" style={{ height }} data-testid="candle-empty">
          <span className="chart__blank-text">暂无{data.type === 'day' ? '日K' : '分时'}数据</span>
          {data.type === 'day' ? (
            <span className="chart__blank-hint">首日尚未收盘，日K需至少一个完整交易日</span>
          ) : null}
        </div>
      ) : (
        <div ref={boxRef} className="chart__box" data-testid="candle-chart" style={{ height }} />
      )}
    </div>
  );
}
