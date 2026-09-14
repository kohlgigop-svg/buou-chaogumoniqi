import { describe, it, expect } from 'vitest';
import { DEFAULTS } from '../../src/config/defaults.js';

describe('plan-b config 扩展', () => {
  it('trading 节逐键精确', () => {
    expect(DEFAULTS.trading.marketBufferPct).toBe(0.02);
    expect(DEFAULTS.trading.slippageK).toBe(0.06);
    expect(DEFAULTS.trading.boardFillProb).toBe(0.25);
    expect(DEFAULTS.trading.boardFillRatio).toEqual([0.1, 0.5]);
  });

  it('auth 节逐键精确', () => {
    expect(DEFAULTS.auth.initialCash).toBe(10_000_000);
    expect(DEFAULTS.auth.sessionDays).toBe(30);
    expect(DEFAULTS.auth.ipRegPerDay).toBe(20);
    expect(DEFAULTS.auth.loginLockN).toBe(5);
    expect(DEFAULTS.auth.loginLockMin).toBe(15);
  });

  it('credit 节逐键精确', () => {
    expect(DEFAULTS.credit.min).toBe(350);
    expect(DEFAULTS.credit.max).toBe(850);
    expect(DEFAULTS.credit.start).toBe(600);
    expect(DEFAULTS.credit.repayOnTime).toBe(15);
    expect(DEFAULTS.credit.repayEarly).toBe(20);
    expect(DEFAULTS.credit.overduePerDay).toBe(-8);
    expect(DEFAULTS.credit.forcedLiq).toBe(-80);
    expect(DEFAULTS.credit.bankruptcyScore).toBe(400);
    expect(DEFAULTS.credit.shiftPoint).toBe(1);
    expect(DEFAULTS.credit.shiftCapPer20d).toBe(10);
  });

  it('loans 节逐键精确', () => {
    expect(DEFAULTS.loans.termDays).toEqual([20, 60, 120]);
    expect(DEFAULTS.loans.graceDays).toBe(3);
    expect(DEFAULTS.loans.penaltyMult).toBe(2);
    expect(DEFAULTS.loans.liqOverdueDay).toBe(10);
    expect(DEFAULTS.loans.leverageDivisor).toBe(300);
    expect(DEFAULTS.loans.reliefCash).toBe(2_000_000);
  });

  it('loans.tiers 全部 8 档（minScore 降序）', () => {
    expect(DEFAULTS.loans.tiers).toEqual([
      [850, 50_000_000, 300],
      [800, 32_000_000, 320],
      [750, 20_000_000, 350],
      [700, 13_000_000, 400],
      [650, 8_000_000, 450],
      [600, 5_000_000, 500],
      [550, 3_000_000, 550],
      [500, 2_000_000, 600],
    ]);
    const scores = DEFAULTS.loans.tiers.map(t => t[0]);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('work 节逐键精确', () => {
    expect(DEFAULTS.work.wageBonusPerPoint).toBe(0.05);
    expect(DEFAULTS.work.shiftsPerDay).toBe(2);
    expect(DEFAULTS.work.shiftGameHours).toBe(8);
    expect(DEFAULTS.work.coursePriceBase).toBe(500_000);
    expect(DEFAULTS.work.coursePriceMult).toBe(1.6);
    expect(DEFAULTS.work.courseHoursPerLevel).toBe(8);
    expect(DEFAULTS.work.maxLevel).toBe(10);
  });

  it('work.coursePrices 10 个字面量逐个精确 + 总和 90_792_635', () => {
    expect(DEFAULTS.work.coursePrices).toHaveLength(10);
    expect(DEFAULTS.work.coursePrices[0]).toBe(500_000);
    expect(DEFAULTS.work.coursePrices[1]).toBe(800_000);
    expect(DEFAULTS.work.coursePrices[2]).toBe(1_280_000);
    expect(DEFAULTS.work.coursePrices[3]).toBe(2_048_000);
    expect(DEFAULTS.work.coursePrices[4]).toBe(3_276_800);
    expect(DEFAULTS.work.coursePrices[5]).toBe(5_242_880);
    expect(DEFAULTS.work.coursePrices[6]).toBe(8_388_608);
    expect(DEFAULTS.work.coursePrices[7]).toBe(13_421_773);
    expect(DEFAULTS.work.coursePrices[8]).toBe(21_474_836);
    expect(DEFAULTS.work.coursePrices[9]).toBe(34_359_738);
    expect(DEFAULTS.work.coursePrices.reduce((a, b) => a + b, 0)).toBe(90_792_635);
  });

  it('计划 A 既有键不受影响', () => {
    expect(DEFAULTS.backupKeep).toBe(7);
    expect(DEFAULTS.poolTarget).toBe(48);
  });
});
