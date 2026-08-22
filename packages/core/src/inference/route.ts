/**
 * Route Normalization and Endpoint Grouping Engine
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_REGEX = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;
const INT_ID_REGEX = /^\d+$/;
const HEX_HASH_REGEX = /^[0-9a-f]{24,64}$/i;

/**
 * Checks if a path segment appears to be an identifier (UUID, integer ID, ULID, hash)
 */
export function isIdentifierSegment(segment: string): boolean {
  if (!segment) return false;
  return (
    INT_ID_REGEX.test(segment) ||
    UUID_REGEX.test(segment) ||
    ULID_REGEX.test(segment) ||
    HEX_HASH_REGEX.test(segment)
  );
}

/**
 * Normalizes a URL path by replacing dynamic identifier segments with {id}
 * e.g. /api/orders/9182/items -> /api/orders/{id}/items
 */
export function normalizePath(pathname: string): string {
  const segments = pathname.split('/');
  const normalized = segments.map(seg => {
    if (isIdentifierSegment(seg)) {
      return '{id}';
    }
    return seg;
  });
  return normalized.join('/');
}

/**
 * Normalizes query parameters into a canonical shape pattern
 * e.g. ?page=2&limit=50 -> page={page}&limit={limit} (sorted keys)
 */
export function normalizeQueryShape(urlOrQuery: string): Record<string, string> {
  let search = urlOrQuery;
  try {
    const u = new URL(urlOrQuery);
    search = u.search;
  } catch {
    if (urlOrQuery.includes('?')) {
      search = urlOrQuery.slice(urlOrQuery.indexOf('?'));
    }
  }

  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const shape: Record<string, string> = {};

  const sortedKeys = Array.from(new Set(params.keys())).sort();
  for (const k of sortedKeys) {
    shape[k] = '*';
  }
  return shape;
}

/**
 * Extracts GraphQL operation name from request body (JSON string or parsed object)
 */
export function extractGraphQLOperation(body: unknown): string | undefined {
  if (!body) return undefined;
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      // Regex match on raw string
      const match = /"operationName"\s*:\s*"([^"]+)"/.exec(body);
      if (match) return match[1];
      const queryMatch = /(?:query|mutation|subscription)\s+([A-Za-z0-9_]+)/.exec(body);
      if (queryMatch) return queryMatch[1];
      return undefined;
    }
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const op = (parsed as any).operationName;
    if (typeof op === 'string' && op.trim().length > 0) {
      return op.trim();
    }
    const query = (parsed as any).query;
    if (typeof query === 'string') {
      const match = /(?:query|mutation|subscription)\s+([A-Za-z0-9_]+)/.exec(query);
      if (match) return match[1];
    }
  }
  return undefined;
}

/**
 * Computes a standardized normalized route string for grouping
 */
export function computeNormalizedRoute(
  method: string,
  urlStr: string,
  graphqlOperation?: string
): string {
  let pathname = urlStr;
  try {
    const u = new URL(urlStr);
    pathname = u.pathname;
  } catch {
    if (urlStr.includes('?')) {
      pathname = urlStr.slice(0, urlStr.indexOf('?'));
    }
  }

  const normalizedPath = normalizePath(pathname);
  const upperMethod = method.toUpperCase();

  if (graphqlOperation) {
    return `${upperMethod} ${normalizedPath} (${graphqlOperation})`;
  }
  return `${upperMethod} ${normalizedPath}`;
}
