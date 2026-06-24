import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let projectRoot: string;

const projectConfigMock = vi.hoisted(() => ({
  loadProjectConfig: vi.fn(async () => ({
    projectRoot,
    config: {
      default: 'dev',
      apps: {
        dev: { appId: 'app-1' },
      },
    },
  })),
  resolveAppContext: vi.fn(async () => ({
    projectRoot,
    config: {
      default: 'dev',
      apps: {
        dev: { appId: 'app-1' },
      },
    },
    appKey: 'dev',
    appId: 'app-1',
  })),
}));

vi.mock('../../src/config/projectConfig.js', () => projectConfigMock);

import { addCommand } from '../../src/commands/add.js';

describe('addCommand asset', () => {
  const originalCwd = process.cwd();

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-cli-add-asset-'));
    process.chdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, 'ensemble.config.json'),
      '{"default":"dev","apps":{}}'
    );
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(projectRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('copies asset locally and writes stub .env.config keys without cloud upload', async () => {
    const sourceFile = path.join(projectRoot, 'logo.png');
    await fs.writeFile(sourceFile, Buffer.from([1, 2, 3, 4]));

    await addCommand('asset', sourceFile);

    const copied = await fs.readFile(path.join(projectRoot, 'assets', 'logo.png'));
    expect(copied.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);

    const envConfig = await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8');
    expect(envConfig).toContain('logo_png=logo.png');
    expect(envConfig).not.toContain('token=');
    expect(envConfig.includes('\n\n')).toBe(false);
  });

  it('accepts a quoted asset path (common copy/paste)', async () => {
    const sourceFile = path.join(projectRoot, 'Wifi password.json');
    await fs.writeFile(sourceFile, Buffer.from([1, 2, 3]));

    await addCommand('asset', `'${sourceFile}'`);

    const copied = await fs.readFile(path.join(projectRoot, 'assets', 'Wifi password.json'));
    expect(copied.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('preserves existing assets key and appends local env variable key', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.env.config'),
      ['assets=https://existing.example.com/base/', 'EXTRA=value'].join('\n') + '\n',
      'utf8'
    );
    const sourceFile = path.join(projectRoot, 'logo2.png');
    await fs.writeFile(sourceFile, Buffer.from([5, 6, 7]));

    await addCommand('asset', sourceFile);

    const envConfig = await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8');
    expect(envConfig).toContain('assets=https://existing.example.com/base/');
    expect(envConfig).toContain('EXTRA=value');
    expect(envConfig).toContain('logo2_png=logo2.png');
  });

  it('errors when asset already exists (non-interactive)', async () => {
    const sourceFile = path.join(projectRoot, 'logo.png');
    await fs.writeFile(sourceFile, Buffer.from([1, 2, 3, 4]));
    await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'assets', 'logo.png'), Buffer.from([9]));

    await expect(addCommand('asset', sourceFile)).rejects.toThrow(/already exists/i);
  });

  it('overwrites existing asset when --overwrite is set', async () => {
    const sourceFile = path.join(projectRoot, 'logo.png');
    await fs.writeFile(sourceFile, Buffer.from([1, 2, 3, 4]));
    await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'assets', 'logo.png'), Buffer.from([9]));

    await addCommand('asset', sourceFile, { overwrite: true });

    const copied = await fs.readFile(path.join(projectRoot, 'assets', 'logo.png'));
    expect(copied.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });
});
