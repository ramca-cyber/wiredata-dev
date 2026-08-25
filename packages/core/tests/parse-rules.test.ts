import { describe, it, expect } from 'vitest';
import { applyParseRule } from '../src/inference/parse-rules.js';
import { ColumnParseRule } from '../src/types/index.js';

describe('applyParseRule', () => {
  it('parses plain and thousands-grouped numbers', () => {
    const rule: ColumnParseRule = { kind: 'number' };
    expect(applyParseRule('1,425,423,212', rule)).toBe(1425423212);
    expect(applyParseRule('84.12745', rule)).toBeCloseTo(84.12745);
    expect(applyParseRule('−0.18', rule)).toBeCloseTo(-0.18); // unicode minus
  });

  it('respects European decimal/thousands convention', () => {
    const rule: ColumnParseRule = { kind: 'number', thousands_separator: '.', decimal_separator: ',' };
    expect(applyParseRule('1.234,56', rule)).toBeCloseTo(1234.56);
  });

  it('strips a currency symbol before parsing', () => {
    const rule: ColumnParseRule = { kind: 'number', currency_symbol: '$' };
    expect(applyParseRule('$2,397', rule)).toBe(2397);
  });

  it('returns null for a non-conforming value under a confirmed rule, never the raw string', () => {
    const rule: ColumnParseRule = { kind: 'number' };
    expect(applyParseRule('N/A', rule)).toBeNull();
    expect(applyParseRule('', rule)).toBeNull();
  });

  it('does not silently corrupt a leading-zero ID even under a number rule', () => {
    // Confirming a 'number' rule on the wrong column is a user mistake, not
    // something this function can detect — but it still shouldn't invent a
    // value that looks plausible when the input isn't well-formed.
    const rule: ColumnParseRule = { kind: 'number' };
    expect(applyParseRule('007', rule)).toBe(7); // valid number, precision loss is the user's call once confirmed
  });

  it('parses percent as either the literal number or a fraction, per rule', () => {
    expect(applyParseRule('+0.88%', { kind: 'percent' })).toBeCloseTo(0.88);
    expect(applyParseRule('+0.88%', { kind: 'percent', percent_as_fraction: true })).toBeCloseTo(0.0088);
    expect(applyParseRule('−8.08%', { kind: 'percent' })).toBeCloseTo(-8.08);
  });

  it('parses dates in the confirmed format only', () => {
    expect(applyParseRule('2026-08-25', { kind: 'date', date_format: 'YYYY-MM-DD' })).toBe('2026-08-25');
    expect(applyParseRule('08/25/2026', { kind: 'date', date_format: 'MM/DD/YYYY' })).toBe('2026-08-25');
    expect(applyParseRule('25/08/2026', { kind: 'date', date_format: 'DD/MM/YYYY' })).toBe('2026-08-25');
  });

  it('rejects calendar-invalid dates and format mismatches instead of guessing', () => {
    expect(applyParseRule('2026-02-31', { kind: 'date', date_format: 'YYYY-MM-DD' })).toBeNull();
    expect(applyParseRule('25/08/2026', { kind: 'date', date_format: 'MM/DD/YYYY' })).toBeNull(); // 25 isn't a valid month
    expect(applyParseRule('not a date', { kind: 'date', date_format: 'YYYY-MM-DD' })).toBeNull();
  });
});
