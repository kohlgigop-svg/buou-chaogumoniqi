CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pwd_hash TEXT,
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system')),
  cash_available INTEGER NOT NULL DEFAULT 0,
  cash_frozen INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 600,
  bankrupt_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  reg_ip TEXT, created_day INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE stocks (
  code TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  board TEXT NOT NULL CHECK (board IN ('SH','SZ','CY')),
  sector TEXT NOT NULL, shares_total INTEGER NOT NULL,
  vol_tier TEXT NOT NULL CHECK (vol_tier IN ('L','M','H')),
  beta REAL NOT NULL, payout_tier TEXT NOT NULL CHECK (payout_tier IN ('H','M','L','N')),
  listed_day INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal','st','delisting','delisted')),
  st_since_day INTEGER, delist_at_day INTEGER, ipo_price INTEGER
);
CREATE TABLE stock_state (
  code TEXT PRIMARY KEY REFERENCES stocks(code),
  price INTEGER NOT NULL, prev_close INTEGER NOT NULL,
  open INTEGER, high INTEGER, low INTEGER,
  volume INTEGER NOT NULL DEFAULT 0, turnover INTEGER NOT NULL DEFAULT 0,
  limit_up INTEGER NOT NULL, limit_down INTEGER NOT NULL,
  eps_e6 INTEGER NOT NULL, pe REAL NOT NULL, equity_e6 INTEGER NOT NULL,
  loss_streak INTEGER NOT NULL DEFAULT 0, win_streak INTEGER NOT NULL DEFAULT 0,
  drift_json TEXT NOT NULL DEFAULT '[]', adv INTEGER NOT NULL
);
CREATE TABLE candles_day (code TEXT NOT NULL, day INTEGER NOT NULL,
  o INTEGER NOT NULL, h INTEGER NOT NULL, l INTEGER NOT NULL, c INTEGER NOT NULL,
  volume INTEGER NOT NULL, turnover INTEGER NOT NULL, PRIMARY KEY (code, day));
CREATE TABLE ticks (code TEXT NOT NULL, day INTEGER NOT NULL, tick INTEGER NOT NULL,
  price INTEGER NOT NULL, volume INTEGER NOT NULL, PRIMARY KEY (code, day, tick));
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL REFERENCES stocks(code),
  side TEXT NOT NULL CHECK (side IN ('B','S')), type TEXT NOT NULL CHECK (type IN ('L','M')),
  price INTEGER, qty INTEGER NOT NULL, filled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled','expired')),
  frozen INTEGER NOT NULL DEFAULT 0, client_key TEXT NOT NULL,
  day INTEGER NOT NULL, created_tick INTEGER NOT NULL,
  UNIQUE (user_id, client_key));
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
  user_id INTEGER NOT NULL, code TEXT NOT NULL, side TEXT NOT NULL,
  price INTEGER NOT NULL, qty INTEGER NOT NULL,
  commission INTEGER NOT NULL, stamp INTEGER NOT NULL, transfer INTEGER NOT NULL,
  day INTEGER NOT NULL, tick INTEGER NOT NULL);
CREATE TABLE holdings (user_id INTEGER NOT NULL, code TEXT NOT NULL,
  qty_total INTEGER NOT NULL DEFAULT 0 CHECK (qty_total >= 0),
  qty_sellable INTEGER NOT NULL DEFAULT 0 CHECK (qty_sellable >= 0),
  cost_total INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, code));
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('A','F')),
  day INTEGER NOT NULL, tick INTEGER NOT NULL, kind TEXT NOT NULL,
  amount INTEGER NOT NULL, balance_after INTEGER NOT NULL,
  ref_type TEXT NOT NULL, ref_id INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'ledger append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'ledger append-only'); END;
CREATE TABLE loans (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  principal INTEGER NOT NULL, outstanding INTEGER NOT NULL,
  rate_e6 INTEGER NOT NULL, term_days INTEGER NOT NULL,
  start_day INTEGER NOT NULL, due_day INTEGER NOT NULL,
  accrued_interest INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','grace','overdue','repaid','liquidated','forgiven')));
CREATE TABLE credit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  day INTEGER NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, score_after INTEGER NOT NULL);
CREATE TABLE jobs (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, base_pay INTEGER NOT NULL,
  min_credit INTEGER, reqs TEXT NOT NULL DEFAULT '[]');
CREATE TABLE shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  start_gmin INTEGER NOT NULL, end_gmin INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','working','done','cancelled')),
  pay INTEGER);
CREATE TABLE abilities (user_id INTEGER NOT NULL, kind TEXT NOT NULL
    CHECK (kind IN ('EDU','CODE','FIN','FIT','COMM','DESIGN')),
  level INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, kind));
CREATE TABLE enrollments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  kind TEXT NOT NULL, from_level INTEGER NOT NULL,
  start_gmin INTEGER NOT NULL, end_gmin INTEGER NOT NULL, cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled')));
CREATE TABLE news (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL, tick INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('MKT','SEC','STK')), target TEXT,
  type_id TEXT NOT NULL, title TEXT NOT NULL,
  impact_e6 INTEGER NOT NULL, drift_days INTEGER NOT NULL);
CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL,
  period_idx INTEGER NOT NULL, report_day INTEGER NOT NULL,
  eps_e6 INTEGER NOT NULL, revenue INTEGER NOT NULL, profit INTEGER NOT NULL,
  surprise_e6 INTEGER NOT NULL, UNIQUE (code, period_idx));
CREATE TABLE dividends (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL,
  announced_day INTEGER NOT NULL, ex_day INTEGER NOT NULL, per_share_e6 INTEGER NOT NULL);
CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE engine_state (id INTEGER PRIMARY KEY CHECK (id = 1),
  master_seed INTEGER NOT NULL, genesis_ms INTEGER NOT NULL,
  last_tick INTEGER NOT NULL DEFAULT -1, state_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL,
  content TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE admin_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL,
  action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX idx_ledger_user ON ledger (user_id, id);
CREATE INDEX idx_orders_open ON orders (code, status) WHERE status = 'open';
CREATE INDEX idx_trades_user ON trades (user_id, id);
CREATE INDEX idx_ticks_day ON ticks (day);
CREATE INDEX idx_news_day ON news (day, id);
INSERT INTO users (id, username, kind) VALUES
  (1,'@market','system'),(2,'@bank','system'),(3,'@tax','system'),(4,'@employer','system'),(5,'@clearing','system');
