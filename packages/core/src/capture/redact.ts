/**
 * Security and Credential Redaction Engine
 * Strict case-insensitive header, query parameter, and request body redaction
 */

import { SanitizedHeader, SanitizedQueryParam } from '../types/index.js';

export const REDACTED_MARKER = '[REDACTED]';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
  'bearer',
]);

const SENSITIVE_PARAM_PATTERNS = [
  /token/i,
  /auth/i,
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /pass/i,
  /sig(?:nature)?$/i,
  /session/i,
  /bearer/i,
  /credentials/i,
];

/**
 * Checks if a header name is considered sensitive
 */
export function isSensitiveHeader(headerName: string): boolean {
  return SENSITIVE_HEADERS.has(headerName.toLowerCase().trim());
}

/**
 * Checks if a parameter or key name matches sensitive patterns
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().trim();
  return SENSITIVE_PARAM_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Redacts an array of request/response headers
 */
export function redactHeaders(headers: Array<{ name: string; value: string }>): SanitizedHeader[] {
  return headers.map(h => {
    const isSensitive = isSensitiveHeader(h.name);
    return {
      name: h.name,
      value: isSensitive ? REDACTED_MARKER : h.value,
      is_redacted: isSensitive,
    };
  });
}

/**
 * Parses and redacts query parameters from a URL or query string
 */
export function redactQueryParams(urlOrQuery: string): {
  sanitizedUrl: string;
  params: SanitizedQueryParam[];
} {
  let urlObj: URL | null = null;
  let queryString = urlOrQuery;

  try {
    urlObj = new URL(urlOrQuery);
    queryString = urlObj.search;
  } catch {
    if (urlOrQuery.includes('?')) {
      queryString = urlOrQuery.slice(urlOrQuery.indexOf('?'));
    }
  }

  const searchParams = new URLSearchParams(queryString.startsWith('?') ? queryString.slice(1) : queryString);
  const params: SanitizedQueryParam[] = [];
  const sanitizedSearchParams = new URLSearchParams();

  for (const [key, value] of searchParams.entries()) {
    const isSensitive = isSensitiveKey(key);
    const sanitizedValue = isSensitive ? REDACTED_MARKER : value;
    params.push({
      name: key,
      value: sanitizedValue,
      is_redacted: isSensitive,
    });
    sanitizedSearchParams.append(key, sanitizedValue);
  }

  let sanitizedUrl = urlOrQuery;
  if (urlObj) {
    urlObj.search = sanitizedSearchParams.toString();
    sanitizedUrl = urlObj.toString();
  } else if (urlOrQuery.includes('?')) {
    const base = urlOrQuery.slice(0, urlOrQuery.indexOf('?'));
    const qs = sanitizedSearchParams.toString();
    sanitizedUrl = qs ? `${base}?${qs}` : base;
  }

  return { sanitizedUrl, params };
}

/**
 * Recursively redacts sensitive keys in JSON payloads (request bodies)
 */
export function redactJsonBody(body: unknown): unknown {
  if (body === null || body === undefined) return body;

  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      const redacted = redactJsonBody(parsed);
      return JSON.stringify(redacted);
    } catch {
      // Plain text or non-JSON body: check for sensitive URL-encoded forms
      if (body.includes('=') && (body.includes('&') || body.startsWith('token='))) {
        const { sanitizedUrl } = redactQueryParams(`?${body}`);
        return sanitizedUrl.startsWith('?') ? sanitizedUrl.slice(1) : sanitizedUrl;
      }
      return body;
    }
  }

  if (Array.isArray(body)) {
    return body.map(item => redactJsonBody(item));
  }

  if (typeof body === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === 'object' && v !== null) {
        result[k] = redactJsonBody(v);
      } else if (isSensitiveKey(k)) {
        result[k] = REDACTED_MARKER;
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  return body;
}

/**
 * Non-destructively scans a JSON value for keys that look credential-shaped
 * and returns their JSON Pointers, without altering the value at all.
 *
 * Response bodies are the actual data WireData exists to capture and turn
 * into datasets — mutating them the way redactJsonBody does for request
 * bodies would break exact provenance (the stored body, its hash, and the
 * derived dataset would all silently diverge from what the server actually
 * returned), and the key-name heuristics here are prone to false positives
 * on legitimate fields (e.g. "author", "passenger", "session_count"). This
 * is a flag for the UI to surface a warning, not a mutation.
 */
export function detectSensitiveJsonPaths(body: unknown, basePath: string = ''): string[] {
  const flagged: string[] = [];

  if (body === null || body === undefined || typeof body !== 'object') {
    return flagged;
  }

  if (Array.isArray(body)) {
    body.forEach((item, idx) => {
      flagged.push(...detectSensitiveJsonPaths(item, `${basePath}/${idx}`));
    });
    return flagged;
  }

  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const path = `${basePath}/${k}`;
    if (isSensitiveKey(k)) {
      flagged.push(path);
    }
    if (typeof v === 'object' && v !== null) {
      flagged.push(...detectSensitiveJsonPaths(v, path));
    }
  }

  return flagged;
}
