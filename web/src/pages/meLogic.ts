// pages/meLogic.ts —— 「榜单 + 我的」的纯函数层（无 React、无网络，便于单测）。
//
// 单位提醒：金额一律是**分**（`amount` / `balance_after` / `frozen` / `price`）；
//          `created_at` 是墙钟秒（unixepoch），`day`/`tick`/`created_tick` 是游戏时间。

// ---------- 资金流水 kind ----------

/**
 * `ledger.kind` → 中文标签。
 *
 * ⚠️ 映射表必须覆盖服务端**全部** kind。枚举来源（实测命令）：
 *   `grep -rhoE "kind: '[A-Z_]+'" server/src/ | sort -u`
 * 缺一个的后果不是报错，而是那一行**静默显示英文码** —— 用户看不出这是 bug，
 * 只觉得「这里怎么有串乱码」。故 `ledgerKindLabel` 对未知码回落原文（不丢信息），
 * 同时 `meLogic.test.ts` 用全量清单把「有没有漏」变成可测条件。
 */
const LEDGER_KIND: Record<string, string> = {
  GENESIS: '初始资金',
  TRADE_BUY: '买入',
  TRADE_SELL: '卖出',
  ORDER_FREEZE: '买入冻结',
  ORDER_UNFREEZE: '冻结退回',
  ORDER_RELEASE: '冻结释放',
  WAGE: '工资',
  COURSE_FEE: '课程费用',
  LOAN_DRAW: '贷款放款',
  LOAN_REPAY: '贷款还款',
  LOAN_LIQ: '强制平仓还贷',
  FORCED_SELL: '强制平仓',
  RELIEF: '破产救济',
  BANKRUPTCY: '破产清算',
  BANKRUPTCY_FORFEIT: '破产没收',
  DIVIDEND: '分红',
  DIVIDEND_TAX: '红利税',
  DELIST_RECOVERY: '退市补偿',
  SH: '融券',
  COMP: '补偿',
};

/** 未知码回落原文 —— 宁可显示英文码，也不要让用户面对空白。 */
export function ledgerKindLabel(kind: string): string {
  return LEDGER_KIND[kind] ?? kind;
}

/** 资金流出（负）的 kind —— 用于给金额选颜色。 */
const OUTFLOW_KINDS = new Set([
  'TRADE_BUY', 'COURSE_FEE', 'LOAN_REPAY', 'BANKRUPTCY', 'BANKRUPTCY_FORFEIT', 'DIVIDEND_TAX',
]);

/** 该 kind 是否属于「钱变少」。仅用于兜底着色；有 `amount` 时应以符号为准。 */
export function isOutflowKind(kind: string): boolean {
  return OUTFLOW_KINDS.has(kind);
}

// ---------- 委托 ----------

const ORDER_STATUS: Record<string, string> = {
  open: '未成交', done: '已成交', cancelled: '已撤销', expired: '已过期',
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS[status] ?? status;
}

/** 委托状态色调：open 中性、done 主色、cancelled/expired 灰。 */
export function orderStatusTone(status: string): 'flat' | 'active' | 'done' {
  if (status === 'open') return 'flat';
  if (status === 'done') return 'active';
  return 'done';
}

const SIDE_LABEL: Record<string, string> = { B: '买入', S: '卖出' };

export function orderSideLabel(side: string): string {
  return SIDE_LABEL[side] ?? side;
}

/**
 * 买卖方向色调。
 *
 * 两个口径在此分叉，务必看清调用场景：
 * - 不传 `amount`：按**方向**着色 —— 买入 `up`(红)、卖出 `down`(绿)，A 股惯例。
 * - 传 `amount`：按**资金流向**着色 —— 入账(>0) `down`(绿)、出账(<0) `up`(红)、零 `flat`。
 *   用于流水表（那里的重点是「钱多了还是少了」，不是「买还是卖」）。
 */
export function directionTone(side: string, amount?: number): 'up' | 'down' | 'flat' {
  if (amount !== undefined) {
    if (amount > 0) return 'down';
    if (amount < 0) return 'up';
    return 'flat';
  }
  if (side === 'B') return 'up';
  if (side === 'S') return 'down';
  return 'flat';
}

/** 委托类型：L 限价、M 市价。 */
export function orderTypeLabel(type: string): string {
  if (type === 'L') return '限价';
  if (type === 'M') return '市价';
  return type;
}

/** 未成交数量 = 委托量 − 已成交量（下限 0，防脏数据出负数）。 */
export function unfilledQty(qty: number, filled: number): number {
  return Math.max(0, qty - filled);
}

// ---------- 分页合并 ----------

interface HasId { id: number }

/**
 * 合并两页数据并**按 id 去重**。
 *
 * ⚠️ 服务端分页语义是 `id < before` 且 `nextBefore = 末条 id`（见 `api/me.ts` 的 `page()`），
 * 相邻两页**必然重叠一条**（下页会从上一页的末条开始）。不去重就会把同一条显示两遍。
 * 保持出现先后顺序，不重排（服务端已按 id DESC 排好）。
 */
export function mergePage<T extends HasId>(prev: T[], next: T[]): T[] {
  const seen = new Set(prev.map(x => x.id));
  const out = [...prev];
  for (const x of next) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

// ---------- 榜单 ----------

/**
 * 前三名徽标：下标 0/1/2 → 1/2/3，其余 null。
 * 用下标而非名次字段 —— 服务端榜单不回名次，位置即名次。
 */
export function rankBadge(index: number): number | null {
  return index >= 0 && index <= 2 ? index + 1 : null;
}

/**
 * 是否是自己。服务端榜单**不回 id**（构建后剥掉了），故只能按 username 匹配。
 * 任一侧为空/undefined 一律 false —— 未登录时不该高亮任何人。
 */
export function isSelf(username: string | undefined | null, me: string | undefined | null): boolean {
  if (username === undefined || username === null || username === '') return false;
  if (me === undefined || me === null || me === '') return false;
  return username === me;
}

/** 破产标注：仅 `bankrupt === true` 时显示（服务端语义是 `bankrupt_count > 0`）。 */
export function bankruptLabel(bankrupt: boolean): string | null {
  return bankrupt ? '已破产' : null;
}

// ---------- 杂项 ----------

/**
 * 距上市/建仓已过天数（`T+N` 标记）。同日或倒挂（数据异常）一律 0，不出负数。
 */
export function settledDays(fromDay: number, nowDay: number): number {
  return Math.max(0, nowDay - fromDay);
}

/** 订单是否可撤销：仅 `open`（服务端 `NOT_CANCELLABLE` 的本地预判）。 */
export function cancellable(status: string): boolean {
  return status === 'open';
}
