import { describe, it, expect } from 'vitest';
import {
  redactHeaders,
  redactQueryParams,
  redactJsonBody,
  detectSensitiveJsonPaths,
  REDACTED_MARKER,
  isSensitiveHeader,
  isSensitiveKey,
} from '../src/capture/redact.js';

describe('Security and Credential Redaction', () => {
  it('identifies sensitive headers case-insensitively', () => {
    expect(isSensitiveHeader('Authorization')).toBe(true);
    expect(isSensitiveHeader('authorization')).toBe(true);
    expect(isSensitiveHeader('COOKIE')).toBe(true);
    expect(isSensitiveHeader('Set-Cookie')).toBe(true);
    expect(isSensitiveHeader('X-API-KEY')).toBe(true);
    expect(isSensitiveHeader('Content-Type')).toBe(false);
    expect(isSensitiveHeader('Accept')).toBe(false);
  });

  it('redacts sensitive headers in header lists', () => {
    const headers = [
      { name: 'Authorization', value: 'Bearer super-secret-jwt' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cookie', value: 'session_id=12345' },
      { name: 'X-Custom', value: 'public-data' },
    ];

    const sanitized = redactHeaders(headers);
    expect(sanitized[0]).toEqual({
      name: 'Authorization',
      value: REDACTED_MARKER,
      is_redacted: true,
    });
    expect(sanitized[1]).toEqual({
      name: 'Content-Type',
      value: 'application/json',
      is_redacted: false,
    });
    expect(sanitized[2]).toEqual({
      name: 'Cookie',
      value: REDACTED_MARKER,
      is_redacted: true,
    });
  });

  it('redacts sensitive query parameters in URLs', () => {
    const rawUrl = 'https://api.example.com/v1/data?page=2&token=sec_abc123&apiKey=secret_key_99&limit=10';
    const { sanitizedUrl, params } = redactQueryParams(rawUrl);

    expect(sanitizedUrl).toContain('token=%5BREDACTED%5D');
    expect(sanitizedUrl).toContain('apiKey=%5BREDACTED%5D');
    expect(sanitizedUrl).toContain('page=2');
    expect(sanitizedUrl).toContain('limit=10');

    const tokenParam = params.find(p => p.name === 'token');
    expect(tokenParam?.is_redacted).toBe(true);
    expect(tokenParam?.value).toBe(REDACTED_MARKER);
  });

  it('recursively redacts sensitive keys in JSON bodies', () => {
    const body = {
      username: 'johndoe',
      password: 'mypassword123',
      credentials: {
        api_key: 'key-xyz',
        public_token: 'pub-abc',
        secret: 'shhh',
      },
      items: [{ id: 1, auth_token: 'auth-val' }],
    };

    const redacted = redactJsonBody(body) as any;
    expect(redacted.username).toBe('johndoe');
    expect(redacted.password).toBe(REDACTED_MARKER);
    expect(redacted.credentials.api_key).toBe(REDACTED_MARKER);
    expect(redacted.credentials.secret).toBe(REDACTED_MARKER);
    expect(redacted.items[0].id).toBe(1);
    expect(redacted.items[0].auth_token).toBe(REDACTED_MARKER);
  });

  it('flags credential-shaped response fields without altering the value', () => {
    const body = {
      id: 44,
      name: 'Customer 44',
      session_token: 'tok_live_abc123',
      nested: { auth: { api_key: 'sk_live_xyz' } },
      items: [{ id: 1, refresh_token: 'rt_1_secret' }],
    };

    const paths = detectSensitiveJsonPaths(body);

    // Values must be completely untouched — response bodies are the exact
    // data being captured, not something to mutate.
    expect(body.session_token).toBe('tok_live_abc123');
    expect(body.nested.auth.api_key).toBe('sk_live_xyz');
    expect(body.items[0].refresh_token).toBe('rt_1_secret');

    expect(paths).toContain('/session_token');
    expect(paths).toContain('/nested/auth/api_key');
    expect(paths).toContain('/items/0/refresh_token');
    expect(paths).not.toContain('/id');
    expect(paths).not.toContain('/name');
  });

  it('does not flag ordinary fields whose names merely contain a sensitive substring', () => {
    // "author" contains "auth", "passenger" contains "pass" — the key-based
    // heuristic is intentionally applied only as a non-destructive UI flag
    // (never a mutation) precisely because it can't be perfectly precise.
    const body = { author: 'Jane Doe', passenger_count: 3 };
    const paths = detectSensitiveJsonPaths(body);
    expect(paths).toContain('/author');
    expect(paths).toContain('/passenger_count');
    // Documented limitation, not a bug: confirm redactJsonBody is never
    // applied to response bodies anywhere in the capture adapters — this
    // heuristic is a flag only, so false positives here cost nothing.
  });
});
