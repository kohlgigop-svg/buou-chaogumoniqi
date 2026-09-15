import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/database.js';
import { Engine } from '../../src/engine/engine.js';
import type { TickCtx } from '../../src/engine/types.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { TICKS_PER_DAY, TICK_MS } from '../../src/core/clock.js';
import { seedStocks } from '../../src/seed/stocks.js';
import { evolveAnchorDaily } from '../../src/engine/anchor.js';
import { Rng } from '../../src/core/rng.js';

const G = 1_700_000_000_000;
function mk(db = openDb(':memory:')) {
  return { db, eng: new Engine({ db, cfg: DEFAULTS, masterSeed: 20260828, genesisMs: G }) };
}
// 长补跑按“日”分块并让出事件循环：单次同步 catchUpTo 可阻塞数十秒，
// 会饿死 vitest worker↔host 的 RPC ack（60s 硬窗口），偶发 "Timeout calling onTaskUpdate"。
async function catchUpChunked(eng: Engine, genesisMs: number, days: number): Promise<void> {
  for (let d = 1; d <= days; d++) {
    eng.catchUpTo(genesisMs + d * 3_600_000);
    await new Promise<void>(r => setImmediate(r)); // yield so vitest RPC acks can flow
  }
}
describe('engine', () => {
  it('快进 5 日：日K/财报/事件按预期出现', async () => {
    const { db, eng } = mk();
    await catchUpChunked(eng, G, 5);
    expect((db.prepare('SELECT MAX(day) d FROM candles_day').get() as any).d).toBe(5);
    expect((db.prepare('SELECT COUNT(*) c FROM candles_day WHERE code=\'IDX:COMP\'').get() as any).c).toBe(5);
    expect((db.prepare('SELECT COUNT(*) c FROM news').get() as any).c).toBeGreaterThan(0);
    const px = db.prepare('SELECT price p FROM stock_state').all() as any[];
    for (const r of px) expect(r.p).toBeGreaterThan(0);
  }, 60_000); // 本机 vitest 下 ~4-8s，默认 5s 超时不稳，放宽（断言未变）
  it('补跑一致性：连续 vs 中断重启，状态逐字段一致', async () => {
    const a = mk();
    await catchUpChunked(a.eng, G, 4);
    a.eng.catchUpTo(G + 4 * 3_600_000 + 1234 * TICK_MS); // 末段不足一日，内联（目标时刻不变，确定性由断言保证）
    const b = mk();
    await catchUpChunked(b.eng, G, 2);
    b.eng.catchUpTo(G + 2 * 3_600_000 + 77 * TICK_MS);
    const b2 = new Engine({ db: b.db, cfg: DEFAULTS, masterSeed: 20260828, genesisMs: G }); // 重启：从 engine_state 恢复
    b2.catchUpTo(G + 3 * 3_600_000);
    await new Promise<void>(r => setImmediate(r)); // yield so vitest RPC acks can flow
    b2.catchUpTo(G + 4 * 3_600_000 + 1234 * TICK_MS);
    const dump = (db: any) => ({
      st: db.prepare('SELECT code,price,prev_close,limit_up,limit_down,eps_e6,volume FROM stock_state ORDER BY code').all(),
      cd: db.prepare('SELECT * FROM candles_day ORDER BY code,day').all(),
      nw: db.prepare('SELECT day,tick,scope,target,type_id,impact_e6 FROM news ORDER BY id').all(),
      es: db.prepare('SELECT last_tick FROM engine_state').get() });
    expect(dump(b.db)).toEqual(dump(a.db));
  }, 120_000); // 共 ~12k tick，本机 vitest 下 8-12s，默认 5s 必超时，放宽（断言未变）
  it('30 日长跑：不变量与生命周期', async () => {
    const { db, eng } = mk();
    await catchUpChunked(eng, G, 30);
    // 110 股 / 60 日报告周期，offset=fnv1a(code)%60 实测分布 → 30 日恰 51 份。
    // 这是**观测回填**的确定性值（不是范围）：市场扩容会改变它，那是本断言在提醒你
    // 「股票池变了，确认一下报告分布仍符合预期」，而不是让你把它放宽成区间。
    expect((db.prepare('SELECT COUNT(*) c FROM reports').get() as any).c).toBe(51);
    expect((db.prepare('SELECT COALESCE(SUM(amount),0) s FROM ledger').get() as any).s).toBe(0);
    expect((db.prepare('SELECT COUNT(DISTINCT day) c FROM ticks').get() as any).c).toBeLessThanOrEqual(3);
  }, 120_000);
  it('实时模式 start/stop 不抛错', async () => {
    const { eng } = mk(); eng.start(); await new Promise(r => setTimeout(r, 50)); eng.stop();
  });
  it('onTick 回调收到惰性 TickCtx（仅 live 模式触发）', async () => {
    const db = openDb(':memory:');
    // genesis 落后 10 tick（远小于一日，备份/抑制无关）：首次 interval 触发即补跑 tick 0..10
    const eng = new Engine({ db, cfg: DEFAULTS, masterSeed: 20260828, genesisMs: Date.now() - 10 * TICK_MS });
    const ctxs: TickCtx[] = [];
    const off = eng.onTick(ctx => { ctxs.push(ctx); });
    eng.start();
    await new Promise(r => setTimeout(r, 1300));
    eng.stop(); off();
    expect(ctxs.length).toBeGreaterThanOrEqual(1);
    const first = ctxs[0]!;
    expect(first.day).toBe(1);
    expect(first.tickInDay).toBe(0);
    expect(first.phase).toBe('auction_open');
    expect(first.quotes instanceof Map).toBe(true); // 惰性 getter 必须可用
    db.close(); // 显式关闭：避免 worker 退出时原生句柄在活动定时器语境下被终结（Windows 0xC0000005）
  }, 10_000);
  it('evolveAnchorDaily 确定性：两库同流同结果', () => {
    const mkDb = () => { const db = openDb(':memory:'); seedStocks(db, 1); return db; };
    const d1 = mkDb(); const d2 = mkDb();
    const anchors = (db: any) => {
      const codes = (db.prepare('SELECT code FROM stocks ORDER BY code').all() as { code: string }[]).map(r => r.code);
      const rng = Rng.fromSeed(1, 2, 'anchor');
      for (const code of codes) evolveAnchorDaily(db, code, rng, DEFAULTS);
      return db.prepare('SELECT code, eps_e6, pe FROM stock_state ORDER BY code').all();
    };
    expect(anchors(d1)).toEqual(anchors(d2));
  });
});
