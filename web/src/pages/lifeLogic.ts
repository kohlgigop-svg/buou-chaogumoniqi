// pages/lifeLogic.ts —— 生活 Tab 的纯函数层（无 React、无网络，便于单测）。
//
// 单位约定（本仓最高频坑，逐一标注）：
// - 金额一律是**分**：`base_pay` / `wage` / `capCents` / `principal` / `owedTotal` …
//   展示走 `fmtMoney`（÷100 带 ¥）。
// - `rateE6` 是**日息 e6**（300 = 0.03%/日），**不是年化**；展示走 `fmtRate`。
// - 时间一律是**游戏分钟（gmin）**：1 游戏日 = 1440 gmin，1 游戏分 = 2.5s 墙钟。
import { fmtMoney, fmtRate } from '../format.js';
import type { JobRow, ShiftRow, LoanRow, LoanProduct } from '../api.js';

/** 六维能力的固定顺序与中文名。顺序即雷达图顶点顺序（与「形状」的可比性相关）。 */
export const ABILITY_ORDER = ['EDU', 'CODE', 'FIN', 'FIT', 'COMM', 'DESIGN'] as const;
export type AbilityKind = typeof ABILITY_ORDER[number];

export const ABILITY_LABEL: Record<AbilityKind, string> = {
  EDU: '学识', CODE: '编程', FIN: '财商', FIT: '体质', COMM: '沟通', DESIGN: '设计',
};

/** 每维等级上限（与服务端 `cfg.work.maxLevel` 一致）。 */
export const MAX_LEVEL = 10;

/** 每级课程耗时（小时）—— `cfg.work.courseHoursPerLevel`。 */
export const COURSE_HOURS_PER_LEVEL = 8;

export function isAbilityKind(k: string): k is AbilityKind {
  return (ABILITY_ORDER as readonly string[]).includes(k);
}

// ---------- 能力 ----------

export interface AbilityCell {
  kind: AbilityKind;
  label: string;
  level: number;
  /** 下一级课程费用（分）；已满级为 null。 */
  nextCost: number | null;
  /** 课程耗时（游戏小时）= (level+1) × 8；已满级为 null。 */
  nextHours: number | null;
  maxed: boolean;
}

/**
 * 把 `abilities` + `nextCourseCost` 两个 map 合成有序的可渲染单元格。
 * 服务端返回的是 `Record<string, number>`，这里用 `ABILITY_ORDER` 固定顺序，
 * **不依赖对象键顺序**（JS 对象键序在数字键上不可靠）。
 */
export function abilityCells(
  abilities: Record<string, number>,
  nextCourseCost: Record<string, number | null>,
): AbilityCell[] {
  return ABILITY_ORDER.map(kind => {
    const level = abilities[kind] ?? 0;
    const maxed = level >= MAX_LEVEL;
    const raw = nextCourseCost[kind];
    return {
      kind,
      label: ABILITY_LABEL[kind],
      level,
      // 满级时即使服务端漏给 null 也按满级处理，避免出现「已满级还能报名」
      nextCost: maxed ? null : (raw ?? null),
      nextHours: maxed ? null : (level + 1) * COURSE_HOURS_PER_LEVEL,
      maxed,
    };
  });
}

// ---------- 雷达图几何 ----------

export interface Pt { x: number; y: number }

/**
 * 雷达图顶点坐标。
 *
 * 角度约定：第 i 维从**正上方**（-90°）开始，顺时针均分 360/6 = 60°。
 * 如此第一维在顶部、整体左右对称 —— 这是雷达图的常规读法。
 *
 * `value01` 是**归一化到 0..1 的半径比例**（调用方负责 `level / MAX_LEVEL`），
 * 故本函数只做几何、不碰业务口径。
 */
export function radarPoint(
  index: number, value01: number, cx: number, cy: number, radius: number, sides = 6,
): Pt {
  const angle = (Math.PI * 2 * index) / sides - Math.PI / 2;
  const r = radius * value01;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

/** 六维顶点（`levels` 按 `ABILITY_ORDER` 取，超出上限按上限夹紧）。 */
export function radarVertices(
  levels: number[], cx: number, cy: number, radius: number, sides = 6,
): Pt[] {
  return levels.map((lv, i) => {
    const clamped = Math.min(MAX_LEVEL, Math.max(0, lv));
    return radarPoint(i, clamped / MAX_LEVEL, cx, cy, radius, sides);
  });
}

/** 坐标数组 → SVG `points` 属性值。保留 2 位小数以缩小 DOM。 */
export function toPointsAttr(pts: Pt[]): string {
  return pts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

/** 第 i 维的轴标签坐标（比顶点再外扩 `pad`，避免压在图形上）。 */
export function axisLabelPoint(
  index: number, cx: number, cy: number, radius: number, pad = 18, sides = 6,
): Pt {
  return radarPoint(index, 1, cx, cy, radius + pad, sides);
}

/** 单个维度的网格环（`t` 为 0..1 的比例）—— 用于画 4 层同心网格。 */
export function gridRing(cx: number, cy: number, radius: number, t: number, sides = 6): Pt[] {
  return radarVertices(new Array<number>(sides).fill(t * MAX_LEVEL), cx, cy, radius, sides);
}

// ---------- 打工 ----------

/** 等级缺口：「需 编程≥4」；无缺口返回 null。 */
export function requirementGap(job: JobRow): string | null {
  const parts: string[] = [];
  for (const [kind, need] of job.reqs) {
    const label = isAbilityKind(kind) ? ABILITY_LABEL[kind] : kind;
    parts.push(`${label}≥${need}`);
  }
  if (job.min_credit !== null) parts.push(`信誉≥${job.min_credit}`);
  return parts.length === 0 ? null : `需 ${parts.join('、')}`;
}

/** 工资涨幅：`wage / base_pay`，base 为 0 时返回 null（避免除零）。 */
export function wageBonusPct(job: JobRow): number | null {
  if (job.base_pay <= 0) return null;
  return job.wage / job.base_pay - 1;
}

/** 排班可行性：不合格时给出**具体原因**，而不是笼统「不可用」。 */
export function shiftBlockReason(job: JobRow): string | null {
  if (job.eligible) return null;
  return requirementGap(job) ?? '资格不足';
}

const SHIFT_LABEL: Record<string, string> = {
  scheduled: '已排班', working: '进行中', done: '已完成', cancelled: '已取消',
};

export function shiftStatusLabel(status: string): string {
  return SHIFT_LABEL[status] ?? status;
}

/** 徽标色调：cancelled 灰、working 高亮、done 绿、scheduled 中性。 */
export function shiftTone(status: string): 'flat' | 'active' | 'done' {
  if (status === 'working') return 'active';
  if (status === 'done') return 'done';
  return 'flat';
}

/** 班次时长（游戏小时）= (end − start) / 60。 */
export function shiftHours(s: Pick<ShiftRow, 'start_gmin' | 'end_gmin'>): number {
  return (s.end_gmin - s.start_gmin) / 60;
}

/**
 * 可取消：仅 `scheduled` 且**尚未开始**。
 * 用 `gminNow` 而非墙钟，口径必须与 `domain/work.cancelShift` 一致，
 * 否则会出现「按钮可点但服务端 409」。
 */
export function shiftCancellable(s: ShiftRow, gminNow: number): boolean {
  return s.status === 'scheduled' && gminNow < s.start_gmin;
}

// 进度比例与剩余时间文案已由 `homeLogic` 提供（`shiftProgress` / `fmtRemaining`），
// **不要在此重复实现** —— 两处公式分叉会让首页与生活页显示不一致。这里只做转出。

// ---------- 银行 ----------

/** 授信额度已用量视图。 */
export interface LoanSummary {
  /** 未偿本金合计（分）。 */
  outstandingPrincipal: number;
  /** 应还总额合计 = Σ(outstanding + accruedInterest)（分）。 */
  owedTotal: number;
  /** 未结清贷款数（active/grace/overdue）。 */
  openCount: number;
  /** 存在逾期（overdue）—— 用于红色告警。 */
  hasOverdue: boolean;
  /** 存在宽限期（grace）—— 用于橙色提示。 */
  hasGrace: boolean;
}

const CLOSED_STATUS = new Set(['repaid', 'liquidated', 'forgiven']);

export function loanSummary(loans: LoanRow[]): LoanSummary {
  let outstandingPrincipal = 0;
  let owedTotal = 0;
  let openCount = 0;
  let hasOverdue = false;
  let hasGrace = false;
  for (const l of loans) {
    if (CLOSED_STATUS.has(l.status)) continue;
    openCount += 1;
    outstandingPrincipal += l.outstanding;
    owedTotal += l.owedTotal;
    if (l.status === 'overdue') hasOverdue = true;
    if (l.status === 'grace') hasGrace = true;
  }
  return { outstandingPrincipal, owedTotal, openCount, hasOverdue, hasGrace };
}

/**
 * 档位剩余可用额度（分）= 档位上限 − 未偿本金合计，下限 0。
 * ⚠️ 服务端 `borrow` 用的是「未偿**本金**合计」而非应还总额（见 `domain/loans.ts` 第 5 条），
 * 这里必须同口径，否则前端会显示一个服务端不认的额度。
 */
export function remainingCredit(products: LoanProduct[], loans: LoanRow[]): number {
  if (products.length === 0) return 0;
  // 各期限档 capCents 相同（同信誉档），取首档避免误加
  const cap = products[0]?.capCents ?? 0;
  const used = loanSummary(loans).outstandingPrincipal;
  return Math.max(0, cap - used);
}

/**
 * 日息展示。`fmtRate` **已经自带 `/日` 后缀**（`(rateE6/1e6*100).toFixed(3) + '%/日'`），
 * 故这里直接透传，**不要再拼一次** —— 否则会得到 `0.030%/日/日`。
 * `rateE6` 是 e6 比例（300 → 0.030%），**不是年化**。
 */
export function loanRateLabel(rateE6: number): string {
  return fmtRate(rateE6);
}

const LOAN_STATUS_LABEL: Record<string, string> = {
  active: '正常', grace: '宽限期', overdue: '已逾期',
  repaid: '已还清', liquidated: '已强平', forgiven: '已豁免',
};

export function loanStatusLabel(status: string): string {
  return LOAN_STATUS_LABEL[status] ?? status;
}

/** 贷款状态色调：overdue 危险、grace 警示、repaid/liquidated 灰。 */
export function loanTone(status: string): 'danger' | 'warning' | 'flat' {
  if (status === 'overdue') return 'danger';
  if (status === 'grace') return 'warning';
  return 'flat';
}

/** 还款输入解析：返回「分」或错误文案。 */
export function parseRepayInput(text: string): { cents: number } | { error: string } {
  const t = text.trim();
  if (t === '') return { error: '请输入还款金额' };
  const yuan = Number(t);
  if (!Number.isFinite(yuan)) return { error: '金额格式不正确' };
  if (yuan <= 0) return { error: '还款金额须大于 0' };
  const cents = Math.round(yuan * 100);
  if (!Number.isSafeInteger(cents)) return { error: '金额超出可用范围' };
  return { cents };
}

/** 借款输入解析：`amount` 是**分**，额度上限由调用方另行校验。 */
export function parseBorrowInput(text: string): { cents: number } | { error: string } {
  const r = parseRepayInput(text);
  if ('error' in r) return r;
  if (r.cents % 100 !== 0) return { error: '借款金额须为整元' };
  return r;
}

/** 逾期强制平仓提示（规格：逾期第 10 交易日强平）。 */
export const FORCED_LIQ_NOTICE = '逾期第 10 交易日将强制平仓';

/** 信誉事件色调：涨绿跌红（信誉分是「越高越好」，与股价相反，故此处不套用涨红跌绿）。 */
export function creditDeltaTone(delta: number): 'up' | 'down' | 'flat' {
  if (delta > 0) return 'down';   // 信誉上升 = 好 = 绿（A 股绿为跌，此处语义是「好」）
  if (delta < 0) return 'up';     // 信誉下降 = 坏 = 红
  return 'flat';
}

/** 常见信誉事件原因的中文映射（未收录则回原文，不丢信息）。 */
const CREDIT_REASON: Record<string, string> = {
  WAGE_SHIFT: '完成班次', COURSE_DONE: '课程结业', REPAY_ONTIME: '按期还清',
  REPAY_EARLY: '提前还清', OVERDUE: '贷款逾期', FORCED_LIQ: '强制平仓',
  BANKRUPTCY: '破产', RELIEF: '破产救济', GENESIS: '初始授信',
};

export function creditReasonLabel(reason: string): string {
  return CREDIT_REASON[reason] ?? reason;
}

/** 已结清贷款不显示还款按钮。 */
export function repayable(l: LoanRow): boolean {
  return !CLOSED_STATUS.has(l.status);
}

/** 额度提示（用于 `creditLow` 时说明提额路径）。 */
export const CREDIT_LOW_HINT =
  '信誉分低于 500 暂无法借款。完成班次 / 按期还款可提升信誉；若曾破产，救济金也会同时重置信誉。';

/**
 * 借款门槛摘要（放在借款按钮下方，避免用户点了才被拒）。
 * ⚠️ 额度**不再按档位查表**，而是服务端按「信誉分 × 每分额度」算出的公式值
 *    （`capCents` 即该结果），故这里只说「授信额度」；**不要在文案里写死倍率** ——
 *    倍率是服务端配置（`loans.capPerCreditPoint`，可热改），写死会随配置漂移。
 */
export function borrowConditions(products: LoanProduct[]): string[] {
  if (products.length === 0) return ['信誉分 ≥ 500'];
  const cap = products[0]?.capCents ?? 0;
  const rate = products[0]?.rateE6 ?? 0;
  return [
    `信誉分 ≥ 500`,
    `授信额度 ≤ ${fmtMoney(cap)}（随信誉分线性变化）`,
    `日息 ${fmtRate(rate)}（按授信档位浮动）`,
    `无宽限 / 逾期中的贷款`,
    `未偿本息不超净资产 × 信誉分 ÷ 300`,
  ];}
