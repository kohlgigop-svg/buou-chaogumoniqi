// test/adminLogic.test.ts —— Task 9 纯逻辑：config 白名单 / 值解析 / 格式化的边界。
import { describe, it, expect } from 'vitest';
import {
  isHotReloadableKey,
  checkConfigKey,
  parseConfigValue,
  describeValue,
  fmtBytes,
  filterUsers,
  userStatusLabel,
  initialOf,
  backupDay,
  sortBackups,
  CONFIG_WHITELIST_PREFIXES,
  CONFIG_WHITELIST_EXACT,
} from '../src/pages/adminLogic.js';
// ⚠️ 直接 import **服务端**那份白名单做交叉断言 —— 这是防漂移的唯一可靠办法。
// 之前两边各写一份字面量，服务端加了键、前端没跟上，测试照样全绿。
import {
  CONFIG_WHITELIST as SERVER_WHITELIST_PREFIXES,
  CONFIG_WHITELIST_EXACT as SERVER_WHITELIST_EXACT,
  isWhitelistedKey as SERVER_isWhitelistedKey,
} from '../../server/src/config/overrides.js';

describe('config 白名单：只允许 trading./credit./loans./work./auth.ipRegPerDay', () => {
  it('五个合法键都通过', () => {
    expect(isHotReloadableKey('trading.slippageK')).toBe(true);
    expect(isHotReloadableKey('credit.start')).toBe(true);
    expect(isHotReloadableKey('loans.graceDays')).toBe(true);
    expect(isHotReloadableKey('work.shiftsPerDay')).toBe(true);
    expect(isHotReloadableKey('auth.ipRegPerDay')).toBe(true);
  });

  it('⚠️ auth 节其余键仍必须被拦住（只放开 ipRegPerDay 这一个）', () => {
    expect(isHotReloadableKey('auth.initialCash')).toBe(false);
    expect(isHotReloadableKey('auth.loginLockN')).toBe(false);
    expect(isHotReloadableKey('auth.ipRegPerDayX')).toBe(false);
  });

  it('⚠️ auth.sessionDays 必须被拦住（计划明确要求）', () => {
    expect(isHotReloadableKey('auth.sessionDays')).toBe(false);
  });

  it('点号是必需的：前缀后直接跟别的字符不算匹配', () => {
    // 'tradingX.y' 不以 'trading.' 开头（少了点），必须拒
    expect(isHotReloadableKey('tradingX.y')).toBe(false);
    expect(isHotReloadableKey('workX.shiftsPerDay')).toBe(false);
  });

  it('其它常见节都被拦住', () => {
    for (const k of ['auth.initialCash', 'limits.SH', 'regime.muDay', 'poolMax',
      'stRule.delistDays', 'backupKeep', 'anchor.peSigma']) {
      expect(isHotReloadableKey(k)).toBe(false);
    }
  });

  // ⚠️ 这两条以前只断言「前端等于一个字面量」，于是服务端加了 `p2p.` 与两个
  // 玩家冲击键时**完全没报警**，前端白名单悄悄落后 —— 后果是后台界面会拒绝
  // 热改这些键（前端先拦，请求根本发不出去）。现在直接 import 服务端那份做交叉断言。
  it('前缀白名单与服务端一致（交叉断言，防漂移）', () => {
    expect([...CONFIG_WHITELIST_PREFIXES]).toEqual([...SERVER_WHITELIST_PREFIXES]);
    // 顺带钉住内容，避免「两边一起改错」也算通过
    expect([...CONFIG_WHITELIST_PREFIXES]).toEqual(
      ['trading.', 'credit.', 'loans.', 'work.', 'p2p.']);
  });

  it('精确键白名单与服务端一致（交叉断言，防漂移）', () => {
    expect([...CONFIG_WHITELIST_EXACT]).toEqual([...SERVER_WHITELIST_EXACT]);
    expect([...CONFIG_WHITELIST_EXACT]).toEqual(
      ['auth.ipRegPerDay', 'playerImpactLambda', 'playerImpactCap']);
  });

  it('⚠️ 两侧 isHotReloadableKey 判定完全一致（对每个键逐一比对）', () => {
    // 只比数组还不够 —— 万一判定函数写法不同（如大小写、点号处理）仍会不一致。
    // 拿一批代表性键（白名单内、白名单外、边界形态）两边各判一次。
    const probes = [
      'trading.slippageK', 'credit.basis', 'loans.maxRate', 'work.shiftsPerDay',
      'p2p.maxTermDays', 'auth.ipRegPerDay', 'playerImpactLambda', 'playerImpactCap',
      'auth.initialCash', 'tradingX', 'p2p', 'auth.', 'playerImpactLambdaX', '',
    ];
    for (const k of probes) {
      expect([k, isHotReloadableKey(k)]).toEqual([k, SERVER_isWhitelistedKey(k)]);
    }
  });
});

describe('checkConfigKey：给出可直接渲染的中文原因', () => {
  it('合法键 ok 且无 reason', () => {
    const r = checkConfigKey('work.shiftsPerDay');
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('空串 → 提示填写', () => {
    const r = checkConfigKey('   ');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('请填写');
  });

  it('没有点号 → 提示格式', () => {
    const r = checkConfigKey('poolMax');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('节.字段');
  });

  it('非白名单 → 原因里列出允许的前缀', () => {
    const r = checkConfigKey('auth.sessionDays');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('trading.');
    expect(r.reason).toContain('work.');
  });

  it('两侧空白被容忍', () => {
    expect(checkConfigKey('  work.shiftsPerDay  ').ok).toBe(true);
  });
});

describe('parseConfigValue：区分「数字」与「字符串」', () => {
  it('JSON 数字', () => {
    expect(parseConfigValue('1')).toEqual({ ok: true, value: 1, kind: 'json' });
    expect(parseConfigValue('0.05')).toEqual({ ok: true, value: 0.05, kind: 'json' });
  });

  it('⚠️ 带引号的是字符串，不是数字', () => {
    expect(parseConfigValue('"1"')).toEqual({ ok: true, value: '1', kind: 'json' });
  });

  it('JSON true/false/null', () => {
    expect(parseConfigValue('true')).toMatchObject({ value: true, kind: 'json' });
    expect(parseConfigValue('false')).toMatchObject({ value: false, kind: 'json' });
    // null 也是合法 JSON，kind 仍是 json
    expect(parseConfigValue('null')).toMatchObject({ value: null, kind: 'json' });
  });

  it('数组与对象', () => {
    expect(parseConfigValue('[1, 2]')).toMatchObject({ value: [1, 2], kind: 'json' });
    expect(parseConfigValue('{"a":1}')).toMatchObject({ value: { a: 1 }, kind: 'json' });
  });

  it('裸词回落为字符串（并显式标记 kind=string）', () => {
    expect(parseConfigValue('bull')).toEqual({ ok: true, value: 'bull', kind: 'string' });
  });

  it('空白 → 提示填写', () => {
    const r = parseConfigValue('  ');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('请填写');
  });

  it('字符串值保留用户原始输入（含内部空格）', () => {
    const r = parseConfigValue('a b c');
    expect(r.value).toBe('a b c');
  });
});

describe('describeValue：回显"将写入什么"', () => {
  it('字符串带引号（与数字可区分）', () => {
    expect(describeValue('1')).toBe('"1"');
    expect(describeValue(1)).toBe('1');
  });

  it('undefined 显形，不显示成空', () => {
    expect(describeValue(undefined)).toBe('undefined');
  });

  it('对象/数组序列化', () => {
    expect(describeValue([1, 2])).toBe('[1,2]');
    expect(describeValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('fmtBytes', () => {
  it('B / KB / MB 三档', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });

  it('非法值给占位符而不是 NaN', () => {
    expect(fmtBytes(-1)).toBe('—');
    expect(fmtBytes(Number.NaN)).toBe('—');
    expect(fmtBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('filterUsers：大小写不敏感的包含匹配', () => {
  const users = [{ username: 'alice' }, { username: 'Bob' }, { username: 'alicia' }];

  it('空查询返回全部（同一引用，避免无谓渲染）', () => {
    expect(filterUsers(users, '')).toBe(users);
    expect(filterUsers(users, '   ')).toBe(users);
  });

  it('子串匹配且忽略大小写', () => {
    expect(filterUsers(users, 'ALI').map(u => u.username)).toEqual(['alice', 'alicia']);
    expect(filterUsers(users, 'bob').map(u => u.username)).toEqual(['Bob']);
  });

  it('无匹配 → 空数组', () => {
    expect(filterUsers(users, 'zzz')).toEqual([]);
  });
});

describe('userStatusLabel / initialOf', () => {
  it('active/banned 中文化', () => {
    expect(userStatusLabel('active')).toBe('正常');
    expect(userStatusLabel('banned')).toBe('已封禁');
  });

  it('未知状态回落原文而非空白', () => {
    expect(userStatusLabel('weird')).toBe('weird');
    expect(userStatusLabel('')).toBe('未知');
  });

  it('首字母大写，空名给 ?', () => {
    expect(initialOf('alice')).toBe('A');
    expect(initialOf('   ')).toBe('?');
  });
});

describe('backupDay / sortBackups', () => {
  it('解析 day-N.db', () => {
    expect(backupDay('day-3.db')).toBe(3);
    expect(backupDay('day-0.db')).toBe(0);
  });

  it('不符合命名返回 null', () => {
    expect(backupDay('other.db')).toBeNull();
    expect(backupDay('day-3.db.bak')).toBeNull();
    expect(backupDay('day-.db')).toBeNull();
  });

  it('降序排列（最新在前）', () => {
    const files = [{ file: 'day-1.db' }, { file: 'day-10.db' }, { file: 'day-2.db' }];
    expect(sortBackups(files).map(f => f.file)).toEqual(['day-10.db', 'day-2.db', 'day-1.db']);
  });

  it('不修改入参（纯函数）', () => {
    const files = [{ file: 'day-1.db' }, { file: 'day-2.db' }];
    sortBackups(files);
    expect(files.map(f => f.file)).toEqual(['day-1.db', 'day-2.db']);
  });
});
