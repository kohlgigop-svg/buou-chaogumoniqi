// config/defaults.ts —— 规格 §14 的机器可读形态（本计划用到的键，计划 B 再扩）
export interface Config {
  volSigmaDay: { L: number; M: number; H: number; cyMult: number };   // 0.012/0.018/0.026/1.3
  regime: { states: ['bull', 'range', 'bear'];
    muDay: [number, number, number];        // [+0.0035, 0, -0.0040]
    sigmaDay: [number, number, number];     // [0.010, 0.008, 0.013]
    volMult: [number, number, number];      // [1.0, 0.9, 1.25]
    trans: number[][] };                    // 行随机矩阵 3x3
  sectorAR: { phi: number; sigmaDay: number };          // 0.3 / 0.006
  anchor: { kappaDaily: number; epsSigma: number; peSigma: number; reportNoise: number }; // 0.05/0.02/0.01/0.15
  eventsPerDay: { MKT: number; SEC: number; STK: number };  // 0.3/0.8/2.5
  eventRelease: { instantFrac: number; spreadTicks: number; driftDecay: number }; // 0.3/9/0.5
  reportPeriodDays: number;                 // 60
  payoutRatio: { H: number; M: number; L: number; N: number }; // 0.6/0.3/0.1/0
  limits: { SH: number; SZ: number; CY: number; ST: number; ipoUp: number; ipoDown: number }; // 0.10/0.10/0.20/0.05/0.44/0.36
  stRule: { lossToSt: number; stLossToDelist: number; delistDays: number; recovery: number }; // 2/1/20/0.3
  playerImpactLambda: number;               // 0.8（玩家净流入价格冲击系数）
  poolTarget: number; poolMax: number;      // 48 / 50
  backupKeep: number;                       // 7
  // —— 计划 B 扩展（规格 §5/§7/§8/§9/§10）——
  trading: { marketBufferPct: number; slippageK: number; boardFillProb: number;
    boardFillRatio: [number, number] };
  auth: { initialCash: number; sessionDays: number; ipRegPerDay: number;
    loginLockN: number; loginLockMin: number };
  credit: { min: number; max: number; start: number; repayOnTime: number; repayEarly: number;
    overduePerDay: number; forcedLiq: number; bankruptcyScore: number;
    shiftPoint: number; shiftCapPer20d: number };
  loans: { termDays: [number, number, number]; graceDays: number; penaltyMult: number;
    liqOverdueDay: number; leverageDivisor: number; reliefCash: number;
    tiers: [number, number, number][] };    // [minScore, 授信上限(分), 日息 e6]，minScore 降序
  work: { wageBonusPerPoint: number; shiftsPerDay: number; shiftGameHours: number;
    coursePriceBase: number; coursePriceMult: number; courseHoursPerLevel: number;
    maxLevel: number; coursePrices: number[] };  // coursePrices：显式 10 级字面量表（分）
}

export const DEFAULTS: Config = {
  volSigmaDay: { L: 0.012, M: 0.018, H: 0.026, cyMult: 1.3 },
  regime: {
    states: ['bull', 'range', 'bear'],
    muDay: [0.0035, 0, -0.0040],
    sigmaDay: [0.010, 0.008, 0.013],
    volMult: [1.0, 0.9, 1.25],
    trans: [
      [0.97, 0.025, 0.005],
      [0.03, 0.94, 0.03],
      [0.01, 0.04, 0.95],
    ],
  },
  sectorAR: { phi: 0.3, sigmaDay: 0.006 },
  anchor: { kappaDaily: 0.05, epsSigma: 0.02, peSigma: 0.01, reportNoise: 0.15 },
  eventsPerDay: { MKT: 0.3, SEC: 0.8, STK: 2.5 },
  eventRelease: { instantFrac: 0.3, spreadTicks: 9, driftDecay: 0.5 },
  reportPeriodDays: 60,
  payoutRatio: { H: 0.6, M: 0.3, L: 0.1, N: 0 },
  limits: { SH: 0.10, SZ: 0.10, CY: 0.20, ST: 0.05, ipoUp: 0.44, ipoDown: 0.36 },
  stRule: { lossToSt: 2, stLossToDelist: 1, delistDays: 20, recovery: 0.3 },
  playerImpactLambda: 0.8,
  poolTarget: 48,
  poolMax: 50,
  backupKeep: 7,
  trading: { marketBufferPct: 0.02, slippageK: 0.06, boardFillProb: 0.25, boardFillRatio: [0.1, 0.5] },
  auth: { initialCash: 10_000_000, sessionDays: 30, ipRegPerDay: 5, loginLockN: 5, loginLockMin: 15 },
  credit: { min: 350, max: 850, start: 600, repayOnTime: 15, repayEarly: 20, overduePerDay: -8,
    forcedLiq: -80, bankruptcyScore: 400, shiftPoint: 1, shiftCapPer20d: 10 },
  loans: { termDays: [20, 60, 120], graceDays: 3, penaltyMult: 2, liqOverdueDay: 10,
    leverageDivisor: 300, reliefCash: 2_000_000,
    tiers: [ // <500 拒贷；取首个 minScore≤分数 的档
      [850, 50_000_000, 300], [800, 32_000_000, 320], [750, 20_000_000, 350],
      [700, 13_000_000, 400], [650, 8_000_000, 450], [600, 5_000_000, 500],
      [550, 3_000_000, 550], [500, 2_000_000, 600],
    ] },
  work: { wageBonusPerPoint: 0.05, shiftsPerDay: 2, shiftGameHours: 8,
    coursePriceBase: 500_000, coursePriceMult: 1.6, courseHoursPerLevel: 8, maxLevel: 10,
    // base×1.6^n 逐级四舍五入到分的定值表（字面量为准）
    coursePrices: [500_000, 800_000, 1_280_000, 2_048_000, 3_276_800,
      5_242_880, 8_388_608, 13_421_773, 21_474_836, 34_359_738] },
};
