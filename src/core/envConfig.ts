import fs from 'fs/promises';
import path from 'path';

export interface EnvEntry {
  key: string;
  value: string;
  overwrite?: boolean;
}

export const ENV_CONFIG_BASE = '.env.config';
export const ENV_SECRETS_BASE = '.env.secrets';

export function envConfigScopedFile(appKey: string): string {
  return `${ENV_CONFIG_BASE}.${appKey}`;
}

export function envSecretsScopedFile(appKey: string): string {
  return `${ENV_SECRETS_BASE}.${appKey}`;
}

function parseEnvFile(raw: string): {
  lines: string[];
  keyToLineIndex: Map<string, number>;
} {
  const lines = raw.split(/\r?\n/);
  const keyToLineIndex = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key) keyToLineIndex.set(key, i);
  }
  return { lines, keyToLineIndex };
}

export async function envFileExists(projectRoot: string, fileName: string): Promise<boolean> {
  try {
    await fs.access(path.join(projectRoot, fileName));
    return true;
  } catch {
    return false;
  }
}

export async function readEnvFile(projectRoot: string, fileName: string): Promise<EnvEntry[]> {
  const envPath = path.join(projectRoot, fileName);
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    return [];
  }
  const parsed = parseEnvFile(raw);
  const entries: EnvEntry[] = [];
  for (const [key, lineIndex] of parsed.keyToLineIndex) {
    const line = parsed.lines[lineIndex] ?? '';
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    entries.push({ key, value: line.slice(eq + 1) });
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

export async function upsertEnvFile(
  projectRoot: string,
  fileName: string,
  entries: EnvEntry[]
): Promise<void> {
  const envPath = path.join(projectRoot, fileName);
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    raw = '';
  }
  const parsed = parseEnvFile(raw);
  while (parsed.lines.length > 0 && parsed.lines[parsed.lines.length - 1].trim() === '') {
    parsed.lines.pop();
  }
  for (const entry of entries) {
    const line = `${entry.key}=${entry.value}`;
    const existingIdx = parsed.keyToLineIndex.get(entry.key);
    if (existingIdx === undefined) {
      parsed.lines.push(line);
      parsed.keyToLineIndex.set(entry.key, parsed.lines.length - 1);
    } else if (entry.overwrite !== false) {
      parsed.lines[existingIdx] = line;
    }
  }
  const normalized = parsed.lines.join('\n').replace(/\n*$/, '\n');
  await fs.writeFile(envPath, normalized, 'utf8');
}

export async function writeEnvFile(
  projectRoot: string,
  fileName: string,
  entries: EnvEntry[]
): Promise<void> {
  const envPath = path.join(projectRoot, fileName);
  const normalized = entries
    .map((entry) => `${entry.key}=${entry.value}`)
    .join('\n')
    .replace(/\n*$/, '\n');
  await fs.writeFile(envPath, normalized, 'utf8');
}

export async function upsertEnvConfig(projectRoot: string, entries: EnvEntry[]): Promise<void> {
  await upsertEnvFile(projectRoot, '.env.config', entries);
}
