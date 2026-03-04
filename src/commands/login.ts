import { exec } from 'child_process';
import http from 'http';
import { createServer, type Server } from 'net';

import {
  getGlobalConfigPath,
  readGlobalConfig,
  writeGlobalConfig,
  type EnsembleUserConfig,
} from '../config/globalConfig.js';
import {
  decodeIdTokenClaims,
  getIdTokenExpiryMs,
  isTokenExpired,
  normalizeExpiresAt,
} from '../auth/token.js';
import { resolveVerboseFlag } from '../core/cliError.js';

const DEFAULT_AUTH_BASE_URL = 'https://studio.ensembleui.com/sign-in';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface LoginOptions {
  verbose?: boolean;
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' && 'port' in address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('No port'))));
    });
    server.on('error', reject);
  });
}

function openBrowser(url: string): void {
  const openCommand =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  exec(openCommand, (err) => {
    if (err) {
      console.warn('Could not open browser automatically. Please open the URL manually.');
    }
  });
}

export async function loginCommand(options: LoginOptions = {}): Promise<void> {
  const existing = (await readGlobalConfig()) ?? {};
  const baseUrl = process.env.ENSEMBLE_AUTH_BASE_URL ?? DEFAULT_AUTH_BASE_URL;
  const configPath = getGlobalConfigPath();
  const verbose = resolveVerboseFlag(options.verbose);

  const idToken = existing?.user?.idToken;
  if (idToken && !isTokenExpired(idToken)) {
    const claims = decodeIdTokenClaims(idToken);
    const normalizedExpiresAt =
      existing.user?.expiresAt ?? getIdTokenExpiryMs(idToken);
    const mergedUser = {
      ...(existing.user ?? { uid: claims.uid ?? 'cli-user', idToken }),
      uid: existing.user?.uid ?? claims.uid ?? 'cli-user',
      name: existing.user?.name ?? claims.name ?? undefined,
      email: existing.user?.email ?? claims.email ?? undefined,
      idToken,
      expiresAt: normalizedExpiresAt,
    };

    if (
      existing.user?.name !== mergedUser.name ||
      existing.user?.email !== mergedUser.email ||
      existing.user?.expiresAt !== mergedUser.expiresAt
    ) {
      await writeGlobalConfig({
        ...existing,
        user: mergedUser,
      });
    }

    const currentEmail = mergedUser.email;
    console.log(
      currentEmail ? `You are already logged in as ${currentEmail}` : 'You are already logged in.',
    );
    if (verbose) {
      console.log(`Auth config path: ${configPath}`);
    }
    return;
  }

  const port = await findAvailablePort();
  const loginUrl = new URL(baseUrl);
  loginUrl.searchParams.set('cliCallbackPort', String(port));

  const tokenPromise = new Promise<{
    token: string;
    refreshToken?: string;
    expiresAt?: number;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Login timed out. Please try again.'));
    }, CALLBACK_TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

      if (req.method === 'OPTIONS' && req.url?.startsWith('/callback')) {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url?.startsWith('/callback')) {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as {
              token?: string;
              refreshToken?: string;
              expiresAt?: number | string;
            };
            if (data.token && typeof data.token === 'string') {
              clearTimeout(timeout);
              res.writeHead(200, {
                ...cors,
                'Content-Type': 'application/json',
              });
              res.end(JSON.stringify({ ok: true }));
              server.close();
              resolve({
                token: data.token,
                refreshToken:
                  typeof data.refreshToken === 'string'
                    ? data.refreshToken
                    : undefined,
                expiresAt: normalizeExpiresAt(data.expiresAt),
              });
            } else {
              res.writeHead(400, {
                ...cors,
                'Content-Type': 'application/json',
              });
              res.end(JSON.stringify({ error: 'Missing token' }));
            }
          } catch {
            res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      res.writeHead(404, cors);
      res.end();
    });

    server.listen(port, '127.0.0.1', () => {
      // eslint-disable-next-line no-console
      console.log(
        'Opening browser to sign in. Complete sign-in there; this window will close automatically.'
      );
      openBrowser(loginUrl.toString());
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      server.close();
      reject(err);
    });
  });

  let callbackData: {
    token: string;
    refreshToken?: string;
    expiresAt?: number;
  };
  try {
    callbackData = await tokenPromise;
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Login failed.');
    return;
  }

  const token = callbackData.token;
  const { uid, name, email } = decodeIdTokenClaims(token);
  const expiresAt = callbackData.expiresAt ?? getIdTokenExpiryMs(token);

  const newConfig: EnsembleUserConfig = {
    ...existing,
    user: {
      uid: uid ?? 'cli-user',
      name: name ?? undefined,
      email: email ?? undefined,
      idToken: token,
      refreshToken: callbackData.refreshToken,
      expiresAt,
    },
  };

  await writeGlobalConfig(newConfig);
  console.log(email ? `Logged in as ${email}` : 'Logged in successfully.');
  if (verbose) {
    console.log(`Auth config path: ${configPath}`);
  }
}
