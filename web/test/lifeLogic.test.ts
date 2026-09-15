import { describe, it, expect } from 'vitest';
import {
  ABILITY_ORDER, ABILITY_LABEL, MAX_LEVEL, COURSE_HOURS_PER_LEVEL,
  abilityCells, radarPoint, radarVertices, toPointsAttr, axisLabelPoint, gridRing,
  requirementGap, wageBonusPct, shiftBlockReason, shiftStatusLabel, shiftTone,
  shiftHours, shiftCancellable, loanSummary, borrowableRoom, leverageNote, loanRateLabel,
  loanStatusLabel, loanTone, parseRepayInput, parseBorrowInput, creditDeltaTone,
  creditReasonLabel, repayable, borrowConditions,
} from '../src/pages/lifeLogic.js';
import type { JobRow, ShiftRow, LoanRow, LoanProduct, BankProducts, BorrowRoom } from '../src/api.js';

// ---------- 工厂 ----------

function job(over: Partial<JobRow> = {}): JobRow {
  return { id: 1, name: '外卖骑手', base_pay: 150_000, min_credit: null,
    reqs: [['FIT', 2]], eligible: false, wage: 150_000, ...over };
}

function shift(over: Partial<ShiftRow> = {}): ShiftRow {
  return { id: 1, job_id: 1, start_gmin: 1000, end_gmin: 1480, status: 'scheduled', pay: null, ...over };
}

function loan(over: Partial<LoanRow> = {}): LoanRow {
  return { id: 1, principal: 2_000_000, outstanding: 2_000_000, accruedInterest: 24_000,
    owedTotal: 2_024_000, rateE6: 500, termDays: 20, startDay: 1, dueDay: 21,
    status: 'active', ...over };
}

const product = (over: Partial<LoanProduct> = {}): LoanProduct =>
  ({ termDays: 20, rateE6: 500, capCents: 5_000_000, ...over });

/** 服务端 `borrowRoom()` 的下发形状。默认：授信剩余 ¥50,000、杠杆空间 ¥20,000（杠杆在卡）。 */
const room = (over: Partial<BorrowRoom> = {}): BorrowRoom => ({
  capCents: 5_000_000, creditRoom: 5_000_000, leverageRoom: 2_000_000, room: 2_000_000,
  binding: 'leverage', leverageCap: 2_000_000, divisor: 300,
  netWorth: 1_000_000, openPrincipal: 0, loansOutstanding: 0, ...over,
});

const bank = (over: Partial<BankProducts> = {}): BankProducts =>
  ({ credit: 600, creditLow: false, products: [product()], room: room(), ...over });

// ---------- 能力 ----------

describe('abilityCells', () => {
  it('按固定顺序输出六维，不依赖对象键序', () => {
    // 故意把键序打乱（数字无关字母键顺序在 JS 里不稳定）
    const cells = abilityCells(
      { DESIGN: 1, EDU: 2, FIT: 3, COMM: 4, FIN: 5, CODE: 6 },
      {},
    );
    expect(cells.map(c => c.kind)).toEqual([...ABILITY_ORDER]);
    expect(cells.map(c => c.label)).toEqual(['学识', '编程', '财商', '体质', '沟通', '设计']);
  });

  it('缺失的维度按 0 级处理（新用户 abilities 为空对象）', () => {
    const cells = abilityCells({}, {});
    expect(cells).toHaveLength(6);
    for (const c of cells) expect(c.level).toBe(0);
  });

  it('下一级耗时 = (level+1) × 8 游戏小时', () => {
    const cells = abilityCells({ EDU: 0, CODE: 3 }, {});
    const edu = cells.find(c => c.kind === 'EDU');
    const code = cells.find(c => c.kind === 'CODE');
    expect(edu?.nextHours).toBe(1 * COURSE_HOURS_PER_LEVEL);
    expect(code?.nextHours).toBe(4 * COURSE_HOURS_PER_LEVEL);
  });

  it('满级（10）时 nextCost/nextHours 均为 null 且 maxed=true', () => {
    const cells = abilityCells({ EDU: MAX_LEVEL }, { EDU: null });
    const edu = cells.find(c => c.kind === 'EDU');
    expect(edu?.maxed).toBe(true);
    expect(edu?.nextCost).toBeNull();
    expect(edu?.nextHours).toBeNull();
  });

  it('满级但服务端仍给了价格时，仍按满级处理（防「已满级还能报名」）', () => {
    const cells = abilityCells({ EDU: MAX_LEVEL }, { EDU: 34_359_738 });
    const edu = cells.find(c => c.kind === 'EDU');
    expect(edu?.maxed).toBe(true);
    expect(edu?.nextCost).toBeNull();
  });

  it('未满级但服务端漏给价格时 nextCost 为 null（不编 0）', () => {
    const cells = abilityCells({ EDU: 3 }, {});
    const edu = cells.find(c => c.kind === 'EDU');
    expect(edu?.maxed).toBe(false);
    expect(edu?.nextCost).toBeNull();
    expect(edu?.nextHours).toBe(32);
  });

  it('费用原样透传（单位是分，不在此处转换）', () => {
    const cells = abilityCells({ CODE: 2 }, { CODE: 1_280_000 });
    expect(cells.find(c => c.kind === 'CODE')?.nextCost).toBe(1_280_000);
  });
});

// ---------- 雷达图几何 ----------

describe('radarPoint', () => {
  // 基准：正六边形，圆心 (100,100)、半径 80
  const CX = 100; const CY = 100; const R = 80;

  it('第 0 维在正上方（-90°）', () => {
    const p = radarPoint(0, 1, CX, CY, R);
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(20, 6);      // 100 - 80
  });

  it('第 1 维在右上（-30°）', () => {
    const p = radarPoint(1, 1, CX, CY, R);
    expect(p.x).toBeCloseTo(100 + 80 * Math.cos(-Math.PI / 6), 6);
    expect(p.y).toBeCloseTo(100 + 80 * Math.sin(-Math.PI / 6), 6);
  });

  it('第 3 维在正下方（+90°）', () => {
    const p = radarPoint(3, 1, CX, CY, R);
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(180, 6);     // 100 + 80
  });

  it('value01=0 时所有顶点都退到圆心', () => {
    for (let i = 0; i < 6; i++) {
      const p = radarPoint(i, 0, CX, CY, R);
      expect(p.x).toBeCloseTo(CX, 6);
      expect(p.y).toBeCloseTo(CY, 6);
    }
  });

  it('value01=0.5 时顶点落在半径一半处', () => {
    const p = radarPoint(0, 0.5, CX, CY, R);
    expect(p.y).toBeCloseTo(60, 6);      // 100 - 40
  });
});

describe('radarVertices', () => {
  const CX = 100; const CY = 100; const R = 80;

  it('等级 0 / 5 / 10 对应半径 0 / 一半 / 满', () => {
    // 第 0 维在正上方，y = CY - R*(lv/10)
    const v0 = radarVertices([0, 0, 0, 0, 0, 0], CX, CY, R);
    const v5 = radarVertices([5, 0, 0, 0, 0, 0], CX, CY, R);
    const v10 = radarVertices([10, 0, 0, 0, 0, 0], CX, CY, R);
    expect(v0[0]?.y).toBeCloseTo(100, 6);
    expect(v5[0]?.y).toBeCloseTo(60, 6);
    expect(v10[0]?.y).toBeCloseTo(20, 6);
  });

  it('超出上限的等级被夹紧到 MAX_LEVEL（不会画出圆外）', () => {
    const v = radarVertices([99, 0, 0, 0, 0, 0], CX, CY, R);
    expect(v[0]?.y).toBeCloseTo(20, 6);
  });

  it('负等级被夹紧到 0（不会穿过圆心画到对面）', () => {
    const v = radarVertices([-5, 0, 0, 0, 0, 0], CX, CY, R);
    expect(v[0]?.y).toBeCloseTo(100, 6);
  });

  it('六维点数正确', () => {
    expect(radarVertices([1, 2, 3, 4, 5, 6], CX, CY, R)).toHaveLength(6);
  });
});

describe('toPointsAttr', () => {
  it('输出 x,y 空格分隔、保留两位小数', () => {
    expect(toPointsAttr([{ x: 1, y: 2 }, { x: 3.456, y: 4.004 }]))
      .toBe('1.00,2.00 3.46,4.00');
  });

  it('空数组输出空串（SVG points="" 合法，不渲染多边形）', () => {
    expect(toPointsAttr([])).toBe('');
  });
});

describe('axisLabelPoint', () => {
  it('比顶点再外扩 pad，避免标签压在图形上', () => {
    const p = axisLabelPoint(0, 100, 100, 80, 18);
    expect(p.y).toBeCloseTo(100 - 98, 6);   // radius+pad = 98
  });
});

describe('gridRing', () => {
  it('t=1 的环与满级顶点重合（网格最外圈 = 上限）', () => {
    const ring = gridRing(100, 100, 80, 1);
    const outer = radarVertices([10, 10, 10, 10, 10, 10], 100, 100, 80);
    expect(ring[0]?.y).toBeCloseTo(outer[0]?.y as number, 6);
    expect(ring[3]?.y).toBeCloseTo(outer[3]?.y as number, 6);
  });

  it('t=0 退到圆心', () => {
    const ring = gridRing(100, 100, 80, 0);
    expect(ring[0]?.y).toBeCloseTo(100, 6);
  });
});

// ---------- 打工 ----------

describe('requirementGap', () => {
  it('单维要求：需 体质≥2', () => {
    expect(requirementGap(job({ reqs: [['FIT', 2]] }))).toBe('需 体质≥2');
  });

  it('多维要求用顿号连接', () => {
    expect(requirementGap(job({ reqs: [['FIN', 4], ['EDU', 2]] })))
      .toBe('需 财商≥4、学识≥2');
  });

  it('信誉门槛一并列出', () => {
    expect(requirementGap(job({ reqs: [['CODE', 4]], min_credit: 700 })))
      .toBe('需 编程≥4、信誉≥700');
  });

  it('无任何要求返回 null（如传单派发员）', () => {
    expect(requirementGap(job({ reqs: [], min_credit: null }))).toBeNull();
  });

  it('未知能力码原样输出（不丢信息）', () => {
    expect(requirementGap(job({ reqs: [['XXX', 1]] }))).toBe('需 XXX≥1');
  });

  it('⚠️ reqs 是 tuple 数组而非对象 —— 传对象会静默失效', () => {
    // 这条测试锁定服务端契约：实测 GET /api/jobs 返回 reqs: [["FIT",2]]
    const g = requirementGap(job({ reqs: [['FIT', 2]] }));
    expect(g).toContain('体质≥2');
    // 若有人把它当对象写成 {FIT:2}，for...of 会抛「not iterable」
    expect(() => requirementGap({ ...job(), reqs: { FIT: 2 } as never })).toThrow();
  });
});

describe('wageBonusPct', () => {
  it('工资等于基准时涨幅 0', () => {
    expect(wageBonusPct(job({ base_pay: 150_000, wage: 150_000 }))).toBe(0);
  });

  it('+5%/点：3 点溢出 → +15%', () => {
    expect(wageBonusPct(job({ base_pay: 150_000, wage: 172_500 }))).toBeCloseTo(0.15, 10);
  });

  it('base_pay 为 0 返回 null（避免除零得 Infinity）', () => {
    expect(wageBonusPct(job({ base_pay: 0, wage: 100 }))).toBeNull();
  });
});

describe('shiftBlockReason', () => {
  it('合格返回 null', () => {
    expect(shiftBlockReason(job({ eligible: true }))).toBeNull();
  });

  it('不合格返回具体缺口而非笼统文案', () => {
    expect(shiftBlockReason(job({ eligible: false, reqs: [['COMM', 2]] })))
      .toBe('需 沟通≥2');
  });

  it('不合格但无 reqs 时兜底「资格不足」（如仅信誉不够）', () => {
    expect(shiftBlockReason(job({ eligible: false, reqs: [], min_credit: 700 })))
      .toBe('需 信誉≥700');
  });
});

describe('班次状态', () => {
  it('四种状态有中文标签', () => {
    expect(shiftStatusLabel('scheduled')).toBe('已排班');
    expect(shiftStatusLabel('working')).toBe('进行中');
    expect(shiftStatusLabel('done')).toBe('已完成');
    expect(shiftStatusLabel('cancelled')).toBe('已取消');
  });

  it('未知状态回原文，不丢信息', () => {
    expect(shiftStatusLabel('weird')).toBe('weird');
  });

  it('色调：working 高亮、done 绿、其余灰', () => {
    expect(shiftTone('working')).toBe('active');
    expect(shiftTone('done')).toBe('done');
    expect(shiftTone('scheduled')).toBe('flat');
    expect(shiftTone('cancelled')).toBe('flat');
  });

  it('时长 = (end − start) / 60 游戏小时（一班 480 gmin = 8 小时）', () => {
    expect(shiftHours({ start_gmin: 1000, end_gmin: 1480 })).toBe(8);
  });
});

describe('shiftCancellable', () => {
  it('scheduled 且未开始 → 可取消', () => {
    expect(shiftCancellable(shift({ status: 'scheduled', start_gmin: 1000 }), 999)).toBe(true);
  });

  it('已到开始时刻 → 不可取消（与服务端 SHIFT_STARTED 同口径）', () => {
    expect(shiftCancellable(shift({ status: 'scheduled', start_gmin: 1000 }), 1000)).toBe(false);
  });

  it('working / done / cancelled 一律不可取消', () => {
    for (const st of ['working', 'done', 'cancelled']) {
      expect(shiftCancellable(shift({ status: st, start_gmin: 5000 }), 1)).toBe(false);
    }
  });
});

// ---------- 银行 ----------

describe('loanSummary', () => {
  it('只统计未结清贷款', () => {
    const s = loanSummary([
      loan({ outstanding: 1_000_000, owedTotal: 1_010_000 }),
      loan({ id: 2, outstanding: 500_000, owedTotal: 505_000 }),
      loan({ id: 3, status: 'repaid', outstanding: 0, owedTotal: 0 }),
      loan({ id: 4, status: 'liquidated', outstanding: 0, owedTotal: 0 }),
    ]);
    expect(s.openCount).toBe(2);
    expect(s.outstandingPrincipal).toBe(1_500_000);
    expect(s.owedTotal).toBe(1_515_000);
  });

  it('识别 overdue 与 grace', () => {
    const s = loanSummary([loan({ status: 'overdue' }), loan({ id: 2, status: 'grace' })]);
    expect(s.hasOverdue).toBe(true);
    expect(s.hasGrace).toBe(true);
  });

  it('空数组全零', () => {
    const s = loanSummary([]);
    expect(s).toEqual({ outstandingPrincipal: 0, owedTotal: 0, openCount: 0,
      hasOverdue: false, hasGrace: false });
  });

  it('repaid 不算逾期（已结清不留告警）', () => {
    expect(loanSummary([loan({ status: 'repaid' })]).hasOverdue).toBe(false);
  });
});

describe('borrowableRoom', () => {
  it('直接取服务端算好的 room', () => {
    expect(borrowableRoom(bank({ room: room({ room: 3_000_000 }) }))).toBe(3_000_000);
  });

  it('⚠️ 取的是 min(授信剩余, 杠杆空间)，不是授信上限本身', () => {
    // 这正是「UI 说能借 ¥3,000,000、服务端只放 ¥2,000,000」那个缺陷的护栏：
    // 额度改成公式后授信上限会超过杠杆上限，用 capCents 会显示一个借不到的数字。
    const b = bank({
      products: [product({ capCents: 300_000_000 })],
      room: room({ capCents: 300_000_000, creditRoom: 300_000_000,
        leverageRoom: 200_000_000, room: 200_000_000 }),
    });
    expect(borrowableRoom(b)).toBe(200_000_000);
    expect(borrowableRoom(b)).not.toBe(b.products[0]!.capCents);
  });

  it('负数夹到 0（不该显示负额度）', () => {
    expect(borrowableRoom(bank({ room: room({ room: -1 }) }))).toBe(0);
  });

  it('信誉 <500（无档位、room 全 0）返回 0', () => {
    const b = bank({ products: [], room: room({ capCents: 0, creditRoom: 0,
      leverageRoom: 0, room: 0, binding: 'credit' }) });
    expect(borrowableRoom(b)).toBe(0);
  });
});

describe('leverageNote', () => {
  it('杠杆在卡时给出人话说明，且系数取自服务端（不写死 300）', () => {
    const n = leverageNote(bank({ room: room({ binding: 'leverage', divisor: 200,
      leverageCap: 3_000_000 }) }));
    expect(n).toContain('÷ 200');            // 不是写死的 300
    expect(n).toContain('¥30,000.00');
  });

  it('授信额度在卡时不占位（返回 null）', () => {
    expect(leverageNote(bank({ room: room({ binding: 'credit' }) }))).toBeNull();
  });
});

describe('利率与状态展示', () => {
  it('日息率：rateE6 300 → 0.030%/日（不得标年化，也不得重复拼 /日）', () => {
    expect(loanRateLabel(300)).toBe('0.030%/日');
    expect(loanRateLabel(300)).not.toContain('/日/日');
  });

  it('六种贷款状态有中文标签', () => {
    expect(loanStatusLabel('active')).toBe('正常');
    expect(loanStatusLabel('grace')).toBe('宽限期');
    expect(loanStatusLabel('overdue')).toBe('已逾期');
    expect(loanStatusLabel('repaid')).toBe('已还清');
    expect(loanStatusLabel('liquidated')).toBe('已强平');
    expect(loanStatusLabel('forgiven')).toBe('已豁免');
  });

  it('色调：overdue 危险、grace 警示、其余灰', () => {
    expect(loanTone('overdue')).toBe('danger');
    expect(loanTone('grace')).toBe('warning');
    expect(loanTone('active')).toBe('flat');
    expect(loanTone('repaid')).toBe('flat');
  });

  it('已结清的贷款不可还款', () => {
    expect(repayable(loan({ status: 'active' }))).toBe(true);
    expect(repayable(loan({ status: 'grace' }))).toBe(true);
    expect(repayable(loan({ status: 'overdue' }))).toBe(true);
    expect(repayable(loan({ status: 'repaid' }))).toBe(false);
    expect(repayable(loan({ status: 'liquidated' }))).toBe(false);
    expect(repayable(loan({ status: 'forgiven' }))).toBe(false);
  });
});

describe('parseRepayInput / parseBorrowInput', () => {
  it('元 → 分', () => {
    expect(parseRepayInput('1234.56')).toEqual({ cents: 123_456 });
  });

  it('整数元', () => {
    expect(parseRepayInput('20000')).toEqual({ cents: 2_000_000 });
  });

  it('空输入报错', () => {
    expect(parseRepayInput('   ')).toEqual({ error: '请输入还款金额' });
  });

  it('非法格式报错', () => {
    expect(parseRepayInput('abc')).toEqual({ error: '金额格式不正确' });
  });

  it('零或负报错', () => {
    expect(parseRepayInput('0')).toEqual({ error: '还款金额须大于 0' });
    expect(parseRepayInput('-5')).toEqual({ error: '还款金额须大于 0' });
  });

  it('借款须为整元', () => {
    expect(parseBorrowInput('20000')).toEqual({ cents: 2_000_000 });
    expect(parseBorrowInput('20000.5')).toEqual({ error: '借款金额须为整元' });
  });
});

describe('信誉流水', () => {
  it('⚠️ 信誉分是「越高越好」，故升绿降红（与股价涨红跌绿相反）', () => {
    expect(creditDeltaTone(15)).toBe('down');    // 上升 → 绿
    expect(creditDeltaTone(-8)).toBe('up');      // 下降 → 红
    expect(creditDeltaTone(0)).toBe('flat');
  });

  it('常见原因有中文映射', () => {
    expect(creditReasonLabel('WAGE_SHIFT')).toBe('完成班次');
    expect(creditReasonLabel('FORCED_LIQ')).toBe('强制平仓');
    expect(creditReasonLabel('REPAY_EARLY')).toBe('提前还清');
  });

  it('未收录原因回原文，不丢信息', () => {
    expect(creditReasonLabel('SOME_NEW_REASON')).toBe('SOME_NEW_REASON');
  });
});

describe('borrowConditions', () => {
  it('有档位时给出可核对的量化条件', () => {
    const c = borrowConditions([product({ capCents: 5_000_000, rateE6: 500 })]);
    expect(c.join('|')).toContain('¥50,000.00');
    expect(c.join('|')).toContain('0.050%/日');
    expect(c.join('|')).toContain('信誉分 ≥ 500');
  });

  it('无档位（信誉 <500）时只给门槛', () => {
    expect(borrowConditions([])).toEqual(['信誉分 ≥ 500']);
  });

  it('⚠️ 杠杆系数取自服务端，不写死 300（leverageDivisor 可热改）', () => {
    const c = borrowConditions([product()], room({ divisor: 200, leverageCap: 3_000_000 }));
    expect(c.join('|')).toContain('÷ 200');
    expect(c.join('|')).not.toContain('÷ 300');
    expect(c.join('|')).toContain('¥30,000.00');
  });

  it('room 缺席（理论不该发生）时不写具体系数，免得写个错的', () => {
    const c = borrowConditions([product()], null);
    expect(c.join('|')).toContain('杠杆系数');
    expect(c.join('|')).not.toMatch(/÷ \d/);
  });
});
