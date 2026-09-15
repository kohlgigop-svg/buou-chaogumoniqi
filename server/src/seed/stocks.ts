import type { Cents } from '../core/money.js';
import type { DB } from '../db/database.js';
import { DEFAULTS } from '../config/defaults.js';
import { limitPrices } from '../engine/limits.js';

export interface StockSeed { code: string; name: string; board: 'SH' | 'SZ' | 'CY'; sector: string;
  price0: Cents; sharesE8: number /*亿股*/; volTier: 'L' | 'M' | 'H'; beta: number; payout: 'H' | 'M' | 'L' | 'N'; }

/**
 * 全市场种子表（110 行 / 20 板块）。
 *
 * ⚠️ **名字全部是虚构的**，且**不得与 `SPARE_NAMES` 的任何取值重名** ——
 * IPO 补位会用 spare 名字建新股（`stocks.name` 有 UNIQUE），重名会让补位抛错。
 * 加行时请顺带 `grep` 一遍两个列表。
 *
 * ⚠️ 扩容不是「改大这个数组」就完事：老库（线上）已经有 48 只，
 * 靠 `ensureStockSeeds()` 幂等补齐，并且**必须修正指数除数**，否则点位会跳 ——
 * `mcapOf('COMP')` 是全市场市值之和，多 62 只股会把指数从 2600 点顶到 8000 点。
 */
export const STOCK_SEEDS: StockSeed[] = [
  // —— 白酒饮料（5）——
  { code: '600619', name: '黔台酒业', board: 'SH', sector: '白酒饮料', price0: 158_000, sharesE8: 12.5, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '600859', name: '川酿窖藏', board: 'SH', sector: '白酒饮料', price0: 14_800, sharesE8: 38, volTier: 'M', beta: 0.9, payout: 'H' },
  { code: '002331', name: '快乐水业', board: 'SZ', sector: '白酒饮料', price0: 1_800, sharesE8: 96, volTier: 'L', beta: 0.8, payout: 'H' },
  { code: '600809', name: '汾源酒业', board: 'SH', sector: '白酒饮料', price0: 68_000, sharesE8: 8.6, volTier: 'L', beta: 0.8, payout: 'H' },
  { code: '000858', name: '蜀香春酿', board: 'SZ', sector: '白酒饮料', price0: 22_400, sharesE8: 18, volTier: 'L', beta: 0.9, payout: 'H' },
  { code: '600559', name: '燕赵老窖', board: 'SH', sector: '白酒饮料', price0: 9_600, sharesE8: 26, volTier: 'M', beta: 1.0, payout: 'M' },
  // —— 银行（6）——
  { code: '601389', name: '环宇银行', board: 'SH', sector: '银行', price0: 520, sharesE8: 1500, volTier: 'L', beta: 0.6, payout: 'H' },
  { code: '600037', name: '招云银行', board: 'SH', sector: '银行', price0: 3_800, sharesE8: 250, volTier: 'L', beta: 0.8, payout: 'H' },
  { code: '002143', name: '城郊银行', board: 'SZ', sector: '银行', price0: 460, sharesE8: 180, volTier: 'L', beta: 0.6, payout: 'H' },
  { code: '601288', name: '汇农银行', board: 'SH', sector: '银行', price0: 380, sharesE8: 3200, volTier: 'L', beta: 0.5, payout: 'H' },
  { code: '600926', name: '杭嘉银行', board: 'SH', sector: '银行', price0: 1_460, sharesE8: 62, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '002807', name: '江海农商', board: 'SZ', sector: '银行', price0: 620, sharesE8: 210, volTier: 'L', beta: 0.7, payout: 'H' },
  // —— 券商保险（6）——
  { code: '601692', name: '华鑫证券', board: 'SH', sector: '券商保险', price0: 1_400, sharesE8: 90, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '600912', name: '中州证券', board: 'SH', sector: '券商保险', price0: 980, sharesE8: 110, volTier: 'H', beta: 1.5, payout: 'L' },
  { code: '601329', name: '安泰保险', board: 'SH', sector: '券商保险', price0: 4_200, sharesE8: 180, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '601629', name: '长青人寿', board: 'SH', sector: '券商保险', price0: 2_800, sharesE8: 280, volTier: 'L', beta: 0.9, payout: 'M' },
  { code: '600030', name: '华元证券', board: 'SH', sector: '券商保险', price0: 2_150, sharesE8: 148, volTier: 'H', beta: 1.5, payout: 'L' },
  { code: '601211', name: '泰安证券', board: 'SH', sector: '券商保险', price0: 1_680, sharesE8: 88, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '000728', name: '皖江证券', board: 'SZ', sector: '券商保险', price0: 760, sharesE8: 42, volTier: 'H', beta: 1.6, payout: 'L' },
  // —— 医药生物（6）——
  { code: '600277', name: '恒润医药', board: 'SH', sector: '医药生物', price0: 4_600, sharesE8: 64, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '600086', name: '仁和堂药业', board: 'SH', sector: '医药生物', price0: 2_300, sharesE8: 40, volTier: 'M', beta: 0.9, payout: 'M' },
  { code: '000539', name: '云山药业', board: 'SZ', sector: '医药生物', price0: 1_500, sharesE8: 52, volTier: 'M', beta: 0.9, payout: 'M' },
  { code: '300761', name: '基因谷生物', board: 'CY', sector: '医药生物', price0: 8_800, sharesE8: 4, volTier: 'H', beta: 1.5, payout: 'N' },
  { code: '600196', name: '复兴制药', board: 'SH', sector: '医药生物', price0: 2_640, sharesE8: 26, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '000963', name: '华安医药', board: 'SZ', sector: '医药生物', price0: 3_950, sharesE8: 17, volTier: 'M', beta: 0.9, payout: 'M' },
  { code: '300347', name: '泰恒生物', board: 'CY', sector: '医药生物', price0: 5_600, sharesE8: 6, volTier: 'H', beta: 1.4, payout: 'L' },
  // —— 新能源电池（5）——
  { code: '300757', name: '宁德年代', board: 'CY', sector: '新能源电池', price0: 18_500, sharesE8: 44, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '002595', name: '比迪亚汽车', board: 'SZ', sector: '新能源电池', price0: 24_000, sharesE8: 29, volTier: 'H', beta: 1.2, payout: 'L' },
  { code: '300750', name: '川流电池', board: 'CY', sector: '新能源电池', price0: 21_000, sharesE8: 23, volTier: 'H', beta: 1.5, payout: 'L' },
  { code: '002460', name: '力神新能', board: 'SZ', sector: '新能源电池', price0: 5_800, sharesE8: 12, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '600884', name: '沃特动力', board: 'SH', sector: '新能源电池', price0: 1_450, sharesE8: 20, volTier: 'H', beta: 1.3, payout: 'L' },
  // —— 光伏（6）——
  { code: '601913', name: '朗基光能', board: 'SH', sector: '光伏', price0: 1_900, sharesE8: 75, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '002599', name: '天合日新', board: 'SZ', sector: '光伏', price0: 2_600, sharesE8: 22, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '601012', name: '旭日光伏', board: 'SH', sector: '光伏', price0: 2_050, sharesE8: 76, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '300274', name: '晶科阳光', board: 'CY', sector: '光伏', price0: 8_600, sharesE8: 15, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '002129', name: '天曜硅能', board: 'SZ', sector: '光伏', price0: 1_320, sharesE8: 40, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '600438', name: '通昱能源', board: 'SH', sector: '光伏', price0: 2_480, sharesE8: 45, volTier: 'M', beta: 1.2, payout: 'L' },
  // —— 半导体（6）——
  { code: '000688', name: '兆芯半导', board: 'SZ', sector: '半导体', price0: 6_800, sharesE8: 13, volTier: 'H', beta: 1.5, payout: 'L' },
  { code: '300688', name: '中芯微电', board: 'CY', sector: '半导体', price0: 12_000, sharesE8: 8, volTier: 'H', beta: 1.6, payout: 'N' },
  { code: '300786', name: '晶圆先锋', board: 'CY', sector: '半导体', price0: 15_600, sharesE8: 5, volTier: 'H', beta: 1.6, payout: 'N' },
  { code: '600584', name: '长鑫微电', board: 'SH', sector: '半导体', price0: 3_400, sharesE8: 18, volTier: 'H', beta: 1.5, payout: 'L' },
  { code: '002371', name: '华虹芯源', board: 'SZ', sector: '半导体', price0: 9_800, sharesE8: 5, volTier: 'H', beta: 1.6, payout: 'N' },
  { code: '300661', name: '芯原微科', board: 'CY', sector: '半导体', price0: 7_200, sharesE8: 4, volTier: 'H', beta: 1.7, payout: 'N' },
  // —— 消费电子（5）——
  { code: '002476', name: '立讯精工', board: 'SZ', sector: '消费电子', price0: 3_300, sharesE8: 71, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '002242', name: '歌声电子', board: 'SZ', sector: '消费电子', price0: 2_700, sharesE8: 34, volTier: 'M', beta: 1.2, payout: 'M' },
  { code: '002475', name: '歌莱声科', board: 'SZ', sector: '消费电子', price0: 3_850, sharesE8: 68, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '300433', name: '立景光学', board: 'CY', sector: '消费电子', price0: 1_960, sharesE8: 49, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '600745', name: '闻泰智造', board: 'SH', sector: '消费电子', price0: 4_200, sharesE8: 12, volTier: 'H', beta: 1.4, payout: 'L' },
  // —— 软件互联网（6）——
  { code: '600589', name: '金码软件', board: 'SH', sector: '软件互联网', price0: 3_100, sharesE8: 44, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '000454', name: '云智科技', board: 'SZ', sector: '软件互联网', price0: 1_300, sharesE8: 27, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '300060', name: '东方财讯', board: 'CY', sector: '软件互联网', price0: 1_700, sharesE8: 130, volTier: 'H', beta: 1.7, payout: 'L' },
  { code: '600570', name: '弘图软件', board: 'SH', sector: '软件互联网', price0: 2_760, sharesE8: 21, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '300496', name: '天源数科', board: 'CY', sector: '软件互联网', price0: 5_400, sharesE8: 9, volTier: 'H', beta: 1.5, payout: 'N' },
  { code: '002230', name: '灵犀网络', board: 'SZ', sector: '软件互联网', price0: 4_650, sharesE8: 23, volTier: 'H', beta: 1.4, payout: 'L' },
  // —— 家电（5）——
  { code: '000334', name: '美好电器', board: 'SZ', sector: '家电', price0: 5_400, sharesE8: 70, volTier: 'L', beta: 0.9, payout: 'H' },
  { code: '000652', name: '格立电器', board: 'SZ', sector: '家电', price0: 3_600, sharesE8: 56, volTier: 'L', beta: 0.8, payout: 'H' },
  { code: '000333', name: '美澜电器', board: 'SZ', sector: '家电', price0: 6_800, sharesE8: 68, volTier: 'L', beta: 0.9, payout: 'H' },
  { code: '600690', name: '海纳智家', board: 'SH', sector: '家电', price0: 2_450, sharesE8: 94, volTier: 'L', beta: 0.8, payout: 'H' },
  { code: '002508', name: '火候厨电', board: 'SZ', sector: '家电', price0: 1_880, sharesE8: 9, volTier: 'M', beta: 1.0, payout: 'H' },
  // —— 汽车（5）——
  { code: '600105', name: '申汽集团', board: 'SH', sector: '汽车', price0: 1_500, sharesE8: 116, volTier: 'M', beta: 0.9, payout: 'H' },
  { code: '601634', name: '长垣汽车', board: 'SH', sector: '汽车', price0: 2_400, sharesE8: 85, volTier: 'M', beta: 1.1, payout: 'M' },
  { code: '600104', name: '沪汽集团', board: 'SH', sector: '汽车', price0: 1_720, sharesE8: 116, volTier: 'M', beta: 0.9, payout: 'H' },
  { code: '000625', name: '渝安汽车', board: 'SZ', sector: '汽车', price0: 1_340, sharesE8: 99, volTier: 'M', beta: 1.1, payout: 'M' },
  { code: '601633', name: '泰岳汽车', board: 'SH', sector: '汽车', price0: 2_950, sharesE8: 86, volTier: 'M', beta: 1.1, payout: 'M' },
  // —— 地产（5）——
  { code: '600051', name: '宝立地产', board: 'SH', sector: '地产', price0: 420, sharesE8: 119, volTier: 'H', beta: 1.1, payout: 'M' },
  { code: '000003', name: '万嘉置业', board: 'SZ', sector: '地产', price0: 880, sharesE8: 97, volTier: 'H', beta: 1.2, payout: 'M' },
  { code: '001979', name: '招盛置业', board: 'SZ', sector: '地产', price0: 1_050, sharesE8: 90, volTier: 'H', beta: 1.1, payout: 'M' },
  { code: '600048', name: '保盛地产', board: 'SH', sector: '地产', price0: 980, sharesE8: 119, volTier: 'H', beta: 1.0, payout: 'M' },
  { code: '000002', name: '金穗地产', board: 'SZ', sector: '地产', price0: 760, sharesE8: 118, volTier: 'H', beta: 1.1, payout: 'M' },
  // —— 基建（5）——
  { code: '601801', name: '交建集团', board: 'SH', sector: '基建', price0: 780, sharesE8: 162, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '601671', name: '华夏建工', board: 'SH', sector: '基建', price0: 560, sharesE8: 410, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '601668', name: '中建铁工', board: 'SH', sector: '基建', price0: 590, sharesE8: 418, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '601186', name: '中交路桥', board: 'SH', sector: '基建', price0: 810, sharesE8: 145, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '600170', name: '国水建设', board: 'SH', sector: '基建', price0: 340, sharesE8: 96, volTier: 'M', beta: 0.9, payout: 'M' },
  // —— 钢铁煤炭（5）——
  { code: '600020', name: '宝坚钢铁', board: 'SH', sector: '钢铁煤炭', price0: 610, sharesE8: 220, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '601089', name: '神岳能源', board: 'SH', sector: '钢铁煤炭', price0: 2_800, sharesE8: 199, volTier: 'M', beta: 0.8, payout: 'H' },
  { code: '600019', name: '钢联集团', board: 'SH', sector: '钢铁煤炭', price0: 680, sharesE8: 221, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '601088', name: '中岳煤业', board: 'SH', sector: '钢铁煤炭', price0: 3_900, sharesE8: 198, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '000983', name: '鲁南矿业', board: 'SZ', sector: '钢铁煤炭', price0: 1_180, sharesE8: 39, volTier: 'M', beta: 1.0, payout: 'M' },
  // —— 石油化工（5）——
  { code: '601859', name: '昆仑石化', board: 'SH', sector: '石油化工', price0: 890, sharesE8: 1830, volTier: 'L', beta: 0.7, payout: 'H' },
  { code: '002494', name: '荣昌石化', board: 'SZ', sector: '石油化工', price0: 1_100, sharesE8: 101, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '600028', name: '华油化工', board: 'SH', sector: '石油化工', price0: 640, sharesE8: 1210, volTier: 'L', beta: 0.6, payout: 'H' },
  { code: '601857', name: '国油能源', board: 'SH', sector: '石油化工', price0: 1_020, sharesE8: 1830, volTier: 'L', beta: 0.6, payout: 'H' },
  { code: '000301', name: '泰兴化工', board: 'SZ', sector: '石油化工', price0: 1_540, sharesE8: 66, volTier: 'M', beta: 1.1, payout: 'L' },
  // —— 航运物流（5）——
  { code: '601920', name: '远航海运', board: 'SH', sector: '航运物流', price0: 1_200, sharesE8: 160, volTier: 'H', beta: 1.2, payout: 'L' },
  { code: '002353', name: '顺达快运', board: 'SZ', sector: '航运物流', price0: 4_500, sharesE8: 49, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '601919', name: '远洋控股', board: 'SH', sector: '航运物流', price0: 1_360, sharesE8: 160, volTier: 'H', beta: 1.2, payout: 'L' },
  { code: '600233', name: '丰驰速运', board: 'SH', sector: '航运物流', price0: 1_820, sharesE8: 49, volTier: 'M', beta: 1.0, payout: 'M' },
  { code: '002352', name: '通达速递', board: 'SZ', sector: '航运物流', price0: 4_050, sharesE8: 49, volTier: 'M', beta: 1.0, payout: 'M' },
  // —— 军工（5）——
  { code: '600761', name: '航翼军工', board: 'SH', sector: '军工', price0: 5_200, sharesE8: 28, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '002152', name: '北辰导航', board: 'SZ', sector: '军工', price0: 2_900, sharesE8: 25, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '600760', name: '沈航工业', board: 'SH', sector: '军工', price0: 4_300, sharesE8: 26, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '000768', name: '国舰重工', board: 'SZ', sector: '军工', price0: 2_760, sharesE8: 27, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '300699', name: '航骏动力', board: 'CY', sector: '军工', price0: 3_600, sharesE8: 9, volTier: 'H', beta: 1.5, payout: 'N' },
  // —— 农牧食品（5）——
  { code: '002715', name: '牧沅农牧', board: 'SZ', sector: '农牧食品', price0: 4_100, sharesE8: 55, volTier: 'H', beta: 1.1, payout: 'L' },
  { code: '603289', name: '海之味食品', board: 'SH', sector: '农牧食品', price0: 7_800, sharesE8: 46, volTier: 'L', beta: 0.8, payout: 'H' },
  { code: '000876', name: '新望农牧', board: 'SZ', sector: '农牧食品', price0: 1_480, sharesE8: 45, volTier: 'M', beta: 1.0, payout: 'L' },
  { code: '002714', name: '原野牧业', board: 'SZ', sector: '农牧食品', price0: 4_700, sharesE8: 52, volTier: 'H', beta: 1.1, payout: 'L' },
  { code: '600298', name: '海丰农牧', board: 'SH', sector: '农牧食品', price0: 3_950, sharesE8: 34, volTier: 'M', beta: 0.9, payout: 'M' },
  // —— 航空旅游（5）——
  { code: '601112', name: '国翔航空', board: 'SH', sector: '航空旅游', price0: 740, sharesE8: 145, volTier: 'M', beta: 1.1, payout: 'L' },
  { code: '601889', name: '环球免税', board: 'SH', sector: '航空旅游', price0: 9_600, sharesE8: 21, volTier: 'H', beta: 1.2, payout: 'M' },
  { code: '600029', name: '华翔航空', board: 'SH', sector: '航空旅游', price0: 680, sharesE8: 146, volTier: 'M', beta: 1.1, payout: 'L' },
  { code: '601021', name: '春晖航空', board: 'SH', sector: '航空旅游', price0: 5_200, sharesE8: 10, volTier: 'H', beta: 1.2, payout: 'L' },
  { code: '000796', name: '宋韵旅业', board: 'SZ', sector: '航空旅游', price0: 1_120, sharesE8: 21, volTier: 'H', beta: 1.3, payout: 'N' },
  // —— 传媒游戏（6）——
  { code: '002556', name: '三六互娱', board: 'SZ', sector: '传媒游戏', price0: 2_100, sharesE8: 22, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '300414', name: '星芒传媒', board: 'CY', sector: '传媒游戏', price0: 3_200, sharesE8: 19, volTier: 'H', beta: 1.5, payout: 'N' },
  { code: '002624', name: '四九互娱', board: 'SZ', sector: '传媒游戏', price0: 1_640, sharesE8: 22, volTier: 'H', beta: 1.4, payout: 'L' },
  { code: '300251', name: '完满世界', board: 'CY', sector: '传媒游戏', price0: 1_280, sharesE8: 19, volTier: 'H', beta: 1.5, payout: 'N' },
  { code: '600637', name: '光年传媒', board: 'SH', sector: '传媒游戏', price0: 860, sharesE8: 24, volTier: 'H', beta: 1.3, payout: 'L' },
  { code: '002027', name: '众联传媒', board: 'SZ', sector: '传媒游戏', price0: 720, sharesE8: 145, volTier: 'M', beta: 1.2, payout: 'M' },
];

/**
 * IPO 补位用的备用名（每板块 4 个，按顺序消耗）。
 *
 * ⚠️ **不得与 `STOCK_SEEDS` 的任何 name 重名** —— `stocks.name` 有 UNIQUE 约束，
 * IPO 建股时会直接抛错。加名字前 `grep` 两个列表。
 * 备用名耗尽后 `scheduleOne` 会回落成 `${sector}实业${code后3位}`（按代码唯一，安全）。
 */
export const SPARE_NAMES: Record<string, string[]> = {
  '白酒饮料': ['晋窖酒业', '甘泉饮品', '皖醉酒业', '岭南米酒'],
  '银行': ['汇通银行', '锦城银行', '湘江银行', '津门银行'],
  '券商保险': ['东部证券', '瑞和保险', '川渝证券', '恒安保险'],
  '医药生物': ['康柏制药', '泰生生物', '本草药业', '瑞康生物'],
  '新能源电池': ['星辰电池', '聚能新能', '固态新能', '极充科技'],
  '光伏': ['晴川光伏', '曜阳能源', '阳光晶硅', '蓝海光伏'],
  '半导体': ['芯河科技', '微纳电子', '光刻微电', '硅元芯片'],
  '消费电子': ['声达电子', '慧屏科技', '影音科技', '折叠视界'],
  '软件互联网': ['码上科技', '云帆网络', '智算云科', '星链数据'],
  '家电': ['凉夏电器', '洁风家电', '暖冬电器', '净界家电'],
  '汽车': ['骏驰汽车', '峰行汽车', '智驾出行', '氢驰汽车'],
  '地产': ['安居置业', '曜城地产', '广厦置业', '悦城地产'],
  '基建': ['路桥建设', '巨匠工程', '港湾工程', '岩土建设'],
  '钢铁煤炭': ['铁流集团', '黑金能源', '焦岭能源', '云顶矿业'],
  '石油化工': ['海油石化', '巨烷化工', '华鲁化工', '新岭燃气'],
  '航运物流': ['蓝鲸航运', '迅达物流', '环宇海运', '捷运物流'],
  '军工': ['天盾军工', '烈焰动力', '苍穹航天', '锐锋兵器'],
  '农牧食品': ['丰穗农业', '鲜禾食品', '沃野农业', '甘泉乳业'],
  '航空旅游': ['云翼航空', '四海旅业', '天路航空', '山水文旅'],
  '传媒游戏': ['幻境游戏', '光影传媒', '次元互娱', '星辉影业'],
};

const PE0 = { L: 18, M: 28, H: 45 } as const;

/** 插入单只种子（含 stock_state 派生字段）。`topup.ts` 也用它，故导出。 */
export function insertSeed(db: DB, s: StockSeed, day: number): void {
  const shares = Math.round(s.sharesE8 * 1e8);
  db.prepare(`INSERT INTO stocks(code,name,board,sector,shares_total,vol_tier,beta,payout_tier,listed_day)
    VALUES (@code,@name,@board,@sector,@shares,@volTier,@beta,@payout,@day)`)
    .run({ code: s.code, name: s.name, board: s.board, sector: s.sector, shares,
      volTier: s.volTier, beta: s.beta, payout: s.payout, day });
  const { up, down } = limitPrices(s.price0, s.board === 'CY' ? 'CY' : s.board, DEFAULTS);
  const pe = PE0[s.volTier];
  const eps = Math.round((s.price0 / 100) / pe * 1e6);
  db.prepare(`INSERT INTO stock_state(code,price,prev_close,limit_up,limit_down,eps_e6,pe,equity_e6,adv)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(s.code, s.price0, s.price0, up, down, eps, pe, eps * 8, Math.round(shares * 0.005));
}

/** 创世：全量写入种子（只在空库调用）。 */
export function seedStocks(db: DB, day: number): void {
  db.transaction(() => {
    for (const s of STOCK_SEEDS) insertSeed(db, s, day);
  })();
}
