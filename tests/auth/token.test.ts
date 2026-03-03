import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  decodeIdTokenClaims,
  getIdTokenExpiryMs,
  normalizeExpiresAt,
  isTokenExpired,
} from '../../src/auth/token.js';

function base64urlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signature = base64urlEncode('signature');
  return `${header}.${payloadB64}.${signature}`;
}

describe('decodeIdTokenClaims', () => {
  it('decodes userId from payload', () => {
    const token = makeJwt({ userId: 'user-123', email: 'a@b.com' });
    expect(decodeIdTokenClaims(token)).toEqual({
      uid: 'user-123',
      name: null,
      email: 'a@b.com',
      exp: undefined,
    });
  });

  it('falls back to sub when userId is missing', () => {
    const token = makeJwt({ sub: 'firebase-uid', email: 'x@y.com' });
    expect(decodeIdTokenClaims(token)).toEqual({
      uid: 'firebase-uid',
      name: null,
      email: 'x@y.com',
      exp: undefined,
    });
  });

  it('decodes name and exp', () => {
    const token = makeJwt({
      userId: 'u1',
      name: 'Alice',
      email: 'alice@test.com',
      exp: 1735689600,
    });
    expect(decodeIdTokenClaims(token)).toEqual({
      uid: 'u1',
      name: 'Alice',
      email: 'alice@test.com',
      exp: 1735689600,
    });
  });

  it('returns nulls for invalid token', () => {
    expect(decodeIdTokenClaims('invalid')).toEqual({
      uid: null,
      name: null,
      email: null,
    });
  });

  it('returns nulls for malformed JWT (too few parts)', () => {
    expect(decodeIdTokenClaims('a.b')).toEqual({
      uid: null,
      name: null,
      email: null,
    });
  });
});

describe('getIdTokenExpiryMs', () => {
  it('returns exp in milliseconds', () => {
    const token = makeJwt({ userId: 'u1', exp: 1735689600 });
    expect(getIdTokenExpiryMs(token)).toBe(1735689600000);
  });

  it('returns undefined when exp is missing', () => {
    const token = makeJwt({ userId: 'u1' });
    expect(getIdTokenExpiryMs(token)).toBeUndefined();
  });
});

describe('normalizeExpiresAt', () => {
  it('accepts epoch milliseconds as-is', () => {
    const ms = 1735689600000;
    expect(normalizeExpiresAt(ms)).toBe(ms);
  });

  it('converts epoch seconds to milliseconds', () => {
    expect(normalizeExpiresAt(1735689600)).toBe(1735689600000);
  });

  it('accepts numeric string (seconds)', () => {
    expect(normalizeExpiresAt('1735689600')).toBe(1735689600000);
  });

  it('accepts numeric string (milliseconds)', () => {
    expect(normalizeExpiresAt('1735689600000')).toBe(1735689600000);
  });

  it('returns undefined for empty string', () => {
    expect(normalizeExpiresAt('')).toBeUndefined();
    expect(normalizeExpiresAt('   ')).toBeUndefined();
  });

  it('returns undefined for invalid input', () => {
    expect(normalizeExpiresAt(null)).toBeUndefined();
    expect(normalizeExpiresAt(undefined)).toBeUndefined();
  });
});

describe('isTokenExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when token is not expired', () => {
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
    // exp = 2025-01-01 13:00 UTC (1 hour in future)
    const token = makeJwt({ userId: 'u1', exp: 1735736400 });
    expect(isTokenExpired(token)).toBe(false);
  });

  it('returns true when token is expired', () => {
    vi.setSystemTime(new Date('2025-01-01T13:00:00Z'));
    // exp = 2025-01-01 12:00 UTC (1 hour ago)
    const token = makeJwt({ userId: 'u1', exp: 1735732800 });
    expect(isTokenExpired(token)).toBe(true);
  });

  it('uses bufferSeconds for expiry check', () => {
    vi.setSystemTime(new Date('2025-01-01T12:00:30Z'));
    // exp = 2025-01-01 13:00 UTC; with 60s buffer, token still valid at 12:00:30
    const token = makeJwt({ userId: 'u1', exp: 1735736400 });
    expect(isTokenExpired(token, undefined, 60)).toBe(false);
    expect(isTokenExpired(token, undefined, 0)).toBe(false);
  });

  it('uses expiresAt when provided', () => {
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
    const token = makeJwt({ userId: 'u1' });
    const futureMs = new Date('2025-06-01').getTime();
    expect(isTokenExpired(token, futureMs)).toBe(false);
  });
});
