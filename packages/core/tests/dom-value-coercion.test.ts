import { describe, it, expect } from 'vitest';
import { coerceScrapedCellValue } from '../src/inference/dom-value-coercion.js';

describe('Scraped cell value coercion', () => {
  it('coerces thousands-grouped integers losslessly', () => {
    expect(coerceScrapedCellValue('1,425,423,212')).toBe(1425423212);
    expect(coerceScrapedCellValue('8,021,407,192')).toBe(8021407192);
  });

  it('coerces thousands-grouped decimals', () => {
    expect(coerceScrapedCellValue('1,234,567.89')).toBe(1234567.89);
  });

  it('coerces plain (ungrouped) numbers', () => {
    expect(coerceScrapedCellValue('44')).toBe(44);
    expect(coerceScrapedCellValue('3.14')).toBe(3.14);
    expect(coerceScrapedCellValue('-12')).toBe(-12);
  });

  it('normalizes the unicode minus sign real sites actually use (e.g. Wikipedia)', () => {
    expect(coerceScrapedCellValue('−0.18')).toBe(-0.18);
    expect(coerceScrapedCellValue('−8,021')).toBe(-8021);
  });

  it('never corrupts a value that merely looks numeric but has a leading zero', () => {
    // A real ID/zip-code shaped string — coercing this would silently
    // destroy information (007 !== 7).
    expect(coerceScrapedCellValue('007')).toBe('007');
    expect(coerceScrapedCellValue('00501')).toBe('00501');
  });

  it('leaves currency-symbol and percentage strings untouched (documented scope limit)', () => {
    // Deliberately not handled: which currency, and whether "+0.88%" means
    // 0.88 or 0.0088 is a real product decision, not something to guess.
    expect(coerceScrapedCellValue('$2,397')).toBe('$2,397');
    expect(coerceScrapedCellValue('+0.88%')).toBe('+0.88%');
    expect(coerceScrapedCellValue('−0.18%')).toBe('−0.18%');
  });

  it('leaves placeholders and non-numeric text untouched', () => {
    expect(coerceScrapedCellValue('–')).toBe('–');
    expect(coerceScrapedCellValue('N/A')).toBe('N/A');
    expect(coerceScrapedCellValue('World')).toBe('World');
    expect(coerceScrapedCellValue('')).toBe('');
  });

  it('refuses to coerce a malformed thousands grouping', () => {
    // "12,3456" isn't a real thousands grouping (second group isn't 3
    // digits) — must not silently reinterpret it as some other number.
    expect(coerceScrapedCellValue('12,3456')).toBe('12,3456');
  });

  it('refuses to coerce values beyond the safe integer range', () => {
    const huge = '99,999,999,999,999,999,999';
    expect(coerceScrapedCellValue(huge)).toBe(huge);
  });
});
