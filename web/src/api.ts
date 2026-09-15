// api.ts —— 类型化 HTTP 客户端。
//
// 约定：
//   · 同源部署（生产由 Fastify 托管 dist/，开发由 vite proxy 转发），**无 CORS**，
//     会话靠 httpOnly Cookie，故每个请求都要 credentials: 'same-origin'。
//   · 服务端错误信封恒为 `{ code, message }`（见 server/src/api/app.ts setErrorHandler），
//     这里统一还原成 ApiError，UI 只面对一个错误类型。
//   · 端点分组的返回类型按服务端源码实测字段声明（勿臆造字段名）。

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

type UnauthorizedHandler = (() => void) | null;
let onUnauthorized: UnauthorizedHandler = null;

/** 注册 401 回调（会话失效 → 跳登录）。传 null 注销。 */
export function setOnUnauthorized(fn: UnauthorizedHandler): void {
  onUnauthorized = fn;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (query === undefined) return path;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    usp.append(k, String(v));
  }
  const qs = usp.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

/** 读取错误信封；非 JSON（网关 HTML 等）回落到 `HTTP_<status>`。 */
async function toApiError(res: Response): Promise<ApiError> {
  let code = `HTTP_${res.status}`;
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = await res.json() as { code?: unknown; message?: unknown };
    if (typeof body.code === 'string' && body.code !== '') code = body.code;
    if (typeof body.message === 'string' && body.message !== '') message = body.message;
  } catch {
    // 保留回落值
  }
  return new ApiError(code, res.status, message);
}

/** 底层请求：JSON 编解码 + 错误归一 + 401 回调。 */
export async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(buildUrl(path, init.query), {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body } : {}),
  });

  if (!res.ok) {
    const err = await toApiError(res);
    if (res.status === 401 && onUnauthorized !== null) onUnauthorized();
    throw err;
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (text === '') return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ---------- 领域类型（按服务端实测字段） ----------

export interface AuthUser {
  id: number; username: string; credit: number; isAdmin: boolean; bankruptCount: number;
}

export interface Valuation {
  cashAvailable: number; cashFrozen: number; positionsValue: number; loansOutstanding: number;
  /** 融资融券负债（融资本息 + 融券市值）。已从 totalAssets 里扣掉。 */
  marginDebt?: number;
  p2pDebt?: number; p2pCredit?: number;
  totalAssets: number; totalInflow: number; returnPct: number;
}

export interface Position {
  code: string; name: string; qtyTotal: number; qtySellable: number;
  costTotal: number; avgCost: number; price: number; pnl: number; pnlPct: number;
}

/** 服务端 workStatus 直接回传 DB 行，字段随表结构，故用宽松类型。 */
export interface ShiftRow {
  id: number; job_id: number; start_gmin: number; end_gmin: number; status: string; pay: number | null;
}
export interface WorkStatus {
  busyUntil: number; shift: ShiftRow | null; course: Record<string, unknown> | null;
}
/**
 * 当日盈亏（分）。口径见服务端 `domain/portfolio.ts` 的 `todayPnl`：
 * `total = positionPnl + cashFlow`。
 *
 * ⚠️ 与 `Valuation.returnPct` 是**两个不同口径**，别混用：
 * - `todayPnl` = 今天口袋里多了多少钱（含借入的现金 → 借钱当天显示为盈利）
 * - `returnPct` = 累计净资产收益率
 */
export interface TodayPnl {
  positionPnl: number; cashFlow: number; total: number;
}

export interface MeView {
  user: AuthUser; valuation: Valuation; positions: Position[]; work: WorkStatus;
  /** 当日盈亏。服务端 Task 7 追加；老服务端可能没有，故可选。 */
  todayPnl?: TodayPnl;
}

export interface AuthResult { user: AuthUser }

export interface IndexView { code: string; level: number; chgPct: number }
export interface SectorView { name: string; chgPct: number }
export interface MoverView { code: string; name: string; chgPct: number; price: number }
export interface MarketOverview {
  index: IndexView; sectors: SectorView[]; advancers: number; decliners: number;
  turnover: number; topGainers: MoverView[]; topLosers: MoverView[];
}

export interface StockRow {
  code: string; name: string; sector: string; board: string; status: string;
  st: boolean; price: number; chgPct: number; volume: number; turnover: number;
}
export interface QuoteView {
  code: string; name: string; sector: string; board: string; status: string;
  price: number; prevClose: number; chgPct: number; volume: number; turnover: number;
  limitUp: number; limitDown: number;
}
export interface ReportRow {
  periodIdx: number; reportDay: number; epsE6: number; revenue: number; profit: number; surpriseE6: number;
}
export interface DividendRow { announcedDay: number; exDay: number; perShareE6: number }
/**
 * 新闻条目旁的「涨跌」—— 是关联标的**当日实际涨跌**，不是预测。
 *
 * 真实行情终端挂在新闻旁的就是这个（一条新闻 + 它关联个股/板块/大盘的实时快照）。
 * 服务端**故意不下发** `impact_e6`（模型内部的冲击强度）：新闻在 `tick ∈ [60,1159)`
 * 到达、冲击还没释放完，玩家看到 `+5.2%` 就知道该买什么 —— 那不是看新闻，是读答案。
 * 标题本身已给方向（「业绩预增」= 利好），幅度交给玩家判断。
 */
export interface NewsRelated {
  /** 可跳转的个股代码；板块/大盘为 null（没有对应的详情页）。 */
  code: string | null;
  name: string;
  chgPct: number;
}
export interface NewsRow {
  id: number; day: number; tick?: number; scope: string; target?: string;
  /** 服务端 `news.type_id` 是 TEXT（事件 id 如 `MKT_RRR_CUT` / `REPORT` / `IPO`），不是数字。 */
  typeId?: string; title: string;
  /** 关联标的当日实际涨跌；标的已退市/无行情时为 null。 */
  related?: NewsRelated | null;
}
export interface StockDetail {
  quote: QuoteView; reports: ReportRow[]; dividends: DividendRow[]; news: NewsRow[];
  fundamental: { eps: number; pe: number };
}
export interface DayCandle { day: number; o: number; h: number; l: number; c: number; volume: number; turnover: number }
export interface TickCandle { tick: number; price: number; volume: number }
export type CandlesResult =
  | { code: string; type: 'tick'; day: number; candles: TickCandle[] }
  | { code: string; type: 'day'; candles: DayCandle[] };

export interface Page<T> { items: T[]; nextBefore: number | null }

export interface OrderRow {
  id: number; user_id: number; code: string; side: string; type: string;
  price: number | null; qty: number; filled: number; status: string;
  frozen: number; client_key: string; day: number; created_tick: number;
}
/**
 * ⚠️ 列名是 `stamp` / `transfer`（见 `db/migrations/001_init.sql` 的 `CREATE TABLE trades`），
 * **不是** `stamp_tax` / `transfer_fee`。早期按后者声明会静默拿到 `undefined`，
 * 表格里费用列全空却毫无报错。
 */
export interface TradeRow {
  id: number; order_id: number; user_id: number; code: string; side: string;
  price: number; qty: number; commission: number; stamp: number; transfer: number;
  day: number; tick: number;
}
/**
 * ⚠️ `ledger` 是**双桶**（`bucket: 'A'` 可用 / `'F'` 冻结），且没有 `memo` 列 ——
 * 关联信息在 `ref_type` + `ref_id`。`balance_after` 是**该桶余额**，不是总资产。
 */
export interface LedgerRow {
  id: number; user_id: number; bucket: string; day: number; tick: number;
  kind: string; amount: number; balance_after: number;
  ref_type: string; ref_id: number; created_at: number;
}

export interface LoanProduct { termDays: number; rateE6: number; capCents: number }

/**
 * 借款空间。由服务端 `borrowRoom()` 算好下发 —— **前端不要自己算**。
 *
 * ⚠️ `products[].capCents` 只是**授信**上限，实际能借到的是 `room`。额度改成公式
 *    （信誉分 × ¥5,000）后授信上限会**超过**杠杆上限：600 分玩家看到 ¥3,000,000，
 *    但净资产 ¥1,000,000 时杠杆只允许 ¥2,000,000。曾经 UI 只认 `capCents`，
 *    于是输入框留空时提交的正是那个借不到的数，点一下「借款」必然 403。
 *
 * `binding` 说明是哪条闸门在卡：'leverage' ⇒ 受净资产×信誉分÷300 所限（额度还有剩）。
 */
export interface BorrowRoom {
  capCents: number;
  creditRoom: number;
  leverageRoom: number;
  /** **这就是 UI 该显示的「当前可用」**，也是服务端真正会放行的最大金额。 */
  room: number;
  binding: 'credit' | 'leverage';
  leverageCap: number;
  /** 杠杆系数（服务端 `cfg.loans.leverageDivisor`，可热改）。文案要写它就别写死。 */
  divisor: number;
  netWorth: number;
  openPrincipal: number;
  loansOutstanding: number;
}
export interface BankProducts {
  credit: number; creditLow: boolean; products: LoanProduct[]; room: BorrowRoom;
}
export interface LoanRow {
  id: number; principal: number; outstanding: number; accruedInterest: number; owedTotal: number;
  rateE6: number; termDays: number; startDay: number; dueDay: string | number; status: string;
}
export interface LoansView { credit: number; loans: LoanRow[] }
export interface RepayResult {
  interestPaid: number; principalPaid: number; closed: boolean; loans: LoanRow[];
}
export interface CreditEvent { day: number; delta: number; reason: string; scoreAfter: number }
export interface CreditView { credit: number; events: CreditEvent[] }

// —— 玩家间借贷（P2P）——
//
// ⚠️ 与 NPC 银行贷款（`LoanRow`）**不是一套东西**，别把字段名互相套用：
//   · 银行贷款有 `outstanding` / `accruedInterest`（利息逐日计提，会一直涨）；
//   · P2P 是**双方谈定的固定应还额** `repayAmount`，没有「计提」概念，
//     进度只能看 `repaid` / `owedTotal`（= repayAmount − repaid）。
//   · `termDays` 是**谈定的游戏日**；`dueDay` 在生效（accept）前为 null。

/** 潜在对手方。服务端**故意不回余额** —— 借钱前不该先看到别人有多少钱。 */
export interface P2pPlayer { id: number; username: string; credit: number }

/** 条款边界（表单 min/max 用，避免用户填了才被拒）。 */
export interface P2pLimits {
  /** 单笔本金上限（分）。 */
  maxPrincipal: number;
  /** 利率倍数区间：`repayAmount / principal` 的上下界。1.0 = 零息。 */
  minRateMult: number; maxRateMult: number;
  minTermDays: number; maxTermDays: number;
  /** 到期后宽限天数（宽限内不扣信誉）。 */
  graceDays: number;
}

export type P2pStatus = 'pending' | 'active' | 'repaid' | 'grace' | 'overdue'
  | 'settled' | 'forgiven' | 'rejected' | 'cancelled';

export interface P2pLoan {
  id: number; borrowerId: number; borrowerName: string; lenderId: number; lenderName: string;
  /** 本金（分）。 */
  principal: number;
  /** 谈定的应还总额（分）= 本金 + 利息。 */
  repayAmount: number;
  /** 已还（分）。 */
  repaid: number;
  /** 未偿余额（分）= repayAmount − repaid。 */
  owedTotal: number;
  termDays: number;
  /** 谁发的起——决定「谁在等对方确认」的文案。 */
  proposedBy: 'borrow' | 'lend';
  awaitingId: number | null; awaitingName: string | null;
  dayCreated: number;
  /** 生效日 / 到期日；**pending 阶段均为 null**。 */
  startDay: number | null; dueDay: number | null;
  status: P2pStatus; note: string;
  /** 我在本笔借据中的角色 —— 直接决定渲染「我要还」还是「等他还」。 */
  myRole: 'borrower' | 'lender';
  /** 距到期还有几个游戏日（未生效为 null；负数表示已超期）。 */
  daysLeft: number | null;
}

export interface P2pLoansView {
  loans: P2pLoan[];
  /** 我欠其他玩家的（借款人视角，分）。 */
  debt: number;
  /** 其他玩家欠我的（出借人视角，分）。 */
  credit: number;
}

export interface P2pProposeInput {
  role: 'borrow' | 'lend'; counterpartyId: number;
  principal: number; repayAmount: number; termDays: number; note?: string;
}

export interface JobRow {
  id: number; name: string; base_pay: number; min_credit: number | null;
  /**
   * ⚠️ 服务端 `jobs.reqs` 是 **tuple 数组** `[["CODE",4],["EDU",2]]`（见 `domain/work.ts` 的
   * `parseReqs`），**不是** `{"CODE":4}` 对象。实测确认；早期按对象写会静默拿不到要求。
   */
  reqs: [string, number][];
  eligible: boolean; wage: number;
}
export interface JobsView { jobs: JobRow[] }
export interface ShiftsView { shifts: ShiftRow[] }
export interface ShiftCreateResult { shiftId: number; shifts: ShiftRow[] }
export interface AbilitiesView {
  abilities: Record<string, number>; kinds: string[];
  nextCourseCost: Record<string, number | null>;
}
export interface EnrollResult { enrollmentId: number; abilities: Record<string, number> }

export interface LeaderboardRow {
  username: string; totalAssets: number; returnPct: number; bankruptCount: number; bankrupt: boolean;
}
export interface Leaderboard { by: string; rows: LeaderboardRow[] }

// ---------- 端点封装 ----------

export const authApi = {
  register: (username: string, password: string) =>
    api.post<AuthResult>('/api/auth/register', { username, password }),
  login: (username: string, password: string) =>
    api.post<AuthResult>('/api/auth/login', { username, password }),
  logout: () => api.post<{ ok: true }>('/api/auth/logout'),
  me: () => api.get<MeView>('/api/me'),
  /** 改密码：服务端会踢掉除当前会话外的所有 session。 */
  changePassword: (oldPassword: string, newPassword: string) =>
    api.post<{ ok: true }>('/api/auth/password', { oldPassword, newPassword }),
};

export const marketApi = {
  overview: () => api.get<MarketOverview>('/api/market/overview'),
  stocks: () => api.get<{ stocks: StockRow[] }>('/api/stocks'),
  stock: (code: string) => api.get<StockDetail>(`/api/stocks/${code}`),
  candles: (code: string, type: 'day' | 'tick') =>
    api.get<CandlesResult>(`/api/stocks/${code}/candles`, { type }),
  news: (limit?: number, before?: number) => api.get<Page<NewsRow>>('/api/news', { limit, before }),
  announcements: () => api.get<{ items: { id: number; day: number; content: string; createdAt: number }[] }>(
    '/api/announcements'),
};

export const tradeApi = {
  place: (input: { code: string; side: 'B' | 'S'; type: 'L' | 'M'; price?: number; qty: number; clientKey: string }) =>
    api.post<{ orderId: number; reused: boolean }>('/api/orders', input),
  cancel: (id: number) => api.del<void>(`/api/orders/${id}`),
  orders: (q?: { limit?: number; before?: number; status?: string }) =>
    api.get<Page<OrderRow>>('/api/orders', q),
  trades: (q?: { limit?: number; before?: number }) => api.get<Page<TradeRow>>('/api/trades', q),
  ledger: (q?: { limit?: number; before?: number }) => api.get<Page<LedgerRow>>('/api/ledger', q),
};

export const bankApi = {
  products: () => api.get<BankProducts>('/api/bank/products'),
  borrow: (amount: number, termDays: number) =>
    api.post<{ loanId: number; loans: LoanRow[] }>('/api/bank/loans', { amount, termDays }),
  repay: (id: number, amount: number) =>
    api.post<RepayResult>(`/api/bank/loans/${id}/repay`, { amount }),
  loans: () => api.get<LoansView>('/api/bank/loans'),
  credit: () => api.get<CreditView>('/api/credit'),
};

// —— 融资融券（信用交易）——
// 单位：金额一律**分**；比例一律 **e6**（1_500_000 = 150%）。
// 四种下单动作都只传 { code, qty }：成交价由服务端按当前模型价即时撮合，客户端不能指定。
export interface MarginPositionView {
  code: string; name: string; kind: 'long' | 'short';
  qty: number; cost: number; price: number; marketValue: number;
  pnl: number; pnlPct: number;
  /** 空头冻结在 F 桶的担保金（多头恒为 0）。 */
  frozen: number; openedDay: number;
}

export interface MarginState {
  open: boolean;
  /** 开通门槛（信誉分）与当前信誉分是否够。 */
  minCredit: number; eligible: boolean; credit: number;
  debt: number; interest: number; owedTotal: number;
  shortValue: number; liability: number;
  cash: number; positionsValue: number;
  /** 维持担保比例（1.0 = 100%）；无负债时为 **null**（不是 0，也不是 Infinity）。 */
  collateral: number;
  ratio: number | null;
  /** 同上，乘 1e6 取整后的整数，便于直接与阈值比较。 */
  ratioE6: number | null;
  /** ok = 可开新仓；warn = 低于警戒线（禁开仓）；call = 低于平仓线（追保中）。 */
  status: 'ok' | 'warn' | 'call';
  canOpen: boolean;
  warnSinceDay: number | null;
  liquidatedCount: number;
  creditCap: number; debtRoom: number;
  /** 还能融资买入/融券卖出的**金额**上限（服务端算好的，UI 不要自己再算一遍）。 */
  maxFinanceCents: number; maxShortCents: number;
  positions: MarginPositionView[];
}

/** 随 state 一起下发的阈值。**UI 文案一律用它们，不要写死 150%/130%** —— 它们可热改。 */
export interface MarginLimits {
  initRatioE6: number; financeRateE6: number; shortRateE6: number;
  warnRatioE6: number; liqRatioE6: number;
  minOrderCents: number; maxDebtPerCreditPoint: number;
}

export interface MarginView { state: MarginState; limits: MarginLimits }

export interface MarginTradeResult {
  orderId: number; tradeId: number; code: string; qty: number; price: number;
  amount: number; fees: number; loanAmount: number; marginUsed: number;
}
export interface MarginSellRepayResult extends MarginTradeResult {
  interestPaid: number; principalPaid: number; owedLeft: number;
}
export interface MarginBuyCoverResult extends MarginTradeResult { released: number }
export interface MarginRepayResult { interestPaid: number; principalPaid: number; owedLeft: number }

export const marginApi = {
  /** 账户全景。未开通也返回 200（`state.open === false`），前端据此渲染开通引导。 */
  view: () => api.get<MarginView>('/api/margin'),
  open: () => api.post<{ state: MarginState }>('/api/margin/open'),
  /** 融资买入（借钱买股，股票作为担保物，不可卖）。 */
  finance: (code: string, qty: number) =>
    api.post<{ result: MarginTradeResult; state: MarginState }>('/api/margin/finance', { code, qty }),
  /** 融券卖出（借券卖出，所得全额冻结作担保）。 */
  short: (code: string, qty: number) =>
    api.post<{ result: MarginTradeResult; state: MarginState }>('/api/margin/short', { code, qty }),
  /** 卖券还款：卖掉担保股票冲抵负债（先息后本）。 */
  sellRepay: (code: string, qty: number) =>
    api.post<{ result: MarginSellRepayResult; state: MarginState }>('/api/margin/sell-repay', { code, qty }),
  /** 买券还券：买回股票还给券商，资金优先来自该笔空头的冻结担保金。 */
  buyCover: (code: string, qty: number) =>
    api.post<{ result: MarginBuyCoverResult; state: MarginState }>('/api/margin/buy-cover', { code, qty }),
  /** 直接还款（现金冲抵负债）。 */
  repay: (amount: number) =>
    api.post<{ result: MarginRepayResult; state: MarginState }>('/api/margin/repay', { amount }),
};

export const p2pApi = {
  /** 找对手方：按用户名模糊匹配（空串会被服务端 zod 拒，调用方须先判空）。 */
  players: (q: string) => api.get<{ players: P2pPlayer[] }>('/api/p2p/players', { q }),
  limits: () => api.get<P2pLimits>('/api/p2p/limits'),
  loans: () => api.get<P2pLoansView>('/api/p2p/loans'),
  /** 发起协商（**不划款**）。返回的 `id` 是借据号，`loans` 是最新列表。 */
  propose: (input: P2pProposeInput) =>
    api.post<{ id: number; loans: P2pLoan[] }>('/api/p2p/loans', input),
  /** 对手方同意 —— 服务端在此刻才真正划款。 */
  accept: (id: number) => api.post<{ loans: P2pLoan[] }>(`/api/p2p/loans/${id}/accept`),
  /** 拒绝 / 撤回（无资金变动）。 */
  reject: (id: number) => api.post<{ loans: P2pLoan[] }>(`/api/p2p/loans/${id}/reject`),
  repay: (id: number, amount: number) =>
    api.post<{ paid: number; closed: boolean; loans: P2pLoan[] }>(`/api/p2p/loans/${id}/repay`, { amount }),
};

export const workApi = {
  jobs: () => api.get<JobsView>('/api/jobs'),
  shifts: (limit?: number) => api.get<ShiftsView>('/api/shifts', { limit }),
  schedule: (jobId: number) => api.post<ShiftCreateResult>('/api/shifts', { jobId }),
  cancelShift: (id: number) => api.del<void>(`/api/shifts/${id}`),
  status: () => api.get<WorkStatus>('/api/work/status'),
  abilities: () => api.get<AbilitiesView>('/api/abilities'),
  enroll: (ability: string) => api.post<EnrollResult>('/api/courses/enroll', { ability }),
};

export const leaderboardApi = {
  get: (by: 'total' | 'return') => api.get<Leaderboard>('/api/leaderboard', { by }),
};

// ---------- 管理后台（Task 9） ----------

/** 管理端用户行：DB 行 + 估值摘要（服务端 `api/admin.ts` 拼装）。 */
export interface AdminUserRow {
  id: number; username: string; credit: number; status: string;
  /**
   * ⚠️ SQLite 的 BOOLEAN 落库是 **0/1 整数**，不是 JS `boolean`
   * （实测：`SELECT is_admin isAdmin` 回来的是 `1`/`0`）。
   * 故这里标 `number` 而非 `boolean` —— 真值判断（`u.isAdmin ? …`）两者等价，
   * 但把类型标成 `boolean` 会诱导别人写 `=== true`，那是静默失配的经典来源。
   */
  isAdmin: number;
  bankruptCount: number; createdDay: number;
  valuation: Valuation;
}

export interface AdminEngineView {
  day: number; tickInDay: number; lastTick: number;
  /** 距最近一次 tick 的秒数（服务端 `admin.ts` 计算，与前端 `lagSecondsFrom` 同口径）。 */
  lagSeconds: number;
}

export interface AuditFailure { id: number; username: string; error: string }
export interface AdminAuditView {
  globalOk: boolean; globalError: string | null; usersOk: boolean;
  checkedUsers: number; failures: AuditFailure[];
}

export interface AdminConfigView {
  /** 进程内生效的完整配置（含默认值与已应用的 override）。 */
  config: Record<string, unknown>;
  /** 仅 DB 里显式写过的 override。 */
  overrides: { key: string; value: string }[];
}

export interface BackupFile { file: string; bytes: number }

export const adminApi = {
  users: (q?: string) => api.get<{ users: AdminUserRow[] }>('/api/admin/users', { q }),
  /** 重置密码：服务端会踢掉该用户**全部**会话（含当前正在用的）。 */
  resetPassword: (id: number, newPassword: string) =>
    api.post<{ ok: true }>(`/api/admin/users/${id}/reset-password`, { newPassword }),
  ban: (id: number) => api.post<{ ok: true }>(`/api/admin/users/${id}/ban`),
  unban: (id: number) => api.post<{ ok: true }>(`/api/admin/users/${id}/unban`),
  announce: (content: string) => api.post<{ ok: true }>('/api/admin/announce', { content }),
  engine: () => api.get<AdminEngineView>('/api/admin/engine'),
  audit: () => api.get<AdminAuditView>('/api/admin/audit'),
  config: () => api.get<AdminConfigView>('/api/admin/config'),
  /** 热改配置。服务端仅接受白名单前缀（`trading.`/`credit.`/`loans.`/`work.`）。 */
  putConfig: (key: string, value: unknown) =>
    api.put<{ ok: true; key: string; value: unknown }>('/api/admin/config', { key, value }),
  backups: () => api.get<{ files: BackupFile[] }>('/api/admin/backups'),
  /** 下载 URL（直接给 `<a href>`，不走 fetch —— 需要浏览器原生下载行为）。 */
  backupUrl: (file: string) => `/api/admin/backups/${encodeURIComponent(file)}`,
};

/** `/healthz` 的公开字段（无鉴权）。用于推导当前游戏时间。 */
export interface HealthView { ok: true; day: number; lastTick: number }

export const metaApi = {
  health: () => api.get<HealthView>('/healthz'),
};

const TICKS_PER_DAY = 1200;
const MINS_PER_DAY = 1440;

/**
 * 由 `/healthz` 推导当前**游戏分钟**（gmin）。
 *
 * 推导式必须与后端 `clock.gameMinuteAbs` 口径一致：1 游戏日 = 1200 tick = 1440 游戏分。
 * 关键：`day` 与 `tickInDay` 要用**同一个基数** `completed = lastTick + 1` 推导，
 * 否则日界处会出现非单调跳变（曾实测 lastTick=1199 与 1200 相邻却差 1 分钟）。
 */
export function gminFromHealth(h: HealthView): number {
  const completed = h.lastTick + 1;
  const day = Math.floor(completed / TICKS_PER_DAY) + 1;
  const tickInDay = completed % TICKS_PER_DAY;
  return (day - 1) * MINS_PER_DAY + Math.floor((tickInDay / TICKS_PER_DAY) * MINS_PER_DAY);
}
