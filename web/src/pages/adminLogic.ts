// pages/adminLogic.ts —— 管理后台纯逻辑：config 白名单校验 / 危险值格式化 / 过滤。
//
// 为什么把白名单校验放前端：服务端**已经**会拒（400 `CONFIG_KEY`），前端再校验一遍
// 不是为了"安全"（前端校验永远不是安全边界），而是为了**不让用户白等一次往返**才被告知
// 这个键不能改。服务端仍必须保留校验 —— 两者职责不同，别互相替代。

/** 服务端 `config/overrides.ts` 的 `CONFIG_WHITELIST`，必须与之保持一致。
 *  注：`auth.ipRegPerDay` 是**精确键**（注册名额），不是整个 `auth.` 节 ——
 *  该节其余项（initialCash/sessionDays）改了对既有数据无意义或需重启，故不放开。
 *
 *  ⚠️ 曾漂移过一次：服务端加了 `p2p.` 与两个玩家冲击键，这里没跟上，
 *  于是**后台界面会拒绝热改这些键**（前端先拦，压根发不出请求）。
 *  `web/test/adminLogic.test.ts` 现在直接 import 服务端那份做交叉断言，防止再次漂移。 */
export const CONFIG_WHITELIST_PREFIXES = ['trading.', 'credit.', 'loans.', 'work.', 'p2p.'] as const;

/**
 * **精确键**白名单。白名单是前缀匹配，若把 `auth.ipRegPerDay` 丢进上面那个列表，
 * 它会派生出 `auth.ipRegPerDayX` 这类**不存在的键**也被放行（服务端 `applyOverride`
 * 对未知路径是静默 `return`，于是「写入成功」但配置毫无变化 —— 最难查的一类故障）。
 * 故精确键单独一张表，先全等后前缀。
 *
 * ⚠️ `playerImpactLambda` / `playerImpactCap` 在**顶层**（不在 `trading.*` 下），
 * 所以必须列在这里，放进前缀表不会生效。
 *
 * 服务端 `config/overrides.ts` 有同样结构，两处必须同时改。
 */
export const CONFIG_WHITELIST_EXACT = [
  'auth.ipRegPerDay',
  'playerImpactLambda',
  'playerImpactCap',
] as const;

/**
 * 该 config 键是否允许热改。
 *
 * 注意是**前缀**匹配且带点号：`trading.` 匹配 `trading.slippageK`，
 * 但不匹配 `tradingXxx`（点号是必需的），也不匹配 `auth.initialCash`。
 * 精确键（如 `auth.ipRegPerDay`）走全等，避免上述派生放行。
 */
export function isHotReloadableKey(key: string): boolean {
  if ((CONFIG_WHITELIST_EXACT as readonly string[]).includes(key)) return true;
  return CONFIG_WHITELIST_PREFIXES.some(p => key.startsWith(p));
}

/** 校验结果：可直接给用户看的提示文案。 */
export interface KeyCheck {
  ok: boolean;
  /** 不合法时的原因（中文，可直接渲染）。 */
  reason?: string;
}

/** 校验待热改的键；比 `isHotReloadableKey` 多做空值与空白处理。 */
export function checkConfigKey(key: string): KeyCheck {
  const k = key.trim();
  if (k === '') return { ok: false, reason: '请填写配置键' };
  if (!k.includes('.')) {
    return { ok: false, reason: '配置键须为「节.字段」形式，如 work.shiftsPerDay' };
  }
  if (!isHotReloadableKey(k)) {
    return {
      ok: false,
      reason: `该键不可热改（仅允许 ${CONFIG_WHITELIST_PREFIXES.join(' / ')} 开头）`,
    };
  }
  return { ok: true };
}

/**
 * 解析待写入的 config 值。
 *
 * 服务端 `value: z.unknown()` 收任意 JSON，故这里把输入框文本按 JSON 解析优先、
 * 失败则当字符串。**必须区分 `"1"`（数字）与 `"\"1\""`（字符串）** ——
 * 把数字配成字符串会让下游 `==` 比较静默失配。
 */
export interface ParsedValue {
  ok: boolean;
  value?: unknown;
  /** 实际采用的解析方式（用于提示用户我们理解成了什么）。 */
  kind?: 'json' | 'string';
  reason?: string;
}

export function parseConfigValue(raw: string): ParsedValue {
  const t = raw.trim();
  if (t === '') return { ok: false, reason: '请填写配置值' };
  try {
    return { ok: true, value: JSON.parse(t), kind: 'json' };
  } catch {
    // 不是合法 JSON：当纯字符串。这是刻意的宽容（用户可能就想写个字符串），
    // 但 UI 必须把"理解成了字符串"显式告诉用户。
    return { ok: true, value: raw, kind: 'string' };
  }
}

/**
 * 值的展示形态（用于回显"将写入什么"）。
 * 用 `JSON.stringify` 而非 `String`，这样字符串会带引号、`undefined` 会显形。
 */
export function describeValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s;
}

/** 字节数 → 人类可读（备份文件大小）。 */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 按用户名过滤用户列表（本地过滤）。
 *
 * 服务端支持 `?q=`，但它对 username 做 `LIKE %q%` 且上限 200 条；
 * 本地再过滤一次是为了**输入即时响应**（不打断输入去等网络）。
 */
export function filterUsers<T extends { username: string }>(users: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return users;
  return users.filter(u => u.username.toLowerCase().includes(q));
}

/** 用户状态 → 中文标签。 */
export function userStatusLabel(status: string): string {
  if (status === 'active') return '正常';
  if (status === 'banned') return '已封禁';
  return status === '' ? '未知' : status;
}

/** 用户名首字母（无头像时的占位）。 */
export function initialOf(username: string): string {
  return username.trim().slice(0, 1).toUpperCase() || '?';
}

/** 备份文件名 `day-3.db` → 游戏日 3；解析不出返回 null。 */
export function backupDay(file: string): number | null {
  const m = /^day-(\d+)\.db$/.exec(file);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

/** 备份列表按游戏日降序（最新的在最前，便于直接点下载）。 */
export function sortBackups<T extends { file: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => (backupDay(b.file) ?? -1) - (backupDay(a.file) ?? -1));
}
