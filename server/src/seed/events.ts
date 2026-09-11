export interface EventType { id: string; scope: 'MKT' | 'SEC' | 'STK'; title: string; // 含 {name} 占位
  lo: number; hi: number;   // 对数收益冲击区间（正负号含方向）
  driftDays: number; weight: number; }

// 规格附录 B 全表逐行转录（30 条：6 MKT + 8 SEC + 16 STK）
export const EVENT_TYPES: EventType[] = [
  // —— 全市场（6）——
  { id: 'MKT_RRR_CUT', scope: 'MKT', title: '央行宣布降准，流动性宽松', lo: 0.01, hi: 0.03, driftDays: 2, weight: 1 },
  { id: 'MKT_RATE_HIKE', scope: 'MKT', title: '央行加息，资金面收紧', lo: -0.03, hi: -0.01, driftDays: 2, weight: 1 },
  { id: 'MKT_ECON_BEAT', scope: 'MKT', title: '经济数据超预期，市场信心提振', lo: 0.005, hi: 0.02, driftDays: 1, weight: 1 },
  { id: 'MKT_ECON_MISS', scope: 'MKT', title: '经济数据低迷，市场情绪承压', lo: -0.02, hi: -0.005, driftDays: 1, weight: 1 },
  { id: 'MKT_GLOBAL_CRASH', scope: 'MKT', title: '外围市场暴跌，恐慌情绪传导', lo: -0.05, hi: -0.02, driftDays: 1, weight: 1 },
  { id: 'MKT_LONG_FUNDS_POLICY', scope: 'MKT', title: '中长期资金入市政策出台', lo: 0.01, hi: 0.04, driftDays: 3, weight: 1 },
  // —— 板块（8）——
  { id: 'SEC_POLICY_SUPPORT', scope: 'SEC', title: '{name}行业获扶持政策，板块走强', lo: 0.02, hi: 0.06, driftDays: 3, weight: 1 },
  { id: 'SEC_REGULATION_TIGHTEN', scope: 'SEC', title: '{name}行业监管收紧，板块承压', lo: -0.06, hi: -0.02, driftDays: 3, weight: 1 },
  { id: 'SEC_RAW_MATERIAL_UP', scope: 'SEC', title: '{name}上游原料涨价，成本压力上升', lo: -0.04, hi: -0.01, driftDays: 2, weight: 1 },
  { id: 'SEC_PRODUCT_PRICE_UP', scope: 'SEC', title: '{name}迎来产品涨价潮', lo: 0.02, hi: 0.05, driftDays: 2, weight: 1 },
  { id: 'SEC_TECH_BREAKTHROUGH', scope: 'SEC', title: '{name}行业技术突破，前景看好', lo: 0.02, hi: 0.07, driftDays: 3, weight: 1 },
  { id: 'SEC_OVERCAPACITY_ALERT', scope: 'SEC', title: '{name}产能过剩警报拉响', lo: -0.05, hi: -0.02, driftDays: 2, weight: 1 },
  { id: 'SEC_BOOM_DATA', scope: 'SEC', title: '{name}景气数据向好', lo: 0.01, hi: 0.03, driftDays: 1, weight: 1 },
  { id: 'SEC_SAFETY_ACCIDENT', scope: 'SEC', title: '{name}发生重大安全事故', lo: -0.06, hi: -0.02, driftDays: 1, weight: 1 },
  // —— 个股（16）——
  { id: 'STK_EARNINGS_PREANNOUNCE_UP', scope: 'STK', title: '{name}发布业绩预增公告', lo: 0.03, hi: 0.09, driftDays: 2, weight: 1 },
  { id: 'STK_EARNINGS_PREANNOUNCE_LOSS', scope: 'STK', title: '{name}发布业绩预亏公告', lo: -0.09, hi: -0.03, driftDays: 2, weight: 1 },
  { id: 'STK_BIG_ORDER_WIN', scope: 'STK', title: '{name}大额订单中标', lo: 0.02, hi: 0.07, driftDays: 1, weight: 1 },
  { id: 'STK_PRODUCT_PRICE_CUT', scope: 'STK', title: '{name}核心产品降价', lo: -0.06, hi: -0.02, driftDays: 2, weight: 1 },
  { id: 'STK_MA_RUMOR', scope: 'STK', title: '{name}并购重组传闻发酵', lo: 0.03, hi: 0.10, driftDays: 2, weight: 1 },
  { id: 'STK_MA_FAILED', scope: 'STK', title: '{name}并购告吹', lo: -0.08, hi: -0.03, driftDays: 1, weight: 1 },
  { id: 'STK_HOLDER_INCREASE', scope: 'STK', title: '{name}大股东增持', lo: 0.01, hi: 0.04, driftDays: 1, weight: 1 },
  { id: 'STK_HOLDER_REDUCE', scope: 'STK', title: '{name}大股东减持', lo: -0.05, hi: -0.02, driftDays: 1, weight: 1 },
  { id: 'STK_BUYBACK_PLAN', scope: 'STK', title: '{name}公布回购计划', lo: 0.01, hi: 0.05, driftDays: 2, weight: 1 },
  { id: 'STK_PLACEMENT_DILUTION', scope: 'STK', title: '{name}定增摊薄股本', lo: -0.04, hi: -0.01, driftDays: 1, weight: 1 },
  { id: 'STK_EXECUTIVE_DEPARTURE', scope: 'STK', title: '{name}核心高管离职', lo: -0.04, hi: -0.01, driftDays: 1, weight: 1 },
  { id: 'STK_STAR_FUND_VISIT', scope: 'STK', title: '{name}获明星基金调研', lo: 0.01, hi: 0.04, driftDays: 1, weight: 1 },
  { id: 'STK_REGULATORY_PROBE', scope: 'STK', title: '{name}遭监管立案调查', lo: -0.12, hi: -0.05, driftDays: 3, weight: 1 },
  { id: 'STK_FRAUD_EXPOSED', scope: 'STK', title: '{name}财务造假曝光', lo: -0.18, hi: -0.08, driftDays: 4, weight: 1 },
  { id: 'STK_CONTRACT_DEFAULT', scope: 'STK', title: '{name}重大合同违约', lo: -0.08, hi: -0.03, driftDays: 2, weight: 1 },
  { id: 'STK_OVERSEAS_EXPANSION', scope: 'STK', title: '{name}出海拓展成功', lo: 0.02, hi: 0.06, driftDays: 2, weight: 1 },
];
