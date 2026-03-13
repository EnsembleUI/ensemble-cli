import {
  readGlobalConfig,
  writeGlobalConfig,
  type EnsembleUserConfig,
} from '../config/globalConfig.js';
import {
  decodeIdTokenClaims,
  getIdTokenExpiryMs,
  isTokenExpired,
} from './token.js';

const DEFAULT_REFRESH_API_BASE = 'https://securetoken.googleapis.com/v1/token';

interface RefreshTokenResponse {
  id_token?: string;
  refresh_token?: string;
  user_id?: string;
  expires_in?: string;
  error?: {
    message?: string;
  };
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

function getRefreshApiKey(): string | undefined {
  return process.env.ENSEMBLE_FIREBASE_API_KEY;
}

async function refreshIdToken(refreshToken: string): Promise<{
  idToken: string;
  refreshToken: string;
  userId?: string;
  expiresAt?: number;
}> {
  const apiKey = getRefreshApiKey();
  if (!apiKey) {
    throw new Error(
      'Missing Firebase API key for token refresh. Set ENSEMBLE_FIREBASE_API_KEY.'
    );
  }

  const refreshUrl = `${DEFAULT_REFRESH_API_BASE}?key=${encodeURIComponent(apiKey)}`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch(refreshUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = (await res.json()) as RefreshTokenResponse;
  if (!res.ok || !data.id_token) {
    const reason = data?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Token refresh failed: ${reason}`);
  }

  const expiresInSec = Number(data.expires_in);
  const expiresAt =
    Number.isFinite(expiresInSec) && expiresInSec > 0
      ? Date.now() + expiresInSec * 1000
      : getIdTokenExpiryMs(data.id_token);

  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token ?? refreshToken,
    userId: data.user_id,
    expiresAt,
  };
}

export async function getValidAuthSession(): Promise<AuthSessionResult> {
  const config: EnsembleUserConfig = (await readGlobalConfig()) ?? {};
  const user = config.user;

  if (!user?.idToken || !user.uid) {
    return {
      ok: false,
      reason: 'not_logged_in',
      message: 'You must be logged in. Run `ensemble login` first.',
    };
  }

  if (!isTokenExpired(user.idToken, user.expiresAt)) {
    return {
      ok: true,
      idToken: user.idToken,
      userId: user.uid,
      name: user.name,
      email: user.email,
      refreshed: false,
    };
  }

  if (!user.refreshToken) {
    return {
      ok: false,
      reason: 'expired',
      message:
        'Session expired and no refresh token was found. Run `ensemble login` again.',
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
      expiresAt: refreshed.expiresAt,
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
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown refresh error';
      return {
      ok: false,
      reason: 'expired',
      message: `Session expired and automatic refresh failed: ${message}. Run \`ensemble login\` again.`,
    };
  }
}
