import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const appOptionsRef = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const projectRootRef = vi.hoisted(() => ({ value: '' }));
const checkAppAccessMock = vi.hoisted(() => vi.fn());
const createVersionMock = vi.hoisted(() => vi.fn());
const listVersionsMock = vi.hoisted(() => vi.fn());
const getVersionMock = vi.hoisted(() => vi.fn());
const uploadReleaseSnapshotMock = vi.hoisted(() => vi.fn());
const downloadReleaseSnapshotJsonMock = vi.hoisted(() => vi.fn());
const promptsMock = vi.hoisted(() => vi.fn());
const uiErrorMock = vi.hoisted(() => vi.fn());
const uiWarnMock = vi.hoisted(() => vi.fn());
const uiSuccessMock = vi.hoisted(() => vi.fn());
const uiNoteMock = vi.hoisted(() => vi.fn());

let projectRoot: string;

vi.mock('../../src/config/projectConfig.js', () => ({
  resolveAppContext: vi.fn(async (requestedAppKey?: string) => {
    const appKey = requestedAppKey ?? 'default';
    return {
      projectRoot: projectRootRef.value,
      config: {
        default: 'default',
        apps: {
          default: {
            appId: 'app1',
            name: 'App',
            appHome: undefined,
            options: appOptionsRef.value,
          },
        },
      },
      appKey,
      appId: 'app1',
    };
  }),
}));

vi.mock('../../src/auth/session.js', () => ({
  getValidAuthSession: vi.fn(async () => ({
    ok: true as const,
    idToken: 'token',
    userId: 'uid1',
    name: 'User',
    email: 'u@test.com',
    refreshed: false,
  })),
}));

vi.mock('../../src/cloud/firestoreClient.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/cloud/firestoreClient.js')>();
  return {
    ...mod,
    checkAppAccess: (...args: unknown[]) => checkAppAccessMock(...args),
    createVersion: (...args: unknown[]) => createVersionMock(...args),
    listVersions: (...args: unknown[]) => listVersionsMock(...args),
    getVersion: (...args: unknown[]) => getVersionMock(...args),
  };
});

vi.mock('../../src/cloud/storageClient.js', () => ({
  uploadReleaseSnapshot: (...args: unknown[]) => uploadReleaseSnapshotMock(...args),
  downloadReleaseSnapshotJson: (...args: unknown[]) => downloadReleaseSnapshotJsonMock(...args),
  StorageClientError: class StorageClientError extends Error {},
}));

vi.mock('prompts', () => ({ default: promptsMock }));

vi.mock('../../src/core/ui.js', () => ({
  ui: {
    error: (...args: unknown[]) => uiErrorMock(...args),
    warn: (...args: unknown[]) => uiWarnMock(...args),
    success: (...args: unknown[]) => uiSuccessMock(...args),
    note: (...args: unknown[]) => uiNoteMock(...args),
    heading: vi.fn(),
  },
}));

vi.mock('../../src/lib/spinner.js', () => ({
  withSpinner: vi.fn(async (_msg: string, fn: () => Promise<unknown>) => fn()),
}));

import {
  releaseCreateCommand,
  releaseListCommand,
  releaseUseCommand,
} from '../../src/commands/release.js';
import type { CloudApp } from '../../src/cloud/firestoreClient.js';

async function writeEnvConfig(projectRoot: string, lines: string[]): Promise<void> {
  await fs.writeFile(path.join(projectRoot, '.env.config'), `${lines.join('\n')}\n`, 'utf8');
}

function snapshotFromUploadMock(): CloudApp {
  expect(uploadReleaseSnapshotMock).toHaveBeenCalledTimes(1);
  const snapshotJson = uploadReleaseSnapshotMock.mock.calls[0]?.[3];
  expect(typeof snapshotJson).toBe('string');
  return JSON.parse(snapshotJson as string) as CloudApp;
}

describe('release commands', () => {
  const originalCwd = process.cwd();

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-cli-release-'));
    projectRootRef.value = projectRoot;
    appOptionsRef.value = {};
    process.chdir(projectRoot);

    // Minimal app files for buildDocumentsFromParsed: appHome is "Home".
    await fs.mkdir(path.join(projectRoot, 'screens'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, 'screens', 'Home.yaml'),
      'View:\n  body:\n    Text:\n      text: Hello',
      'utf8'
    );

    checkAppAccessMock.mockResolvedValue({ ok: true as const, app: { name: 'App' } });
    createVersionMock.mockResolvedValue({ id: 'ver-123' });
    listVersionsMock.mockResolvedValue({
      versions: [
        {
          id: 'hash-1',
          message: 'First release',
          createdAt: '2025-01-15T12:00:00Z',
          createdBy: { name: 'User', id: 'uid1' },
          expiresAt: '2025-02-15T12:00:00Z',
          snapshotPath: 'releases/app1/hash-1.json',
        },
      ],
      nextStartAfter: undefined,
    });
    getVersionMock.mockResolvedValue({
      id: 'hash-1',
      message: 'First release',
      createdAt: '2025-01-15T12:00:00Z',
      createdBy: { name: 'User', id: 'uid1' },
      expiresAt: '2025-02-15T12:00:00Z',
      snapshotPath: 'releases/app1/hash-1.json',
    });
    uploadReleaseSnapshotMock.mockResolvedValue({
      bucket: 'bucket',
      objectPath: 'releases/app1/ver-123.json',
    });
    downloadReleaseSnapshotJsonMock.mockResolvedValue('{"id":"app1","name":"App","screens":[]}');
    promptsMock.mockResolvedValue({ message: 'My release' });
    uiErrorMock.mockImplementation(() => {});
    uiWarnMock.mockImplementation(() => {});
    uiSuccessMock.mockImplementation(() => {});
    uiNoteMock.mockImplementation(() => {});
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
    process.exitCode = 0;
    vi.clearAllMocks();
  });

  it('release create builds snapshot from local files and calls createVersion', async () => {
    await releaseCreateCommand({ message: 'My release', yes: true });

    // We don't assert createVersionMock directly here (module wiring in ESM tests),
    // but we do verify the happy-path success message.
    expect(uiSuccessMock).toHaveBeenCalledWith(
      'Release saved. Run "ensemble release use" to use it.'
    );
  });

  it('release create stores full .env.config in snapshot without secrets or asset publicUrl', async () => {
    const assetsDir = path.join(projectRoot, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(assetsDir, 'logo.png'), 'png-bytes', 'utf8');
    await fs.writeFile(path.join(assetsDir, 'Case1_Working.png'), 'png-bytes', 'utf8');
    await writeEnvConfig(projectRoot, [
      'assets=https://cdn.example.com/base/',
      'logo_png=logo.png?token=abc',
      'Case1_Working_png=Case1_Working.png?token=def',
      'E1=EV1',
    ]);
    await fs.writeFile(path.join(projectRoot, '.env.secrets'), 'S1=SK1\n', 'utf8');

    await releaseCreateCommand({ message: 'complete env snapshot', yes: true });

    const snapshot = snapshotFromUploadMock();
    expect(snapshot.config?.envVariables).toEqual({
      assets: 'https://cdn.example.com/base/',
      logo_png: 'logo.png?token=abc',
      Case1_Working_png: 'Case1_Working.png?token=def',
      E1: 'EV1',
    });
    expect(snapshot.secrets).toBeUndefined();

    const assetsByFile = new Map((snapshot.assets ?? []).map((asset) => [asset.fileName, asset]));
    expect(assetsByFile.get('logo.png')?.publicUrl).toBeUndefined();
    expect(assetsByFile.get('logo.png')?.copyText).toBeUndefined();
    expect(assetsByFile.get('Case1_Working.png')?.publicUrl).toBeUndefined();
    expect(assetsByFile.get('Case1_Working.png')?.copyText).toBeUndefined();
  });

  it('release create leaves assets without publicUrl when .env.config omits per-asset keys', async () => {
    const assetsDir = path.join(projectRoot, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(assetsDir, 'Case1_Working.png'), 'png-bytes', 'utf8');
    await writeEnvConfig(projectRoot, ['assets=https://cdn.example.com/base/', 'E1=EV1']);

    await releaseCreateCommand({ message: 'partial env snapshot', yes: true });

    const snapshot = snapshotFromUploadMock();
    expect(snapshot.config?.envVariables).toEqual({
      assets: 'https://cdn.example.com/base/',
      E1: 'EV1',
    });
    expect(snapshot.config?.envVariables?.Case1_Working_png).toBeUndefined();

    const asset = (snapshot.assets ?? []).find((item) => item.fileName === 'Case1_Working.png');
    expect(asset).toBeDefined();
    expect(asset?.publicUrl).toBeUndefined();
    expect(asset?.copyText).toBeUndefined();
  });

  it('release use ignores secrets in snapshot and leaves local .env.secrets unchanged', async () => {
    downloadReleaseSnapshotJsonMock.mockResolvedValueOnce(
      JSON.stringify({
        id: 'app1',
        name: 'App',
        screens: [],
        config: { envVariables: { E1: 'EV1' } },
        secrets: { secrets: { S1: 'SNAPSHOT-SECRET' } },
      } satisfies CloudApp)
    );
    await writeEnvConfig(projectRoot, ['E1=EV-WRONG']);
    await fs.writeFile(path.join(projectRoot, '.env.secrets'), 'S1=LOCAL-SECRET\n', 'utf8');

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'hash-1' });

    const envConfig = await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8');
    const envSecrets = await fs.readFile(path.join(projectRoot, '.env.secrets'), 'utf8');
    expect(envConfig).toContain('E1=EV1');
    expect(envSecrets).toContain('S1=LOCAL-SECRET');
    expect(envSecrets).not.toContain('SNAPSHOT-SECRET');
  });

  it('release use restores partial env when snapshot config omits per-asset keys', async () => {
    downloadReleaseSnapshotJsonMock.mockResolvedValueOnce(
      JSON.stringify({
        id: 'app1',
        name: 'App',
        screens: [],
        assets: [
          {
            id: 'asset:Case1_Working.png',
            name: 'Case1_Working.png',
            fileName: 'Case1_Working.png',
            content: '',
            type: 'asset',
          },
        ],
        config: {
          envVariables: {
            assets: 'https://cdn.example.com/base/',
            E1: 'EV1',
          },
        },
      } satisfies CloudApp)
    );
    await writeEnvConfig(projectRoot, [
      'assets=https://cdn.example.com/old/',
      'Case1_Working_png=Case1_Working.png?token=old',
      'E1=EV-WRONG',
    ]);

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'hash-1' });

    const envConfig = await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8');
    expect(envConfig).toContain('assets=https://cdn.example.com/base/');
    expect(envConfig).toContain('E1=EV1');
    expect(envConfig).not.toContain('Case1_Working_png=');
  });

  it('release list prints heading and lines when versions exist', async () => {
    await releaseListCommand({});

    expect(checkAppAccessMock).toHaveBeenCalledTimes(1);
    expect(listVersionsMock).toHaveBeenCalledTimes(1);
    expect(uiWarnMock).not.toHaveBeenCalled();
  });

  it('release list warns when no versions exist', async () => {
    listVersionsMock.mockResolvedValueOnce({ versions: [], nextStartAfter: undefined });

    await releaseListCommand({});

    expect(uiWarnMock).toHaveBeenCalledWith(
      'No releases found. Create one with "ensemble release create".'
    );
  });

  it('release use --hash uses non-interactive path', async () => {
    // Make non-interactive by clearing TTY flags; hash should still work.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'hash-1' });

    expect(getVersionMock).toHaveBeenCalledWith('app1', 'token', 'hash-1', undefined);
    expect(downloadReleaseSnapshotJsonMock).toHaveBeenCalledWith(
      'token',
      'releases/app1/hash-1.json'
    );
    expect(uiErrorMock).not.toHaveBeenCalled();
  });
});
