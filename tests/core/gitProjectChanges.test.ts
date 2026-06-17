import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectGitWorkspaceChanges,
  snapshotGitWorkspace,
} from '../../src/core/gitProjectChanges.js';

function initGitRepo(repoDir: string): void {
  execFileSync('git', ['init'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'ensemble-cli-test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Ensemble CLI Test'], { cwd: repoDir });
}

describe('gitProjectChanges', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-git-changes-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null snapshot when project is not a git repo', async () => {
    await fs.writeFile(path.join(tmpDir, 'pubspec.yaml'), 'name: demo\n');
    await expect(snapshotGitWorkspace(tmpDir)).resolves.toBeNull();
    await expect(collectGitWorkspaceChanges(tmpDir, null)).resolves.toEqual([]);
  });

  it('detects tracked file changes in a real git repo', async () => {
    const pubspecPath = path.join(tmpDir, 'pubspec.yaml');
    await fs.writeFile(pubspecPath, 'name: demo\n');

    initGitRepo(tmpDir);
    execFileSync('git', ['add', 'pubspec.yaml'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const before = await snapshotGitWorkspace(tmpDir);
    expect(before).not.toBeNull();

    await fs.writeFile(pubspecPath, 'name: demo\ndependencies:\n  ensemble: any\n');
    const modified = await collectGitWorkspaceChanges(tmpDir, before);
    expect(modified).toContain('pubspec.yaml');
  });
});
