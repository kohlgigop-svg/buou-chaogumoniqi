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
export interface NewsRow {
  id: number; day: number; tick?: number; scope: string; target?: string;
  /** 服务端 `news.type_id` 是 TEXT（事件 id 如 `MKT_RRR_CUT` / `REPORT` / `IPO`），不是数字。 */
  typeId?: string; title: string; impactE6: number; driftDays?: number;
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
export interface BankProducts { credit: number; creditLow: boolean; products: LoanProduct[] }
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
