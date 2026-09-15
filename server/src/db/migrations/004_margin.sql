-- 004_margin.sql —— 融资融券（信用交易）
--
-- 与 NPC 银行贷款（`loans`）的本质差别：
--   loans      = 无抵押信用贷，钱到手随便花，按信誉分定额度；
--   margin     = **有担保的杠杆交易**，钱只能买指定标的，且实时受「维持担保比例」约束，
--                跌破平仓线会被强制平仓。两者不能互相套用。
--
-- 现实规则（A 股）在本表的落点：
--   · 融资保证金比例 = 保证金 / 融资买入金额（默认 50% ⇒ 2 倍杠杆）；
--     借入额 = 融资买入金额 × (1 − 保证金比例)；
--   · 融券卖出所得**必须冻结**在信用账户里作担保，不能花；另需自备同等比例的保证金；
--   · 维持担保比例 = (现金 + 证券市值) / (融资负债 + 融券市值 + 利息费用)；
--     警戒线 150%（不能再开新仓）、平仓线 130%（追保，T+1 未补足即强平）。
--
-- ⚠️ 现金不另开一个桶：`ledger.bucket` 只有 'A'/'F'，且 `auditUser` 要求
--    「Σ ledger(A) === users.cash_available、Σ ledger(F) === users.cash_frozen」。
--    凭空造一个「信用账户现金」会让全局勾稽失守。故所有资金仍在 A/F 两桶里流转：
--    融资放款是 BANK→user(A)；保证金随买入付款从 A 走；融券的卖出所得与自备保证金
--    一起 A→F 冻结（「F 桶里属于融券担保的部分」就是 `margin_positions.frozen` 之和）。
--
-- ⚠️ 债务**不进 ledger**：ledger 记的是现金流向，不是债权。融资放款那天
--    `BANK -X / user +X` 已经落账；日后无论还款还是被豁免，都只是改本表/持仓表的数字
--    （还款另有一条 user→BANK 的现金腿）。所以「豁免债务」不会让 auditGlobal 失衡。
CREATE TABLE margin_accounts (
  user_id INTEGER PRIMARY KEY,
  /** 融资负债**本金**（分）。利息单列，避免「还了一部分之后不知道还的是本还是息」。 */
  debt INTEGER NOT NULL DEFAULT 0,
  /** 累计未付的融资利息 + 融券费用（分）。逐日结算时计提。 */
  interest INTEGER NOT NULL DEFAULT 0,
  opened_day INTEGER NOT NULL,
  /**
   * 首次跌破平仓线的游戏日，用于「T+1 追保」计时：当日只记录，**次日结算仍不达标才强平**。
   * 补足（比例回到平仓线之上）即清零。NULL = 当前不在追保状态。
   */
  warn_since_day INTEGER,
  /** 被强制平仓的次数（信誉惩罚与展示用）。 */
  liquidated_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE margin_positions (
  user_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  /** long = 融资买入（多头，担保物）；short = 融券卖出（空头，负债）。 */
  kind TEXT NOT NULL CHECK (kind IN ('long', 'short')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  /** long：建仓总支出（分，含费）；short：卖出净额（分）。都是「盈亏基准」。 */
  cost INTEGER NOT NULL DEFAULT 0,
  /**
   * 该笔空头**冻结在 F 桶**的资金（分）= 融券卖出净额 + 自备保证金。
   * 多头恒为 0（融资买入的担保物是股票本身，记在 `holdings.qty_margin`）。
   * 买券还券时按 `frozen × 还券量 / 持仓量` 比例解冻。
   */
  frozen INTEGER NOT NULL DEFAULT 0,
  opened_day INTEGER NOT NULL,
  PRIMARY KEY (user_id, code, kind)
);
CREATE INDEX idx_margin_pos_user ON margin_positions(user_id);

-- 融资买入的股票**仍然记在 holdings 里**（这样分红、退市回收、估值、T+1 全部沿用既有路径，
-- 不必在 5 个地方各抄一遍「还要算上信用持仓」），但多一列记录其中有多少是**担保物**：
--   · 担保物部分不可卖 → 日终 T+1 解冻时 `qty_sellable = qty_total − qty_margin`；
--   · 卖券还款时同步递减 qty_margin。
-- 不变式：`qty_total === qty_sellable + qty_margin`（普通买入只加 qty_total 与次日 qty_sellable，
-- 不加 qty_margin；融资买入只加 qty_total 与 qty_margin）。
-- ⚠️ 日终那句 `UPDATE holdings SET qty_sellable = qty_total` 若不同步改，
--    担保股票会在次日被解锁成可卖 —— 那等于让玩家把券商的抵押品卖掉。
ALTER TABLE holdings ADD COLUMN qty_margin INTEGER NOT NULL DEFAULT 0;
