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
};
