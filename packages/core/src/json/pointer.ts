/**
 * RFC 6901 JSON Pointer implementation
 * Specification: https://datatracker.ietf.org/doc/html/rfc6901
 */

import { JSONPointer } from '../types/index.js';

/**
 * Escapes a token according to RFC 6901:
 * '~' -> '~0'
 * '/' -> '~1'
 */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Unescapes a token according to RFC 6901:
 * '~1' -> '/'
 * '~0' -> '~'
 */
export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Parses a JSON Pointer string into an array of reference tokens
 */
export function parsePointer(pointer: JSONPointer): string[] {
  if (!pointer || pointer === '') {
    return [];
  }
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid JSON Pointer: "${pointer}" must start with "/"`);
  }
  // Slicing first '/' - if pointer is '/', tokens is [""]
  return pointer.slice(1).split('/').map(unescapePointerToken);
}

/**
 * Compiles an array of tokens into a canonical JSON Pointer
 */
export function compilePointer(tokens: Array<string | number>): JSONPointer {
  if (tokens.length === 0) return '';
  return '/' + tokens.map(t => escapePointerToken(String(t))).join('/');
}

/**
 * Evaluates a JSON pointer against a JSON document, returning the targeted value
 */
export function getValueByPointer(document: unknown, pointer: JSONPointer): unknown {
  if (!pointer || pointer === '') {
    return document;
  }
  const tokens = parsePointer(pointer);
  let current: any = document;

  for (const token of tokens) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(token);
      if (isNaN(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
    } else if (typeof current === 'object') {
      if (!(token in current)) {
        return undefined;
      }
      current = current[token];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Checks if a pointer exists in a document
 */
export function hasPointer(document: unknown, pointer: JSONPointer): boolean {
  if (!pointer || pointer === '' || pointer === '/') {
    return document !== undefined;
  }
  const tokens = parsePointer(pointer);
  let current: any = document;

  for (const token of tokens) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return false;
    }
    if (Array.isArray(current)) {
      const index = Number(token);
      if (isNaN(index) || index < 0 || index >= current.length) {
        return false;
      }
      current = current[index];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        return false;
      }
      current = current[token];
    }
  }

  return true;
}

/**
 * Converts a JSON Pointer into a human-friendly JSONPath-like string:
 * e.g. "/data/orders/0/customer/name" -> "$.data.orders[0].customer.name"
 */
export function pointerToDisplayPath(pointer: JSONPointer): string {
  if (!pointer || pointer === '' || pointer === '/') {
    return '$';
  }
  const tokens = parsePointer(pointer);
  let result = '$';

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      result += `[${token}]`;
    } else if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(token)) {
      result += `.${token}`;
    } else {
      result += `[${JSON.stringify(token)}]`;
    }
  }

  return result;
}

/**
 * Combines two pointers: base + relative
 */
export function joinPointers(base: JSONPointer, relative: JSONPointer): JSONPointer {
  const baseTokens = parsePointer(base);
  const relTokens = parsePointer(relative);
  return compilePointer([...baseTokens, ...relTokens]);
}
