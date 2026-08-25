/**
 * Applies a confirmed ColumnParseRule to a raw scraped text value.
 *
 * This is deliberately dumb and deterministic — it does no guessing at all.
 * The guessing (which candidate rule, if any, actually fits a column) is a
 * separate, DuckDB-backed step (@wiredata/duckdb's suggestParseRules), which
 * tests candidates against real TRY_CAST/TRY_STRPTIME rather than hand-
 * rolled regex, and only ever produces a *suggestion* the user confirms.
 * Once confirmed, applying it here should never surprise anyone: same rule,
 * same input, same output, every rebuild.
 *
 * A value that doesn't conform to a confirmed rule becomes null, not the
 * original string — that's what keeps a rule-applied column's dominant type
 * clean instead of silently reverting to VARCHAR the moment one row doesn't
 * fit (mirroring TRY_CAST's own null-on-mismatch behavior in the DuckDB
 * registration path). The original text is never lost: field_lineage always
 * keeps raw_value untouched regardless of what transformed_value becomes.
 */

import { ColumnParseRule } from '../types/index.js';

// U+2212 MINUS SIGN — used by some sites (e.g. Wikipedia) instead of the
// ASCII hyphen for negative numbers.
const UNICODE_MINUS_REGEX = /−/g;

function parseNumber(raw: string, rule: ColumnParseRule): number | null {
  let s = raw.replace(UNICODE_MINUS_REGEX, '-');

  if (rule.currency_symbol) {
    s = s.split(rule.currency_symbol).join('');
  }

  const thousands = rule.thousands_separator ?? ',';
  const decimal = rule.decimal_separator ?? '.';

  if (thousands) {
    s = s.split(thousands).join('');
  }
  if (decimal !== '.') {
    s = s.split(decimal).join('.');
  }

  s = s.trim();
  if (s === '' || !/^[+-]?\d+(\.\d+)?$/.test(s)) return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parsePercent(raw: string, rule: ColumnParseRule): number | null {
  const stripped = raw.replace(UNICODE_MINUS_REGEX, '-').replace(/%/g, '').trim();
  if (stripped === '' || !/^[+-]?\d+(\.\d+)?$/.test(stripped)) return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return rule.percent_as_fraction ? n / 100 : n;
}

/** Supports numeric-token formats only (YYYY, MM, DD with '/' or '-'). */
function parseDate(raw: string, format: string): string | null {
  const trimmed = raw.trim();
  const sep = format.includes('/') ? '/' : '-';
  const tokens = format.split(sep);
  const parts = trimmed.split(sep);
  if (tokens.length !== 3 || parts.length !== 3) return null;

  let year = '', month = '', day = '';
  for (let i = 0; i < 3; i++) {
    const part = parts[i];
    if (!/^\d+$/.test(part)) return null;
    if (tokens[i] === 'YYYY') year = part.padStart(4, '0');
    else if (tokens[i] === 'MM') month = part.padStart(2, '0');
    else if (tokens[i] === 'DD') day = part.padStart(2, '0');
    else return null;
  }
  if (!year || !month || !day) return null;

  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const iso = `${year}-${month}-${day}`;
  // Reject calendar-invalid dates (e.g. 2024-02-31) rather than let them
  // silently roll over to March.
  const asDate = new Date(`${iso}T00:00:00Z`);
  if (asDate.getUTCFullYear() !== Number(year) || asDate.getUTCMonth() + 1 !== m || asDate.getUTCDate() !== d) {
    return null;
  }
  return iso;
}

export function applyParseRule(raw: string, rule: ColumnParseRule): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  switch (rule.kind) {
    case 'number':
      return parseNumber(trimmed, rule);
    case 'percent':
      return parsePercent(trimmed, rule);
    case 'date':
      return parseDate(trimmed, rule.date_format || 'YYYY-MM-DD');
    default:
      return raw;
  }
}
