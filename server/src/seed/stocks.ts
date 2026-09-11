import type { Cents } from '../core/money.js';
import type { DB } from '../db/database.js';
import { DEFAULTS } from '../config/defaults.js';
import { limitPrices } from '../engine/limits.js';

export interface StockSeed { code: string; name: string; board: 'SH' | 'SZ' | 'CY'; sector: string;
  price0: Cents; sharesE8: number /*亿股*/; volTier: 'L' | 'M' | 'H'; beta: number; payout: 'H' | 'M' | 'L' | 'N'; }

// 规格附录 A 全表逐行转录（48 行）
export const STOCK_SEEDS: StockSeed[] = [
  { code: '600619', name: '黔台酒业', board: 'SH', sector: '白酒饮料', price0: 158_000, sharesE8: 12.5, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '600859', name: '川酿窖藏', board: 'SH', sector: '白酒饮料', price0: 14_800, sharesE8: 38, volTier: 'M', beta: 0.9, payout: 'H' },
  { code: '002331', name: '快乐水业', board: 'SZ', sector: '白酒饮料', price0: 1_800, sharesE8: 96, volTier: 'L', beta: 0.8, payout: 'H' },
  { code: '601389', name: '环宇银行', board: 'SH', sector: '银行', price0: 520, sharesE8: 1500, volTier: 'L', beta: 0.6, payout: 'H' },
  { code: '600037', name: '招云银行', board: 'SH', sector: '银行', price0: 3_800, sharesE8: 250, volTier: 'L', beta: 0.8, payout: 'H' },
  { code: '002143', name: '城郊银行', board: 'SZ', sector: '银行', price0: 460, sharesE8: 180, volTier: 'L', beta: 0.6, payout: 'H' },
  { code: '601692', name: '华鑫证券', board: 'SH', sector: '券商保险', price0: 1_400, sharesE8: 90, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '600912', name: '中州证券', board: 'SH', sector: '券商保险', price0: 980, sharesE8: 110, volTier: 'H', beta: 1.5, payout: 'L' },
  { code: '601329', name: '安泰保险', board: 'SH', sector: '券商保险', price0: 4_200, sharesE8: 180, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '601629', name: '长青人寿', board: 'SH', sector: '券商保险', price0: 2_800, sharesE8: 280, volTier: 'L', beta: 0.9, payout: 'M' },
  { code: '600277', name: '恒润医药', board: 'SH', sector: '医药生物', price0: 4_600, sharesE8: 64, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '600086', name: '仁和堂药业', board: 'SH', sector: '医药生物', price0: 2_300, sharesE8: 40, volTier: 'M', beta: 0.9, payout: 'M' },
  { code: '000539', name: '云山药业', board: 'SZ', sector: '医药生物', price0: 1_500, sharesE8: 52, volTier: 'M', beta: 0.9, payout: 'M' },
  { code: '300761', name: '基因谷生物', board: 'CY', sector: '医药生物', price0: 8_800, sharesE8: 4, volTier: 'H', beta: 1.5, payout: 'N' },
  { code: '300757', name: '宁德年代', board: 'CY', sector: '新能源电池', price0: 18_500, sharesE8: 44, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '002595', name: '比迪亚汽车', board: 'SZ', sector: '新能源电池', price0: 24_000, sharesE8: 29, volTier: 'H', beta: 1.2, payout: 'L' },
  { code: '601913', name: '朗基光能', board: 'SH', sector: '光伏', price0: 1_900, sharesE8: 75, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '002599', name: '天合日新', board: 'SZ', sector: '光伏', price0: 2_600, sharesE8: 22, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '000688', name: '兆芯半导', board: 'SZ', sector: '半导体', price0: 6_800, sharesE8: 13, volTier: 'H', beta: 1.5, payout: 'L' },
  { code: '300688', name: '中芯微电', board: 'CY', sector: '半导体', price0: 12_000, sharesE8: 8, volTier: 'H', beta: 1.6, payout: 'N' },
  { code: '300786', name: '晶圆先锋', board: 'CY', sector: '半导体', price0: 15_600, sharesE8: 5, volTier: 'H', beta: 1.6, payout: 'N' },
  { code: '002476', name: '立讯精工', board: 'SZ', sector: '消费电子', price0: 3_300, sharesE8: 71, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '002242', name: '歌声电子', board: 'SZ', sector: '消费电子', price0: 2_700, sharesE8: 34, volTier: 'M', beta: 1.2, payout: 'M' },
  { code: '600589', name: '金码软件', board: 'SH', sector: '软件互联网', price0: 3_100, sharesE8: 44, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '000454', name: '云智科技', board: 'SZ', sector: '软件互联网', price0: 1_300, sharesE8: 27, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '300060', name: '东方财讯', board: 'CY', sector: '软件互联网', price0: 1_700, sharesE8: 130, volTier: 'H', beta: 1.7, payout: 'L' },
  { code: '000334', name: '美好电器', board: 'SZ', sector: '家电', price0: 5_400, sharesE8: 70, volTier: 'L', beta: 0.9, payout: 'H' },
  { code: '000652', name: '格立电器', board: 'SZ', sector: '家电', price0: 3_600, sharesE8: 56, volTier: 'L', beta: 0.8, payout: 'H' },
  { code: '600105', name: '申汽集团', board: 'SH', sector: '汽车', price0: 1_500, sharesE8: 116, volTier: 'M', beta: 0.9, payout: 'H' },
  { code: '601634', name: '长垣汽车', board: 'SH', sector: '汽车', price0: 2_400, sharesE8: 85, volTier: 'M', beta: 1.1, payout: 'M' },
  { code: '600051', name: '宝立地产', board: 'SH', sector: '地产', price0: 420, sharesE8: 119, volTier: 'H', beta: 1.1, payout: 'M' },
  { code: '000003', name: '万嘉置业', board: 'SZ', sector: '地产', price0: 880, sharesE8: 97, volTier: 'H', beta: 1.2, payout: 'M' },
  { code: '601801', name: '交建集团', board: 'SH', sector: '基建', price0: 780, sharesE8: 162, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '601671', name: '华夏建工', board: 'SH', sector: '基建', price0: 560, sharesE8: 410, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '600020', name: '宝坚钢铁', board: 'SH', sector: '钢铁煤炭', price0: 610, sharesE8: 220, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '601089', name: '神岳能源', board: 'SH', sector: '钢铁煤炭', price0: 2_800, sharesE8: 199, volTier: 'M', beta: 0.8, payout: 'H' },
  { code: '601859', name: '昆仑石化', board: 'SH', sector: '石油化工', price0: 890, sharesE8: 1830, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '002494', name: '荣昌石化', board: 'SZ', sector: '石油化工', price0: 1_100, sharesE8: 101, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '601920', name: '远航海运', board: 'SH', sector: '航运物流', price0: 1_200, sharesE8: 160, volTier: 'H', beta: 1.2, payout: 'L' },
  { code: '002353', name: '顺达快运', board: 'SZ', sector: '航运物流', price0: 4_500, sharesE8: 49, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '600761', name: '航翼军工', board: 'SH', sector: '军工', price0: 5_200, sharesE8: 28, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '002152', name: '北辰导航', board: 'SZ', sector: '军工', price0: 2_900, sharesE8: 25, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '002715', name: '牧沅农牧', board: 'SZ', sector: '农牧食品', price0: 4_100, sharesE8: 55, volTier: 'H', beta: 1.1, payout: 'L' },
  { code: '603289', name: '海之味食品', board: 'SH', sector: '农牧食品', price0: 7_800, sharesE8: 46, volTier: 'L', beta: 0.8, payout: 'H' },
  { code: '601112', name: '国翔航空', board: 'SH', sector: '航空旅游', price0: 740, sharesE8: 145, volTier: 'M', beta: 1.1, payout: 'L' },
  { code: '601889', name: '环球免税', board: 'SH', sector: '航空旅游', price0: 9_600, sharesE8: 21, volTier: 'H', beta: 1.2, payout: 'M' },
  { code: '002556', name: '三六互娱', board: 'SZ', sector: '传媒游戏', price0: 2_100, sharesE8: 22, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '300414', name: '星芒传媒', board: 'CY', sector: '传媒游戏', price0: 3_200, sharesE8: 19, volTier: 'H', beta: 1.5, payout: 'N' },
];

export const SPARE_NAMES: Record<string, string[]> = {
  '白酒饮料': ['晋窖酒业', '甘泉饮品'], '银行': ['汇通银行', '锦城银行'],
  '券商保险': ['东部证券', '瑞和保险'], '医药生物': ['康柏制药', '泰生生物'],
  '新能源电池': ['星辰电池', '聚能新能'], '光伏': ['晴川光伏', '曜阳能源'],
  '半导体': ['芯河科技', '微纳电子'], '消费电子': ['声达电子', '慧屏科技'],
  '软件互联网': ['码上科技', '云帆网络'], '家电': ['凉夏电器', '洁风家电'],
  '汽车': ['骏驰汽车', '峰行汽车'], '地产': ['安居置业', '曜城地产'],
  '基建': ['路桥建设', '巨匠工程'], '钢铁煤炭': ['铁流集团', '黑金能源'],
  '石油化工': ['海油石化', '巨烷化工'], '航运物流': ['蓝鲸航运', '迅达物流'],
  '军工': ['天盾军工', '烈焰动力'], '农牧食品': ['丰穗农业', '鲜禾食品'],
  '航空旅游': ['云翼航空', '四海旅业'], '传媒游戏': ['幻境游戏', '光影传媒'],
};

export function seedStocks(db: DB, day: number): void {
  const insS = db.prepare(`INSERT INTO stocks(code,name,board,sector,shares_total,vol_tier,beta,payout_tier,listed_day)
    VALUES (@code,@name,@board,@sector,@shares,@volTier,@beta,@payout,@day)`);
  const insT = db.prepare(`INSERT INTO stock_state(code,price,prev_close,limit_up,limit_down,eps_e6,pe,equity_e6,adv)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const PE0 = { L: 18, M: 28, H: 45 } as const;
  db.transaction(() => {
    for (const s of STOCK_SEEDS) {
      const shares = Math.round(s.sharesE8 * 1e8);
      insS.run({ code: s.code, name: s.name, board: s.board, sector: s.sector, shares, volTier: s.volTier, beta: s.beta, payout: s.payout, day });
      const { up, down } = limitPrices(s.price0, s.board === 'CY' ? 'CY' : s.board, DEFAULTS);
      const pe = PE0[s.volTier];
      const eps = Math.round((s.price0 / 100) / pe * 1e6);
      insT.run(s.code, s.price0, s.price0, up, down, eps, pe, eps * 8, Math.round(shares * 0.005));
    }
  })();
}
