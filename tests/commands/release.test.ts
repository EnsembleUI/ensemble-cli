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
  resolveAppContext: vi.fn(),
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
import { resolveAppContext } from '../../src/config/projectConfig.js';
import type { CloudApp } from '../../src/cloud/firestoreClient.js';
import { EnsembleDocumentType } from '../../src/core/dto.js';

function defaultAppContext(requestedAppKey?: string) {
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
}

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
    vi.mocked(resolveAppContext).mockImplementation(async (requestedAppKey?: string) =>
      defaultAppContext(requestedAppKey)
    );

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

  it('release create stores env config in snapshot without secrets or asset publicUrl', async () => {
    const assetsDir = path.join(projectRoot, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(assetsDir, 'logo.png'), 'png-bytes', 'utf8');
    await fs.writeFile(path.join(assetsDir, 'Case1_Working.png'), 'png-bytes', 'utf8');
    await writeEnvConfig(projectRoot, [
      'assets=https://cdn.example.com/base/',
      'logo_png=logo.png?token=abc',
      'E1=EV1',
    ]);
    await fs.writeFile(path.join(projectRoot, '.env.secrets'), 'S1=SK1\n', 'utf8');

    await releaseCreateCommand({ message: 'env snapshot', yes: true });

    expect(uiSuccessMock).toHaveBeenCalledWith(
      'Release saved. Run "ensemble release use" to use it.'
    );
    const snapshot = snapshotFromUploadMock();
    expect(snapshot.config?.envVariables).toEqual({
      assets: 'https://cdn.example.com/base/',
      logo_png: 'logo.png?token=abc',
      E1: 'EV1',
    });
    expect(snapshot.secrets).toBeUndefined();
    expect(snapshot.config?.envVariables?.Case1_Working_png).toBeUndefined();
    for (const asset of snapshot.assets ?? []) {
      expect(asset.publicUrl).toBeUndefined();
      expect(asset.copyText).toBeUndefined();
    }
  });

  it('release create hints alias-specific use command for non-default app', async () => {
    vi.mocked(resolveAppContext).mockResolvedValueOnce({
      projectRoot,
      config: {
        default: 'dev',
        apps: {
          dev: { appId: 'app-dev', name: 'Dev App' },
          uat: { appId: 'app-uat', name: 'Uat App' },
        },
      },
      appKey: 'uat',
      appId: 'app-uat',
    });

    await releaseCreateCommand({ appKey: 'uat', message: 'uat release', yes: true });

    expect(uiSuccessMock).toHaveBeenCalledWith(
      'Release saved. Run "ensemble release use --app uat" to use it.'
    );
  });

  it('release create passes the same version id to storage upload and Firestore', async () => {
    await releaseCreateCommand({ message: 'sync ids', yes: true });

    const uploadVersionId = uploadReleaseSnapshotMock.mock.calls[0]?.[2];
    const createParams = createVersionMock.mock.calls[0]?.[2] as { id: string };
    expect(typeof uploadVersionId).toBe('string');
    expect(createParams.id).toBe(uploadVersionId);
  });

  it('release use restores config to scoped alias file for non-default app', async () => {
    vi.mocked(resolveAppContext).mockResolvedValueOnce({
      projectRoot,
      config: {
        default: 'dev',
        apps: {
          dev: { appId: 'app-dev', name: 'Dev App' },
          uat: { appId: 'app-uat', name: 'Uat App' },
        },
      },
      appKey: 'uat',
      appId: 'app-uat',
    });
    getVersionMock.mockResolvedValue({
      id: 'hash-1',
      message: 'Uat release',
      createdAt: '2025-01-15T12:00:00Z',
      createdBy: { name: 'User', id: 'uid1' },
      expiresAt: '2025-02-15T12:00:00Z',
      snapshotPath: 'releases/app-uat/hash-1.json',
    });
    downloadReleaseSnapshotJsonMock.mockResolvedValueOnce(
      JSON.stringify({
        id: 'app-uat',
        name: 'Uat App',
        screens: [],
        config: { envVariables: { E1: 'UAT-EV1' } },
      } satisfies CloudApp)
    );
    await fs.writeFile(path.join(projectRoot, '.env.config'), 'E1=dev\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.env.config.uat'), 'E1=old-uat\n', 'utf8');

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ appKey: 'uat', hash: 'hash-1' });

    const baseConfig = await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8');
    const uatConfig = await fs.readFile(path.join(projectRoot, '.env.config.uat'), 'utf8');
    expect(baseConfig).toContain('E1=dev');
    expect(uatConfig).toContain('E1=UAT-EV1');
    expect(uatConfig).not.toContain('old-uat');
  });

  it('release use hints alias-specific push command for non-default app', async () => {
    vi.mocked(resolveAppContext).mockResolvedValueOnce({
      projectRoot,
      config: {
        default: 'dev',
        apps: {
          dev: { appId: 'app-dev', name: 'Dev App' },
          uat: { appId: 'app-uat', name: 'Uat App' },
        },
      },
      appKey: 'uat',
      appId: 'app-uat',
    });
    downloadReleaseSnapshotJsonMock.mockResolvedValueOnce(
      JSON.stringify({
        id: 'app-uat',
        name: 'Uat App',
        screens: [],
        config: { envVariables: { E1: 'UAT-EV1' } },
      } satisfies CloudApp)
    );

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ appKey: 'uat', hash: 'hash-1' });

    expect(uiSuccessMock).toHaveBeenCalledWith(
      'Local files updated to selected release. Run "ensemble push --app uat" to apply to the cloud.'
    );
  });

  it('release use restores snapshot config and never touches secrets', async () => {
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
            type: EnsembleDocumentType.Asset,
          },
        ],
        config: { envVariables: { assets: 'https://cdn.example.com/base/', E1: 'EV1' } },
        secrets: { secrets: { S1: 'SNAPSHOT-SECRET' } },
      } satisfies CloudApp)
    );
    await writeEnvConfig(projectRoot, [
      'assets=https://cdn.example.com/old/',
      'Case1_Working_png=Case1_Working.png?token=old',
      'E1=EV-WRONG',
    ]);
    await fs.writeFile(path.join(projectRoot, '.env.secrets'), 'S1=LOCAL-SECRET\n', 'utf8');

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'hash-1' });

    const envConfig = await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8');
    const envSecrets = await fs.readFile(path.join(projectRoot, '.env.secrets'), 'utf8');
    expect(envConfig).toContain('assets=https://cdn.example.com/base/');
    expect(envConfig).toContain('E1=EV1');
    expect(envConfig).not.toContain('Case1_Working_png=');
    expect(envSecrets).toContain('S1=LOCAL-SECRET');
    expect(envSecrets).not.toContain('SNAPSHOT-SECRET');
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

  it('release use interactive picker omits hash from release labels', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    promptsMock.mockResolvedValueOnce({ selected: 0 });

    await releaseUseCommand({});

    const promptArgs = promptsMock.mock.calls[0]?.[0] as {
      choices: { title: string; value: number | string }[];
    };
    expect(promptArgs.choices[0]?.title).toContain('First release');
    expect(promptArgs.choices[0]?.title).not.toContain('[hash:');
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
