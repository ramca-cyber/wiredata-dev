import { describe, it, expect } from 'vitest';
import {
  redactHeaders,
  redactQueryParams,
  redactJsonBody,
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
});
