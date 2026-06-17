import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { fileExists } from './fs.js';

const execFileAsync = promisify(execFile);
const GIT_BUFFER = 10 * 1024 * 1024;

async function hashFile(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function isGitRepository(projectRoot: string): Promise<boolean> {
  return fileExists(path.join(projectRoot, '.git'));
}

async function listGitWorkspacePaths(projectRoot: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    execFileAsync('git', ['-C', projectRoot, 'ls-files'], { maxBuffer: GIT_BUFFER }),
    execFileAsync('git', ['-C', projectRoot, 'ls-files', '--others', '--exclude-standard'], {
      maxBuffer: GIT_BUFFER,
    }),
  ]);

  return [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split('\n').filter(Boolean))];
}

export async function snapshotGitWorkspace(
  projectRoot: string
): Promise<Map<string, string> | null> {
  if (!(await isGitRepository(projectRoot))) return null;

  const snapshot = new Map<string, string>();
  await Promise.all(
    (await listGitWorkspacePaths(projectRoot)).map(async (relativePath) => {
      const absolute = path.join(projectRoot, relativePath);
      if (!(await fileExists(absolute))) return;
      if (!(await fs.stat(absolute)).isFile()) return;
      snapshot.set(relativePath, await hashFile(absolute));
    })
  );
  return snapshot;
}

function diffGitSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const relativePath of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(relativePath) !== after.get(relativePath)) changed.push(relativePath);
  }
  return changed.sort();
}

export async function collectGitWorkspaceChanges(
  projectRoot: string,
  before: Map<string, string> | null
): Promise<string[]> {
  if (!before) return [];
  const after = await snapshotGitWorkspace(projectRoot);
  return after ? diffGitSnapshots(before, after) : [];
}
