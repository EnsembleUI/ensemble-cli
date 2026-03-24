import fs from 'fs/promises';
import path from 'path';

function parseEnvConfig(raw: string): {
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

export async function upsertEnvConfig(
  projectRoot: string,
  entries: Array<{ key: string; value: string; overwrite?: boolean }>
): Promise<void> {
  const envPath = path.join(projectRoot, '.env.config');
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    raw = '';
  }
  const parsed = parseEnvConfig(raw);
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
