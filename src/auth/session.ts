import {
  readGlobalConfig,
  writeGlobalConfig,
  type EnsembleUserConfig,
} from '../config/globalConfig.js';
import { decodeIdTokenClaims, isTokenExpired, isTokenPastExpiry } from './token.js';
import { getEnsembleFirebaseApiKey } from '../config/env.js';

const DEFAULT_REFRESH_API_BASE = 'https://securetoken.googleapis.com/v1/token';
const REFRESH_MAX_ATTEMPTS = 3;
const REFRESH_RETRY_DELAY_MS = 200;

interface RefreshTokenResponse {
  id_token?: string;
  refresh_token?: string;
  user_id?: string;
  expires_in?: string;
  error?: {
    message?: string;
  };
}

class TokenRefreshError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'TokenRefreshError';
    this.retryable = retryable;
  }
}

export type AuthSessionResult =
  | {
      ok: true;
      idToken: string;
      userId: string;
      name?: string;
      email?: string;
      refreshed: boolean;
    }
  | {
      ok: false;
      reason: 'not_logged_in' | 'expired';
      message: string;
    };

function isRetryableRefreshStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseRefreshResponseBody(text: string): RefreshTokenResponse {
  if (!text.trim()) {
    throw new TokenRefreshError('Token refresh failed: empty response body', true);
  }

  try {
    return JSON.parse(text) as RefreshTokenResponse;
  } catch {
    throw new TokenRefreshError('Token refresh failed: invalid JSON response', true);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshIdTokenOnce(
  refreshToken: string,
  apiKey: string
): Promise<{
  idToken: string;
  refreshToken: string;
  userId?: string;
}> {
  const refreshUrl = `${DEFAULT_REFRESH_API_BASE}?key=${encodeURIComponent(apiKey)}`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  let res: Response;
  try {
    res = await fetch(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    throw new TokenRefreshError(`Token refresh failed: ${message}`, true);
  }

  const text = await res.text();
  const data = parseRefreshResponseBody(text);

  if (!res.ok || !data.id_token) {
    const reason = data?.error?.message ?? `HTTP ${res.status}`;
    const retryable = isRetryableRefreshStatus(res.status);
    throw new TokenRefreshError(`Token refresh failed: ${reason}`, retryable);
  }

  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token ?? refreshToken,
    userId: data.user_id,
  };
}

async function refreshIdToken(refreshToken: string): Promise<{
  idToken: string;
  refreshToken: string;
  userId?: string;
}> {
  const apiKey = getEnsembleFirebaseApiKey();
  if (!apiKey) {
    throw new Error('Missing Firebase API key for token refresh. Set ENSEMBLE_FIREBASE_API_KEY.');
  }

  let lastError: Error = new Error('Token refresh failed.');

  for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await refreshIdTokenOnce(refreshToken, apiKey);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Token refresh failed.');
      const retryable = err instanceof TokenRefreshError && err.retryable;
      if (!retryable || attempt === REFRESH_MAX_ATTEMPTS) {
        break;
      }
      await sleep(REFRESH_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

const ENSEMBLE_TOKEN_ENV = 'ENSEMBLE_TOKEN';

/**
 * Use refresh token from environment (e.g. CI). Refreshes to get an id token;
 * does not read or write global config.
 */
async function sessionFromEnvToken(): Promise<AuthSessionResult> {
  const refreshToken = process.env[ENSEMBLE_TOKEN_ENV]?.trim();
  if (!refreshToken) return { ok: false, reason: 'not_logged_in', message: '' };

  try {
    const refreshed = await refreshIdToken(refreshToken);
    const claims = decodeIdTokenClaims(refreshed.idToken);
    return {
      ok: true,
      idToken: refreshed.idToken,
      userId: claims.uid ?? refreshed.userId ?? 'cli-user',
      name: claims.name ?? undefined,
      email: claims.email ?? undefined,
      refreshed: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token refresh failed.';
    return {
      ok: false,
      reason: 'expired',
      message: `${message} Check that ENSEMBLE_TOKEN is a valid refresh token (from \`ensemble token\`) and ENSEMBLE_FIREBASE_API_KEY is set.`,
    };
  }
}

function sessionFromStoredUser(user: NonNullable<EnsembleUserConfig['user']>): AuthSessionResult {
  return {
    ok: true,
    idToken: user.idToken,
    userId: user.uid,
    name: user.name,
    email: user.email,
    refreshed: false,
  };
}

export async function getValidAuthSession(): Promise<AuthSessionResult> {
  const fromEnv = await sessionFromEnvToken();
  if (fromEnv.ok) return fromEnv;
  if (fromEnv.reason === 'expired') return fromEnv;
  // Not set or empty: fall back to global config

  const config: EnsembleUserConfig = (await readGlobalConfig()) ?? {};
  const user = config.user;

  if (!user?.idToken || !user.uid) {
    return {
      ok: false,
      reason: 'not_logged_in',
      message: 'You must be logged in. Run `ensemble login` first.',
    };
  }

  if (!isTokenExpired(user.idToken)) {
    return sessionFromStoredUser(user);
  }

  if (!user.refreshToken) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Session expired and no refresh token was found. Run `ensemble login` again.',
    };
  }

  try {
    const refreshed = await refreshIdToken(user.refreshToken);
    const claims = decodeIdTokenClaims(refreshed.idToken);
    const updatedUser: NonNullable<EnsembleUserConfig['user']> = {
      uid: claims.uid ?? refreshed.userId ?? user.uid,
      name: claims.name ?? user.name,
      email: claims.email ?? user.email,
      idToken: refreshed.idToken,
      refreshToken: refreshed.refreshToken,
    };
    const updatedConfig: EnsembleUserConfig = {
      ...config,
      user: updatedUser,
    };
    await writeGlobalConfig(updatedConfig);

    return {
      ok: true,
      idToken: refreshed.idToken,
      userId: updatedUser.uid,
      name: updatedUser.name,
      email: updatedUser.email,
      refreshed: true,
    };
  } catch (err) {
    if (!isTokenPastExpiry(user.idToken)) {
      return sessionFromStoredUser(user);
    }

    const reason = err instanceof Error ? err.message : 'Token refresh failed.';
    return {
      ok: false,
      reason: 'expired',
      message: `Session expired and automatic refresh failed: ${reason}. Run \`ensemble login\` again.`,
    };
  }
}
