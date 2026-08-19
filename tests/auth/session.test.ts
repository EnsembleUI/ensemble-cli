import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getValidAuthSession } from '../../src/auth/session.js';
import type { EnsembleUserConfig } from '../../src/config/globalConfig.js';
import * as globalConfig from '../../src/config/globalConfig.js';

vi.mock('../../src/config/globalConfig.js', () => ({
  readGlobalConfig: vi.fn(),
  writeGlobalConfig: vi.fn(),
}));

function makeJwt(payload: Record<string, unknown>): string {
  const base64url = (str: string) =>
    Buffer.from(str, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${header}.${payloadB64}.${base64url('sig')}`;
}

function mockRefreshFetchResponse(params: {
  ok: boolean;
  status?: number;
  body?: unknown;
  text?: string;
}) {
  const bodyText = params.text ?? JSON.stringify(params.body ?? {});
  return {
    ok: params.ok,
    status: params.status ?? (params.ok ? 200 : 400),
    text: async () => bodyText,
  };
}

describe('getValidAuthSession', () => {
  const originalEnv = process.env.ENSEMBLE_FIREBASE_API_KEY;
  const originalToken = process.env.ENSEMBLE_TOKEN;

  beforeEach(() => {
    vi.mocked(globalConfig.readGlobalConfig).mockReset();
    vi.mocked(globalConfig.writeGlobalConfig).mockReset();
    process.env.ENSEMBLE_FIREBASE_API_KEY = 'test-api-key';
    delete process.env.ENSEMBLE_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.ENSEMBLE_FIREBASE_API_KEY = originalEnv;
    if (originalToken !== undefined) process.env.ENSEMBLE_TOKEN = originalToken;
    else delete process.env.ENSEMBLE_TOKEN;
  });

  it('returns session from ENSEMBLE_TOKEN when set and refresh succeeds', async () => {
    process.env.ENSEMBLE_TOKEN = 'env-refresh-token';
    const newToken = makeJwt({
      userId: 'u2',
      email: 'ci@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockRefreshFetchResponse({
        ok: true,
        body: {
          id_token: newToken,
          refresh_token: 'env-refresh-token',
          expires_in: '3600',
        },
      })
    );

    const result = await getValidAuthSession();

    globalThis.fetch = originalFetch;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.idToken).toBe(newToken);
      expect(result.userId).toBe('u2');
      expect(result.email).toBe('ci@example.com');
      expect(result.refreshed).toBe(true);
    }
    expect(globalConfig.readGlobalConfig).not.toHaveBeenCalled();
  });

  it('returns expired when ENSEMBLE_TOKEN is set but refresh fails', async () => {
    process.env.ENSEMBLE_TOKEN = 'bad-refresh-token';
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      mockRefreshFetchResponse({
        ok: false,
        status: 400,
        body: { error: { message: 'INVALID_GRANT' } },
      })
    );
    globalThis.fetch = fetchMock;

    const result = await getValidAuthSession();

    globalThis.fetch = originalFetch;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
      expect(result.message).toContain('INVALID_GRANT');
      expect(result.message).toContain('ENSEMBLE_TOKEN');
      expect(result.message).toContain('ensemble token');
    }
    expect(globalConfig.readGlobalConfig).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns not_logged_in when no config', async () => {
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue(null);

    const result = await getValidAuthSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_logged_in');
      expect(result.message).toContain('Run `ensemble login`');
    }
  });

  it('returns not_logged_in when user has no idToken', async () => {
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: { uid: 'u1' },
    } as EnsembleUserConfig);

    const result = await getValidAuthSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_logged_in');
      expect(result.message).toContain('Run `ensemble login`');
    }
  });

  it('returns ok when token is valid and not expired', async () => {
    const token = makeJwt({
      userId: 'u1',
      email: 'a@b.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        email: 'a@b.com',
        idToken: token,
      },
    });

    const result = await getValidAuthSession();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.idToken).toBe(token);
      expect(result.userId).toBe('u1');
      expect(result.email).toBe('a@b.com');
      expect(result.refreshed).toBe(false);
    }
  });

  it('returns expired when token expired and no refresh token', async () => {
    const token = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        idToken: token,
      },
    });

    const result = await getValidAuthSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
      expect(result.message).toContain('Run `ensemble login` again.');
    }
  });

  it('returns expired with friendly hint when refresh fails', async () => {
    const expiredToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        idToken: expiredToken,
        refreshToken: 'refresh-token',
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockRefreshFetchResponse({
        ok: false,
        status: 400,
        body: { error: { message: 'INVALID_GRANT' } },
      })
    );

    const result = await getValidAuthSession();

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
      expect(result.message).toContain('INVALID_GRANT');
      expect(result.message).toContain('Run `ensemble login` again.');
    }
  });

  it('returns ok without refresh when jwt is valid even if legacy config has stale expiresAt', async () => {
    const token = makeJwt({
      userId: 'u1',
      email: 'a@b.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        email: 'a@b.com',
        idToken: token,
        refreshToken: 'refresh-123',
        expiresAt: Date.now() - 3600_000,
      },
    } as EnsembleUserConfig);

    const fetchMock = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    const result = await getValidAuthSession();

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.idToken).toBe(token);
      expect(result.refreshed).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes token when expired and refresh token exists', async () => {
    const oldToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const newToken = makeJwt({
      userId: 'u1',
      email: 'a@b.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        idToken: oldToken,
        refreshToken: 'refresh-123',
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockRefreshFetchResponse({
        ok: true,
        body: {
          id_token: newToken,
          refresh_token: 'refresh-456',
          expires_in: '3600',
        },
      })
    );

    const result = await getValidAuthSession();

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.idToken).toBe(newToken);
      expect(result.refreshed).toBe(true);
    }
    expect(globalConfig.writeGlobalConfig).toHaveBeenCalled();
  });

  it('retries refresh when first attempt fails transiently then succeeds', async () => {
    vi.useFakeTimers();
    const oldToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const newToken = makeJwt({
      userId: 'u1',
      email: 'a@b.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        idToken: oldToken,
        refreshToken: 'refresh-123',
      },
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(
        mockRefreshFetchResponse({
          ok: true,
          body: {
            id_token: newToken,
            refresh_token: 'refresh-456',
            expires_in: '3600',
          },
        })
      );
    globalThis.fetch = fetchMock;

    const resultPromise = getValidAuthSession();
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(globalConfig.writeGlobalConfig).toHaveBeenCalled();
  });

  it('retries refresh on 503 then succeeds', async () => {
    vi.useFakeTimers();
    const oldToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const newToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        idToken: oldToken,
        refreshToken: 'refresh-123',
      },
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockRefreshFetchResponse({
          ok: false,
          status: 503,
          body: { error: { message: 'UNAVAILABLE' } },
        })
      )
      .mockResolvedValueOnce(
        mockRefreshFetchResponse({
          ok: true,
          body: { id_token: newToken, refresh_token: 'refresh-456' },
        })
      );
    globalThis.fetch = fetchMock;

    const resultPromise = getValidAuthSession();
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to stored token when refresh fails within proactive buffer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:59:30Z'));
    const bufferToken = makeJwt({ userId: 'u1', email: 'a@b.com', exp: 1735736400 });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        email: 'a@b.com',
        idToken: bufferToken,
        refreshToken: 'refresh-123',
      },
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));
    globalThis.fetch = fetchMock;

    const resultPromise = getValidAuthSession();
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.idToken).toBe(bufferToken);
      expect(result.refreshed).toBe(false);
    }
    expect(globalConfig.writeGlobalConfig).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns expired with underlying reason when token is past exp and refresh fails', async () => {
    vi.useFakeTimers();
    const expiredToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        idToken: expiredToken,
        refreshToken: 'refresh-token',
      },
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));
    globalThis.fetch = fetchMock;

    const resultPromise = getValidAuthSession();
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('fetch failed');
      expect(result.message).toContain('Run `ensemble login` again.');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falls back to stored token when jwt has no exp and refresh fails', async () => {
    vi.useFakeTimers();
    const tokenWithoutExp = makeJwt({ userId: 'u1', email: 'a@b.com' });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        email: 'a@b.com',
        idToken: tokenWithoutExp,
        refreshToken: 'refresh-123',
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

    const resultPromise = getValidAuthSession();
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.idToken).toBe(tokenWithoutExp);
      expect(result.refreshed).toBe(false);
    }
    expect(globalConfig.writeGlobalConfig).not.toHaveBeenCalled();
  });

  it('retries on empty response body then succeeds', async () => {
    vi.useFakeTimers();
    const oldToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const newToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        idToken: oldToken,
        refreshToken: 'refresh-123',
      },
    });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockRefreshFetchResponse({ ok: true, text: '' }))
      .mockResolvedValueOnce(
        mockRefreshFetchResponse({
          ok: true,
          body: { id_token: newToken, refresh_token: 'refresh-456' },
        })
      );
    globalThis.fetch = fetchMock;

    const resultPromise = getValidAuthSession();
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
