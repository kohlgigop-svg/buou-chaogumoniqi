// errors.ts —— 服务端错误码 → 用户可读中文提示。
//
// 码表来源：`grep -rhoE "new AppError\('[A-Z_]+'" server/src/` 全量提取（33 个），
// 外加 zod 校验分支的 VALIDATION 与前端本地生成的 HTTP_<status> 回落码。
//
// 纪律：未知码必须回落原文而不是空串 —— 宁可显示英文码，也不要让用户面对空白。

const MESSAGES: Record<string, string> = {
  // —— 鉴权 ——
  BAD_CREDENTIALS: '用户名或密码错误',
  UNAUTHORIZED: '请先登录',
  BANNED: '账号已被封禁',
  LOCKED: '尝试次数过多，请稍后再试',
  REG_LIMIT: '今日注册名额已用完',
  USERNAME_TAKEN: '用户名已被占用',

  // —— 通用 ——
  RATE_LIMIT: '操作过于频繁，请稍后再试',
  FORBIDDEN: '无权限执行此操作',
  NOT_FOUND: '资源不存在',
  INTERNAL: '服务器异常，请稍后重试',
  VALIDATION: '输入不合法，请检查后重试',

  // —— 交易 ——
  PHASE_CLOSED: '当前时段不可交易',
  MARKET_IN_AUCTION: '集合竞价时段不可下市价单',
  UNKNOWN_STOCK: '标的不存在',
  STOCK_HALTED: '该标的已停牌',
  BAD_PRICE: '委托价格不合法',
  BAD_QTY: '委托数量不合法',
  INSUFFICIENT_CASH: '可用资金不足',
  INSUFFICIENT_POSITION: '持仓不足',
  NOT_CANCELLABLE: '该委托不可撤销',

  // —— 借贷 ——
  // 四个借款闸门都要能直接指向**该去哪改**，而不是笼统「不合法」：
  // CREDIT_LOW → 去打工/还款提信誉；OVERDUE_EXISTS → 先去还逾期那笔；
  // LOAN_LIMIT → 超当前信誉档的额度上限；LEVERAGE → 超净资产×信誉分÷300。
  CREDIT_LOW: '信誉分不足，暂无法借款',
  LEVERAGE: '超出杠杆上限',
  LOAN_LIMIT: '超出授信额度上限',
  LOAN_NOT_FOUND: '贷款不存在',
  LOAN_CLOSED: '该笔贷款已结清',
  OVERDUE_EXISTS: '有逾期贷款未结清，暂无法借新贷',
  BAD_AMOUNT: '金额不合法',
  BAD_TERM: '期限不合法',

  // —— 打工与能力 ——
  JOB_NOT_FOUND: '职业不存在',
  JOB_REQUIREMENT: '能力或信誉未达标',
  SHIFT_NOT_FOUND: '班次不存在',
  SHIFT_CAP: '今日排班已达上限',
  SHIFT_STARTED: '班次已开始，无法取消',
  SHIFT_NOT_CANCELLABLE: '该班次不可取消',
  COURSE_MAX: '该项能力已满级',

  // —— 管理 ——
  CONFIG_KEY: '该配置项不可热改',
};

/** 用户可读提示；未知码回落原文，空码给通用兜底。 */
export function errorText(code: string): string {
  if (code === '') return '操作失败，请稍后重试';
  const known = MESSAGES[code];
  if (known !== undefined) return known;
  // 网关/非 JSON 响应由 api.ts 生成本地回落码，语义统一为「服务暂时不可用」。
  if (code.startsWith('HTTP_')) return '服务暂时不可用，请稍后重试';
  return code;
}
