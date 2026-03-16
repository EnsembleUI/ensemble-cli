import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export interface EnsembleUserConfig {
  user?: {
    uid: string;
    name?: string;
    email?: string;
    idToken: string;
    refreshToken?: string;
    expiresAt?: number;
  };
  [key: string]: unknown;
}

const GLOBAL_DIRNAME = '.ensemble';
const GLOBAL_FILENAME = 'cli-config.json';

export function getGlobalConfigPath(): string {
  const home = os.homedir();
  return path.join(home, GLOBAL_DIRNAME, GLOBAL_FILENAME);
}

export async function readGlobalConfig(): Promise<EnsembleUserConfig | null> {
  const filePath = getGlobalConfigPath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as EnsembleUserConfig;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }
}

export async function writeGlobalConfig(config: EnsembleUserConfig): Promise<void> {
  const filePath = getGlobalConfigPath();
  const dir = path.dirname(filePath);
  // Ensure the global config directory exists; on POSIX, prefer user-only permissions.
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  // On POSIX systems, restrict the config file so only the current user can read/write it.
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // Best-effort: if chmod fails, continue without breaking login/logout flows.
    }
  }
}

export async function clearUserAuth(): Promise<void> {
  const existing = (await readGlobalConfig()) ?? {};
  delete existing.user;
  await writeGlobalConfig(existing);
}
