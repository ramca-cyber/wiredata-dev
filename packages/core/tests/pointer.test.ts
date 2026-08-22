import { describe, it, expect } from 'vitest';
import {
  parsePointer,
  compilePointer,
  getValueByPointer,
  hasPointer,
  pointerToDisplayPath,
  joinPointers,
  escapePointerToken,
  unescapePointerToken,
} from '../src/json/pointer.js';

describe('RFC 6901 JSON Pointer', () => {
  const doc = {
    foo: ['bar', 'baz'],
    '': 0,
    'a/b': 1,
    'c%d': 2,
    'e^f': 3,
    'g|h': 4,
    'i\\j': 5,
    'k"l': 6,
    'm~n': 7,
    orders: [
      { id: 101, customer: { name: 'Alice', address: { city: 'Toronto' } } },
      { id: 102, customer: { name: 'Bob', address: { city: 'Montreal' } } },
    ],
  };

  it('escapes and unescapes tokens per RFC 6901', () => {
    expect(escapePointerToken('a/b')).toBe('a~1b');
    expect(escapePointerToken('m~n')).toBe('m~0n');
    expect(unescapePointerToken('a~1b')).toBe('a/b');
    expect(unescapePointerToken('m~0n')).toBe('m~n');
  });

  it('evaluates RFC 6901 spec examples', () => {
    expect(getValueByPointer(doc, '')).toEqual(doc);
    expect(getValueByPointer(doc, '/foo')).toEqual(['bar', 'baz']);
    expect(getValueByPointer(doc, '/foo/0')).toBe('bar');
    expect(getValueByPointer(doc, '/')).toBe(0);
    expect(getValueByPointer(doc, '/a~1b')).toBe(1);
    expect(getValueByPointer(doc, '/c%d')).toBe(2);
    expect(getValueByPointer(doc, '/e^f')).toBe(3);
    expect(getValueByPointer(doc, '/g|h')).toBe(4);
    expect(getValueByPointer(doc, '/i\\j')).toBe(5);
    expect(getValueByPointer(doc, '/k"l')).toBe(6);
    expect(getValueByPointer(doc, '/m~0n')).toBe(7);
  });

  it('evaluates nested array and object pointers', () => {
    expect(getValueByPointer(doc, '/orders/0/customer/address/city')).toBe('Toronto');
    expect(getValueByPointer(doc, '/orders/1/customer/name')).toBe('Bob');
    expect(getValueByPointer(doc, '/orders/99/customer')).toBeUndefined();
    expect(getValueByPointer(doc, '/nonexistent/path')).toBeUndefined();
  });

  it('correctly checks pointer existence with hasPointer', () => {
    expect(hasPointer(doc, '/orders/0/customer/name')).toBe(true);
    expect(hasPointer(doc, '/orders/5/customer')).toBe(false);
    expect(hasPointer(doc, '/nonexistent')).toBe(false);
  });

  it('compiles and parses pointers correctly', () => {
    const tokens = ['orders', 0, 'customer', 'a/b'];
    const pointer = compilePointer(tokens);
    expect(pointer).toBe('/orders/0/customer/a~1b');
    expect(parsePointer(pointer)).toEqual(['orders', '0', 'customer', 'a/b']);
  });

  it('joins base and relative pointers', () => {
    const base = '/data/orders/0';
    const relative = '/customer/address/city';
    expect(joinPointers(base, relative)).toBe('/data/orders/0/customer/address/city');
  });

  it('converts pointers to friendly JSONPath display paths', () => {
    expect(pointerToDisplayPath('')).toBe('$');
    expect(pointerToDisplayPath('/orders/0/customer/name')).toBe('$.orders[0].customer.name');
    expect(pointerToDisplayPath('/orders/0/customer/address/city')).toBe('$.orders[0].customer.address.city');
  });
});
