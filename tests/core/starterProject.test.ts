import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveStarterProjectRoot } from '../../src/core/starterProject.js';

describe('starterProject', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-starter-project-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeStarterLayout(root: string): Promise<void> {
    await fs.mkdir(path.join(root, 'ensemble'), { recursive: true });
    await fs.mkdir(path.join(root, 'lib', 'generated'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'pubspec.yaml'),
      'name: demo\ndependencies:\n  ensemble:\n    git:\n      url: https://github.com/EnsembleUI/ensemble.git\n'
    );
    await fs.writeFile(path.join(root, 'ensemble', 'ensemble.properties'), 'appId=demo\n');
    await fs.writeFile(path.join(root, 'lib', 'generated', 'ensemble_modules.dart'), '// generated\n');
  }

  it('resolves starter root from cwd or parent directories', async () => {
    await writeStarterLayout(tmpDir);
    const nested = path.join(tmpDir, 'apps', 'mobile');
    await fs.mkdir(nested, { recursive: true });
    process.chdir(nested);

    const root = await resolveStarterProjectRoot();
    expect(await fs.realpath(root)).toBe(await fs.realpath(tmpDir));
  });

  it('throws when starter markers are missing', async () => {
    await expect(resolveStarterProjectRoot()).rejects.toThrow(/Could not find an Ensemble starter project/);
  });

  it('throws when explicit project path is invalid', async () => {
    await expect(resolveStarterProjectRoot(tmpDir)).rejects.toThrow(
      /This does not look like an Ensemble starter project/
    );
  });
});
