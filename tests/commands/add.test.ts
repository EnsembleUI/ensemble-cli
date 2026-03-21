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

const authSessionMock = vi.hoisted(() => ({
  getValidAuthSession: vi.fn(async () => ({
    ok: true as const,
    idToken: 'id-token',
    userId: 'user-1',
    refreshed: false,
  })),
}));

vi.mock('../../src/auth/session.js', () => authSessionMock);

const assetClientMock = vi.hoisted(() => ({
  uploadAssetToStudio: vi.fn(async () => ({
    success: true,
    assetBaseUrl: 'https://cdn.example.com/assets/',
    envVariable: {
      key: 'image_2_png',
      value: 'image-2.png?alt=media&token=abc',
    },
    usageKey: '${env.assets}${env.image_2_png}',
  })),
}));

vi.mock('../../src/cloud/assetClient.js', () => assetClientMock);

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

  it('copies asset, uploads it, and writes .env.config keys', async () => {
    const sourceFile = path.join(projectRoot, 'logo.png');
    await fs.writeFile(sourceFile, Buffer.from([1, 2, 3, 4]));

    await addCommand('asset', sourceFile);

    const copied = await fs.readFile(path.join(projectRoot, 'assets', 'logo.png'));
    expect(copied.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);

    const uploadMock = assetClientMock.uploadAssetToStudio as ReturnType<typeof vi.fn>;
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0]?.[0]).toBe('app-1');
    expect(uploadMock.mock.calls[0]?.[1]).toBe('logo.png');
    expect(typeof uploadMock.mock.calls[0]?.[2]).toBe('string');
    expect(uploadMock.mock.calls[0]?.[3]).toBe('id-token');

    const envConfig = await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8');
    expect(envConfig).toContain('assets=https://cdn.example.com/assets/');
    expect(envConfig).toContain('image_2_png=image-2.png?alt=media&token=abc');
    expect(envConfig.includes('\n\n')).toBe(false);
  });

  it('preserves existing assets key and appends env variable key', async () => {
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
    expect(envConfig).toContain('image_2_png=image-2.png?alt=media&token=abc');
  });
});
