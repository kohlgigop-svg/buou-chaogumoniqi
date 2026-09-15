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
  /**
   * 玩家净流入价格冲击系数：`rPlayer = clamp(λ × netFlow/adv, ±playerImpactCap)`。
   *
   * λ 从 0.8 提到 8：本游戏玩家数量远少于现实市场，0.8 时 `λ × netFlow/adv` 落在
   * 1e-4 量级，`Math.round(price × exp(ret))` 对低价股（¥4~¥10）**取整后恒为原价**
   * —— 玩家买卖在盘面上完全不可见。8 使「一次全仓」在中位股上产生 ~1% 量级位移。
   */
  playerImpactLambda: number;
  /**
   * 玩家冲击的每 tick 饱和上限（±，比例）。原硬编码 3% 会把中等市值股一起压平，
   * 放宽到 5% —— 仍显著低于涨跌停（10%/20%），保留「单 tick 打不穿涨跌停」的语义。
   */
  playerImpactCap: number;
  poolTarget: number; poolMax: number;      // 48 / 50
  backupKeep: number;                       // 7
  // —— 计划 B 扩展（规格 §5/§7/§8/§9/§10）——
  trading: { marketBufferPct: number; slippageK: number; boardFillProb: number;
    boardFillRatio: [number, number]; auctionImpactK: number; auctionImpactCap: number };
  auth: { initialCash: number; sessionDays: number; ipRegPerDay: number;
    loginLockN: number; loginLockMin: number };
  credit: { min: number; max: number; start: number; repayOnTime: number; repayEarly: number;
    overduePerDay: number; forcedLiq: number; bankruptcyScore: number;
    shiftPoint: number; shiftCapPer20d: number };
  loans: { termDays: [number, number, number]; graceDays: number; penaltyMult: number;
    liqOverdueDay: number; leverageDivisor: number; reliefCash: number;
    /** 授信额度 = 信誉分 × 本值（**分**）。默认 500_000 分 = ¥5,000/分，
     *  即「个人信誉分 × 5000 元」（信誉 600 → ¥3,000,000）。 */
    capPerCreditPoint: number;
    /** [minScore, 日息 e6]，minScore 降序。<500 拒贷。
     *  ⚠️ 额度**不在这里**——它是 `capPerCreditPoint` 算出的公式，本表只决定日息。 */
    tiers: [number, number][] };
  /**
   * 玩家间借贷（P2P）。与 NPC 银行贷款的差别：放款是真金白银从出借方划出，
   * 故没有"授信额度"概念，只有出借方可用现金与单笔上限。
   */
  p2p: {
    /** 单笔本金上限（分）。防手滑输错 0 的数量级。 */
    maxPrincipal: number;
    /** 协商利率的合法区间（分子/分母表示的百分比倍数）。
     *  minRateMult=1.0 表示最低「零息」（还本即可）；maxRateMult=2.0 表示最高「还本+100% 利息」。
     *  上下限拦住「手滑多打一个 0」这类不可执行的条款。 */
    minRateMult: number;
    maxRateMult: number;
    /** 还款周期（自然日）合法区间。 */
    minTermDays: number;
    maxTermDays: number;
    /** 逾期宽限天数（与 NPC 贷款同口径）。 */
    graceDays: number;
    /** 逾期罚息的额外倍率（在约定利率基础上）。 */
    penaltyMult: number;
    /** 逾期每日信誉扣分（对借款人）。 */
    overduePerDay: number;
    /** 按期/提前还清的信誉奖励（对借款人）。 */
    repayOnTime: number;
    repayEarly: number;
    /** 被打回/拒绝是否扣信誉：不扣（协商失败属正常行为，不应惩罚）。 */
  };
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
  playerImpactLambda: 8,
  playerImpactCap: 0.05,
  poolTarget: 48,
  poolMax: 50,
  backupKeep: 7,
  // auctionImpactK 与 playerImpactLambda 同步提高：集合竞价同样是「玩家净需求 vs 单 tick 均量」，
  // 玩家稀疏时 K=0.8 会让竞价失衡在取整后归零。cap 从 3% 放到 5%（仍低于涨跌停）。
  trading: { marketBufferPct: 0.02, slippageK: 0.06, boardFillProb: 0.25, boardFillRatio: [0.1, 0.5],
    auctionImpactK: 8, auctionImpactCap: 0.05 },
  auth: { initialCash: 100_000_000, sessionDays: 30, ipRegPerDay: 20, loginLockN: 5, loginLockMin: 15 },
  credit: { min: 350, max: 850, start: 600, repayOnTime: 15, repayEarly: 20, overduePerDay: -8,
    forcedLiq: -80, bankruptcyScore: 400, shiftPoint: 1, shiftCapPer20d: 10 },
  loans: { termDays: [20, 60, 120], graceDays: 3, penaltyMult: 2, liqOverdueDay: 10,
    leverageDivisor: 300, reliefCash: 2_000_000,
    capPerCreditPoint: 500_000,   // 授信额度 = 信誉分 × ¥5,000（600 分 → ¥3,000,000）
    tiers: [ // <500 拒贷；取首个 minScore≤分数 的档。只决定日息，额度由上面那条公式算
      [850, 300], [800, 320], [750, 350],
      [700, 400], [650, 450], [600, 500],
      [550, 550], [500, 600],
    ] },
  p2p: {
    maxPrincipal: 500_000_000,   // 单笔上限 ¥5,000,000
    minRateMult: 1.0,            // 最低零息（还本即可）
    maxRateMult: 2.0,            // 最高还本 + 100% 利息
    minTermDays: 1,
    maxTermDays: 120,
    graceDays: 3,
    penaltyMult: 2,
    overduePerDay: -8,
    repayOnTime: 15,
    repayEarly: 20,
  },
  work: { wageBonusPerPoint: 0.05, shiftsPerDay: 2, shiftGameHours: 8,
    coursePriceBase: 500_000, coursePriceMult: 1.6, courseHoursPerLevel: 8, maxLevel: 10,
    // base×1.6^n 逐级四舍五入到分的定值表（字面量为准）
    coursePrices: [500_000, 800_000, 1_280_000, 2_048_000, 3_276_800,
      5_242_880, 8_388_608, 13_421_773, 21_474_836, 34_359_738] },
};
