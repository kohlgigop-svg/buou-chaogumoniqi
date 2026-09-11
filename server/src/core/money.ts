export type Cents = number;
export function assertCents(v: number): void {
  if (!Number.isSafeInteger(v)) throw new Error(`not integer cents: ${v}`);
}
export function roundHalfUpDiv(n: number, d: number): Cents {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad dividend: ${n}`);
  if (d <= 0) throw new Error('bad divisor');
  const q = Math.floor(n / d), r = n - q * d;
  return r * 2 >= d ? q + 1 : q;
}
function assertNonNegative(amount: Cents): void {
  if (amount < 0) throw new Error(`negative amount: ${amount}`);
}
const MIN_COMMISSION = 500;
export function commission(amount: Cents): Cents {
  assertCents(amount);
  assertNonNegative(amount);
  return Math.max(MIN_COMMISSION, roundHalfUpDiv(amount * 25, 100_000)); // 万2.5
}
export function stampTax(amount: Cents): Cents { assertCents(amount); assertNonNegative(amount); return roundHalfUpDiv(amount * 5, 10_000); }   // 0.05%
export function transferFee(amount: Cents): Cents { assertCents(amount); assertNonNegative(amount); return roundHalfUpDiv(amount, 100_000); }   // 万0.1
export function dividendTax(amount: Cents): Cents { assertCents(amount); assertNonNegative(amount); return roundHalfUpDiv(amount, 10); }        // 10%
