-- 003_p2p.sql —— 玩家间借贷（P2P）。
--
-- 与 NPC 银行贷款（loans）是两套并行的债务：本表记录玩家之间协商的借据，
-- 出借方的资金在放款时真正划转给借款方（不是无中生有的授信），因此不存在
-- "银行额度"概念 —— 上限只受出借方可用现金约束。
--
-- 状态机：
--   pending   —— 发起方已提交条件，等待对手方确认（此时**不划款**）
--   active    —— 双方同意、已放款，等待到期
--   repaid    —— 按期或提前全额还清
--   grace     —— 过了 due_day 仍在宽限期（罚息）
--   overdue   —— 宽限期满仍未还清，按日扣信誉
--   settled   —— 逾期后由结算钩子强制划扣清偿完毕
--   forgiven  —— 借款人破产，剩余债务豁免（出借方承担损失）
--   rejected / cancelled —— 未生效即终止，无资金变动
CREATE TABLE p2p_loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  borrower_id INTEGER NOT NULL,
  lender_id INTEGER NOT NULL,
  -- 规范化的一对玩家键（小 id, 大 id），仅供唯一索引使用：
  -- 同一对玩家同时只允许一笔未结清借据，避免互相加杠杆掩盖坏账。
  -- 不用 MIN()/MAX() 表达式索引 —— SQLite 不支持在索引里用聚合函数。
  pair_lo INTEGER NOT NULL,
  pair_hi INTEGER NOT NULL,
  principal INTEGER NOT NULL CHECK (principal > 0),
  repay_amount INTEGER NOT NULL CHECK (repay_amount >= principal),
  term_days INTEGER NOT NULL CHECK (term_days > 0),
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('borrow', 'lend')),
  awaiting_id INTEGER,
  day_created INTEGER NOT NULL,
  start_day INTEGER,
  due_day INTEGER,
  repaid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','repaid','grace','overdue','settled','forgiven',
                      'rejected','cancelled')),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_p2p_borrower ON p2p_loans(borrower_id, status);
CREATE INDEX idx_p2p_lender ON p2p_loans(lender_id, status);
CREATE UNIQUE INDEX idx_p2p_pair_active ON p2p_loans(pair_lo, pair_hi)
  WHERE status IN ('pending','active','grace','overdue');
