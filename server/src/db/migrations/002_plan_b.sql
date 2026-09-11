CREATE TABLE login_attempts (
  username TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
-- 职业种子（规格 §10；base_pay 单位分 = 元×100；仅基金经理有 min_credit）
INSERT OR IGNORE INTO jobs (id, name, base_pay, min_credit, reqs) VALUES
  (1, '传单派发员', 80000, NULL, '[]'),
  (2, '外卖骑手', 150000, NULL, '[["FIT",2]]'),
  (3, '在线客服', 160000, NULL, '[["COMM",2]]'),
  (4, '家教', 250000, NULL, '[["EDU",3]]'),
  (5, '平面设计师', 280000, NULL, '[["DESIGN",3],["COMM",1]]'),
  (6, '会计', 380000, NULL, '[["FIN",4],["EDU",2]]'),
  (7, '初级程序员', 400000, NULL, '[["CODE",4],["EDU",3]]'),
  (8, '高级工程师', 800000, NULL, '[["CODE",7],["EDU",5]]'),
  (9, '投行分析师', 1000000, NULL, '[["FIN",7],["EDU",6],["COMM",4]]'),
  (10, '基金经理', 1500000, 700, '[["FIN",9],["EDU",7]]');
CREATE INDEX idx_shifts_user ON shifts(user_id, end_gmin);
CREATE INDEX idx_loans_user ON loans(user_id, status);
