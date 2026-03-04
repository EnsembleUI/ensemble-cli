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

describe('getValidAuthSession', () => {
  const originalEnv = process.env.ENSEMBLE_FIREBASE_API_KEY;

  beforeEach(() => {
    vi.mocked(globalConfig.readGlobalConfig).mockReset();
    process.env.ENSEMBLE_FIREBASE_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    process.env.ENSEMBLE_FIREBASE_API_KEY = originalEnv;
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
    delete process.env.ENSEMBLE_FIREBASE_API_KEY;

    const result = await getValidAuthSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
      expect(result.message).toContain('Run `ensemble login` again.');
    }
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
    vi.mocked(globalConfig.readGlobalConfig)
      .mockResolvedValueOnce({
        user: {
          uid: 'u1',
          idToken: oldToken,
          refreshToken: 'refresh-123',
        },
      })
      .mockResolvedValue({
        user: {
          uid: 'u1',
          idToken: newToken,
          refreshToken: 'refresh-123',
        },
      });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id_token: newToken,
        refresh_token: 'refresh-456',
        expires_in: '3600',
      }),
    });

    const result = await getValidAuthSession();

    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.idToken).toBe(newToken);
      expect(result.refreshed).toBe(true);
    }
    expect(globalConfig.writeGlobalConfig).toHaveBeenCalled();
  });
});
