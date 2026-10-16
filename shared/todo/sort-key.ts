/**
 * Order keys that sort as plain strings: a key can always be made between two others, so moving one item changes one
 * row. Digits are base 62 in ASCII order; a key never ends in the lowest digit, which keeps a key below any key.
 * Adding at either end steps one digit instead of halving the gap, so keys stay short; when inserting again and again at
 * one place makes a key longer than `SORT_KEY_SPREAD_AT`, the owner of the list spreads its keys out again.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
export const SORT_KEY_SPREAD_AT = 24;

export const validSortKey = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && KEY.test(value);

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
  if (before !== null && after === null) {
    // The first digit that can grow, grown, with what follows it dropped: still above `before`, and short.
    const index = [...before].findIndex(digit => digit !== 'z');
    // When every digit is the highest, one more digit starts its count from the bottom.
    return index >= 0 ? before.slice(0, index) + DIGITS[DIGITS.indexOf(before[index]) + 1] : `${before}1`;
  }
  if (before === null && after !== null) {
    const index = [...after].findIndex(digit => DIGITS.indexOf(digit) > 1);
    if (index >= 0) return after.slice(0, index) + DIGITS[DIGITS.indexOf(after[index]) - 1];
  }
  return midpoint(before ?? '', after);
}

/** `count` evenly spaced keys of one width, in order, for a list whose keys have grown long. */
export function spreadKeys(count: number): string[] {
  let width = 1;
  while (62 ** width <= count + 1) width++;
  const step = Math.floor(62 ** width / (count + 1));
  return Array.from({ length: count }, (_, index) => {
    let value = (index + 1) * step, text = '';
    for (let digit = 0; digit < width; digit++) { text = DIGITS[value % 62] + text; value = Math.floor(value / 62); }
    // A fixed-width number followed by a middle digit never ends in the lowest digit and keeps the order.
    return `${text}V`;
  });
}
