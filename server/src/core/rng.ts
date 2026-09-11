function splitmix32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15); t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0); };
}
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export class Rng {
  private constructor(private s0: number, private s1: number, private s2: number, private s3: number) {}
  static fromSeed(masterSeed: number, day: number, stream: string): Rng {
    const mix = splitmix32((masterSeed ^ Math.imul(day, 0x9e3779b1) ^ fnv1a(stream)) | 0);
    let a = mix(), b = mix(), c = mix(), d = mix();
    if ((a | b | c | d) === 0) a = 1;
    return new Rng(a, b, c, d);
  }
  private nextU32(): number { // xoshiro128**：rotl(s1*5, 7) * 9
    const s1x5 = (this.s1 * 5) | 0;
    const rot = ((s1x5 << 7) | (s1x5 >>> 25)) | 0;
    const result = Math.imul(rot, 9) >>> 0;
    const t = (this.s1 << 9) | 0;
    this.s2 ^= this.s0; this.s3 ^= this.s1; this.s1 ^= this.s2; this.s0 ^= this.s3; this.s2 ^= t;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) | 0;
    return result;
  }
  next(): number { return this.nextU32() / 4294967296; }
  normal(): number {
    const u1 = Math.max(this.next(), 1e-12), u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  studentT4(): number {
    const z = this.normal();
    const e = -Math.log(Math.max(this.next(), 1e-12)) - Math.log(Math.max(this.next(), 1e-12));
    return z / Math.sqrt((2 * e) / 4); // chi2_4 = 2·(Exp1+Exp1)
  }
  int(maxExclusive: number): number { return Math.floor(this.next() * maxExclusive); }
  pick<T>(arr: readonly T[]): T {
    const v = arr[this.int(arr.length)];
    if (v === undefined) throw new Error('pick from empty');
    return v;
  }
  poisson(lambda: number): number {
    const L = Math.exp(-lambda); let k = 0, p = 1;
    do { k++; p *= this.next(); } while (p > L);
    return k - 1;
  }
  serialize(): string { return JSON.stringify([this.s0, this.s1, this.s2, this.s3]); }
  static restore(s: string): Rng {
    const [a, b, c, d] = JSON.parse(s) as number[];
    return new Rng(a!, b!, c!, d!);
  }
}
