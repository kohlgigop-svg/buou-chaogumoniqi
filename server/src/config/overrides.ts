// config/overrides.ts —— config 热改白名单 + 覆盖应用 + **启动时恢复**。
//
// ⚠️ 为什么单独成模块：这套逻辑原来只写在 `api/admin.ts` 里，且 `applyOverride`
// 仅在管理后台 PUT 路由被调用 —— 于是热改**只改内存**，进程一重启（含每次
// 重新部署）就全部退回 `defaults.ts` 的默认值。线上实测：`auth.ipRegPerDay`
// 热改成 25，config 表里 override 明明还在，但重新部署后进程读到的又是 20。
//
// 现在把「应用一条 override」与「启动时把所有 override 读回来」放在一起，
// 保证写入与恢复用的是**同一套**路径解析与白名单判定，不会两边漂移。
import type { DB } from '../db/database.js';
import type { Config } from './defaults.js';

/** 前缀白名单（带点号，避免 `tradingX` 这类误匹配）。 */
export const CONFIG_WHITELIST = ['trading.', 'credit.', 'loans.', 'work.', 'p2p.'];

/**
 * 精确键白名单（全等匹配）。
 *
 * 为什么不直接往上面加 `'auth.ipRegPerDay'`：白名单是 `startsWith` 匹配，
 * 那样会派生放行 `auth.ipRegPerDayX` 这类不存在的键；而 `applyOverride` 对未知
 * 路径是**静默 return**（不报错），于是接口返回「写入成功」但配置毫无变化。
 * 故精确键单独判断。
 */
export const CONFIG_WHITELIST_EXACT = [
  'auth.ipRegPerDay',
  // 玩家价格冲击的两个键是**顶层**（不在 trading.* 下），故必须走精确键表。
  // 这两个值是「玩家能不能推动盘面」的总开关，运营中调它俩比调 trading.* 更常用。
  'playerImpactLambda',
  'playerImpactCap',
];

/** 该 config 键是否允许热改：精确键全等，其余走路由前缀。 */
export function isWhitelistedKey(key: string): boolean {
  if (CONFIG_WHITELIST_EXACT.includes(key)) return true;
  return CONFIG_WHITELIST.some(p => key.startsWith(p));
}

/** 把 "a.b.c" 形式的 override 原位写入 cfg（顶层节点为对象时逐层深入）。 */
export function applyOverride(cfg: Config, key: string, value: unknown): void {
  const parts = key.split('.');
  let node: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    const next = node[seg];
    if (next === null || typeof next !== 'object') return; // 未知路径：忽略
    node = next as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/**
 * 启动时把 config 表里的热改 override 全部恢复到 `cfg`。
 *
 * ⚠️ 只认白名单内的键（与 PUT 路由同一套判定）。表里还有一批**非白名单**的内部
 * 状态行（`master_seed` / `genesis_ms` / `divisor:*` / `matcher_*` / `ipo_*` /
 * `used_spares` 等），它们各有专门代码读取，**不要**在这里顺手套进 cfg ——
 * 那会把 `divisor:半导体` 这种带冒号、带中文的键当成 cfg 路径去解析。
 *
 * 返回实际恢复的键数，便于启动日志核对。
 */
export function loadOverrides(db: DB, cfg: Config): string[] {
  const rows = db.prepare('SELECT key, value FROM config ORDER BY key').all() as
    { key: string; value: string }[];
  const applied: string[] = [];
  for (const r of rows) {
    if (!isWhitelistedKey(r.key)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.value);
    } catch {
      // 非 JSON 的裸值（历史遗留）当作字符串，不要因此让整个启动失败
      parsed = r.value;
    }
    applyOverride(cfg, r.key, parsed);
    applied.push(r.key);
  }
  return applied;
}
