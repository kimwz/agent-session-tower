/**
 * Order keys that sort as plain strings: a key can always be made between two others, so moving one item changes one
 * row. Digits are base 62 in ASCII order; a key never ends in the lowest digit, which keeps a key below any key.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

export const validSortKey = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && KEY.test(value);

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let common = 0;
    while ((a[common] ?? DIGITS[0]) === b[common]) common++;
    if (common > 0) return b.slice(0, common) + midpoint(a.slice(common), b.slice(common));
  }
  const low = a ? DIGITS.indexOf(a[0]) : 0;
  const high = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[low] + midpoint(a.slice(1), null);
}

/** A key after `before` and before `after`; null means "the start" and "the end". */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && !validSortKey(before)) throw new Error(`Invalid order key ${before}`);
  if (after !== null && !validSortKey(after)) throw new Error(`Invalid order key ${after}`);
  if (before !== null && after !== null && before >= after) throw new Error(`Order keys out of order: ${before} ≥ ${after}`);
  return midpoint(before ?? '', after);
}
