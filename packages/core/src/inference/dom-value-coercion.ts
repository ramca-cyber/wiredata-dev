/**
 * Scraped-Cell Value Coercion
 *
 * DOM table/grid cells are always text — even a genuine integer arrives as
 * the string "1,425,423,212", never the number 1425423212. inferColumnType
 * (typing.ts) was built for JSON API responses where numbers already arrive
 * as native `number`; it deliberately never tries to parse a string as a
 * number, because for real API captures a string is often meant to stay one
 * (zip codes, phone numbers, IDs with leading zeros). Coercing there would
 * be wrong.
 *
 * This is the DOM-only counterpart: called exclusively from the DOM capture
 * adapter, on cell text that is unconditionally a rendering of something
 * else. It converts a scraped cell into a native number when — and only
 * when — that's a high-confidence, lossless reading; anything ambiguous
 * (currency symbols, percentages, placeholders, dates, an ID that merely
 * looks numeric) is left as the original string, to be classified VARCHAR
 * by the existing engine same as always.
 *
 * Deliberately NOT handled here (left as a documented follow-up, not a
 * silent guess): currency symbols, percentage semantics (does "+0.88%" mean
 * 0.88 or 0.0088?), and free-form date strings (DD/MM vs MM/DD is a
 * genuine ambiguity, not something to resolve with a guess).
 */

// U+2212 MINUS SIGN — used by some sites (e.g. Wikipedia) instead of the
// ASCII hyphen for negative numbers.
const UNICODE_MINUS_REGEX = /−/g;

const PLAIN_NUMBER_REGEX = /^[+-]?\d+(\.\d+)?$/;
const THOUSANDS_GROUPED_REGEX = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;

/**
 * Attempts to read a scraped cell as a number. Returns the original string
 * unchanged unless the conversion is exact and lossless.
 */
export function coerceScrapedCellValue(raw: string): string | number {
  const trimmed = raw.trim();
  if (trimmed === '') return trimmed;

  const normalized = trimmed.replace(UNICODE_MINUS_REGEX, '-');

  if (!PLAIN_NUMBER_REGEX.test(normalized) && !THOUSANDS_GROUPED_REGEX.test(normalized)) {
    return raw;
  }

  const digits = normalized.replace(/,/g, '');
  const n = Number(digits);

  if (!Number.isFinite(n)) return raw;

  // Round-trip check: refuse anything that doesn't losslessly reconstruct,
  // which is what protects a leading-zero ID ("007") or an out-of-safe-range
  // value from being silently corrupted by this being "helpful".
  const canonicalDigits = digits.replace(/^\+/, '');
  if (Number.isInteger(n)) {
    if (!Number.isSafeInteger(n) || String(n) !== canonicalDigits) return raw;
  }

  return n;
}
