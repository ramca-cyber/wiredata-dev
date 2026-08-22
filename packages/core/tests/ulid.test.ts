import { describe, it, expect } from 'vitest';
import { generateULID, isValidULID } from '../src/utils/ulid.js';

describe('ULID Generator', () => {
  it('generates valid 26-character Crockford Base32 strings', () => {
    const id = generateULID();
    expect(id).toHaveLength(26);
    expect(isValidULID(id)).toBe(true);
  });

  it('preserves lexicographical sort order for monotonic generation', () => {
    const id1 = generateULID();
    const id2 = generateULID();
    const id3 = generateULID();

    expect(id1 < id2).toBe(true);
    expect(id2 < id3).toBe(true);
  });

  it('generates unique IDs in tight loop', () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateULID();
      expect(set.has(id)).toBe(false);
      set.add(id);
    }
    expect(set.size).toBe(1000);
  });
});
