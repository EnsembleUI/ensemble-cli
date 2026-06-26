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
import { encryptReleaseSnapshot, parseReleaseSnapshotBody } from '../../src/core/encryption.js';
import { TEST_ENCRYPTION_KEY } from '../core/encryption.test.js';

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

async function writeEncryptionKey(root: string, alias?: string): Promise<void> {
  const secretsFile = alias ? `.env.secrets.${alias}` : '.env.secrets';
  await fs.writeFile(
    path.join(root, secretsFile),
    `ENSEMBLE_ENCRYPTION_KEY=${TEST_ENCRYPTION_KEY}\n`,
    'utf8'
  );
}

function snapshotFromUploadMock(): CloudApp {
  expect(uploadReleaseSnapshotMock).toHaveBeenCalledTimes(1);
  const body = uploadReleaseSnapshotMock.mock.calls[0]?.[3];
  const envelopeJson = typeof body === 'string' ? body : (body as Buffer).toString('utf8');
  const snapshotJson = parseReleaseSnapshotBody(
    envelopeJson,
    'releases/app1/ver.enc.json',
    TEST_ENCRYPTION_KEY
  );
  return JSON.parse(snapshotJson) as CloudApp;
}

function mockEncryptedSnapshot(snapshot: CloudApp): string {
  return encryptReleaseSnapshot(JSON.stringify(snapshot), TEST_ENCRYPTION_KEY);
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

    await fs.mkdir(path.join(projectRoot, 'screens'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, 'screens', 'Home.yaml'),
      'View:\n  body:\n    Text:\n      text: Hello',
      'utf8'
    );
    await writeEncryptionKey(projectRoot);

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
          snapshotPath: 'releases/app1/hash-1.enc.json',
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
      snapshotPath: 'releases/app1/hash-1.enc.json',
    });
    uploadReleaseSnapshotMock.mockResolvedValue({
      bucket: 'bucket',
      objectPath: 'releases/app1/ver-123.enc.json',
    });
    downloadReleaseSnapshotJsonMock.mockReset();
    downloadReleaseSnapshotJsonMock.mockResolvedValue(
      mockEncryptedSnapshot({ id: 'app1', name: 'App', screens: [] })
    );
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

  it('release create blocks when ENSEMBLE_ENCRYPTION_KEY is missing', async () => {
    await fs.rm(path.join(projectRoot, '.env.secrets'));

    await releaseCreateCommand({ message: 'missing key', yes: true });

    expect(uploadReleaseSnapshotMock).not.toHaveBeenCalled();
    expect(uiErrorMock).toHaveBeenCalledWith(expect.stringContaining('Releases are encrypted'));
    expect(uiNoteMock).toHaveBeenCalledWith(expect.stringContaining('openssl rand -hex 32'));
    expect(process.exitCode).toBe(1);
  });

  it('release create stores env config and secrets in encrypted snapshot', async () => {
    const assetsDir = path.join(projectRoot, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(assetsDir, 'logo.png'), 'png-bytes', 'utf8');
    await writeEnvConfig(projectRoot, ['E1=EV1']);
    await fs.appendFile(path.join(projectRoot, '.env.secrets'), 'S1=SK1\n', 'utf8');

    await releaseCreateCommand({ message: 'env snapshot', yes: true });

    const snapshot = snapshotFromUploadMock();
    expect(snapshot.config?.envVariables).toEqual({ E1: 'EV1' });
    expect(snapshot.secrets?.secrets).toMatchObject({
      ENSEMBLE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      S1: 'SK1',
    });
  });

  it('release create stores manifest list order in snapshot', async () => {
    await fs.mkdir(path.join(projectRoot, 'widgets'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'translations'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'widgets', 'Wid2.yaml'), 'View:\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'widgets', 'Wid1.yaml'), 'View:\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'translations', 'en.yaml'), 'k: v\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'translations', 'ar.yaml'), 'k: v\n', 'utf8');
    await fs.writeFile(
      path.join(projectRoot, '.manifest.json'),
      `${JSON.stringify(
        {
          widgets: [{ name: 'Wid1' }, { name: 'Wid2' }],
          languages: ['ar', 'en'],
          defaultLanguage: 'ar',
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    await releaseCreateCommand({ message: 'manifest order', yes: true });

    const snapshot = snapshotFromUploadMock();
    expect(snapshot.widgets?.map((widget) => widget.name)).toEqual(['Wid1', 'Wid2']);
    expect(snapshot.translations?.map((t) => t.name)).toEqual(['ar', 'en']);
    expect(snapshot.translations?.find((t) => t.defaultLocale)?.name).toBe('ar');
  });

  it('release create then use leaves manifest unchanged', async () => {
    await fs.mkdir(path.join(projectRoot, 'widgets'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'widgets', 'Wid2.yaml'), 'View:\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'widgets', 'Wid1.yaml'), 'View:\n', 'utf8');
    const manifestBefore = {
      studioVersion: 2,
      actions: [],
      widgets: [{ name: 'Wid1', customId: 'local-id' }, { name: 'Wid2' }],
    };
    const manifestRaw = `${JSON.stringify(manifestBefore, null, 2)}\n`;
    await fs.writeFile(path.join(projectRoot, '.manifest.json'), manifestRaw, 'utf8');

    await releaseCreateCommand({ message: 'roundtrip', yes: true });
    const snapshot = snapshotFromUploadMock();

    downloadReleaseSnapshotJsonMock.mockResolvedValueOnce(
      encryptReleaseSnapshot(JSON.stringify(snapshot), TEST_ENCRYPTION_KEY)
    );

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'hash-1' });

    const manifestAfter = await fs.readFile(path.join(projectRoot, '.manifest.json'), 'utf8');
    expect(manifestAfter).toBe(manifestRaw);
  });

  it('release use restores latest manifest after visiting older release', async () => {
    const olderSnapshot = mockEncryptedSnapshot({
      id: 'app1',
      name: 'App',
      screens: [],
      translations: [
        {
          id: 't-en',
          name: 'en',
          content: 'hello: hello',
          type: EnsembleDocumentType.I18n,
          defaultLocale: true,
        },
        {
          id: 't-ar',
          name: 'ar',
          content: 'hello: marhaba',
          type: EnsembleDocumentType.I18n,
        },
      ],
    });
    const latestSnapshot = mockEncryptedSnapshot({
      id: 'app1',
      name: 'App',
      screens: [],
      translations: [
        {
          id: 't-en',
          name: 'en',
          content: 'hello: hello',
          type: EnsembleDocumentType.I18n,
        },
        {
          id: 't-de',
          name: 'de',
          content: 'hello: hallo',
          type: EnsembleDocumentType.I18n,
        },
        {
          id: 't-ar',
          name: 'ar',
          content: 'hello: marhaba',
          type: EnsembleDocumentType.I18n,
          defaultLocale: true,
        },
      ],
    });

    await fs.mkdir(path.join(projectRoot, 'translations'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'translations', 'en.yaml'), 'hello: hello\n', 'utf8');
    await fs.writeFile(
      path.join(projectRoot, 'translations', 'ar.yaml'),
      'hello: marhaba\n',
      'utf8'
    );
    await fs.writeFile(path.join(projectRoot, 'translations', 'de.yaml'), 'hello: hallo\n', 'utf8');

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    let downloadCall = 0;
    downloadReleaseSnapshotJsonMock.mockImplementation(async () => {
      downloadCall += 1;
      return downloadCall === 1 ? olderSnapshot : latestSnapshot;
    });
    await releaseUseCommand({ hash: 'hash-old' });
    await releaseUseCommand({ hash: 'hash-latest' });

    expect(downloadCall).toBe(2);

    const manifestAfter = JSON.parse(
      await fs.readFile(path.join(projectRoot, '.manifest.json'), 'utf8')
    ) as { languages: string[]; defaultLanguage: string };
    expect(manifestAfter.languages).toEqual(['en', 'de', 'ar']);
    expect(manifestAfter.defaultLanguage).toBe('ar');
    await expect(
      fs.access(path.join(projectRoot, 'translations', 'de.yaml'))
    ).resolves.toBeUndefined();
  });

  it('release use blocks when ENSEMBLE_ENCRYPTION_KEY is missing', async () => {
    await fs.rm(path.join(projectRoot, '.env.secrets'));
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'hash-1' });

    expect(getVersionMock).not.toHaveBeenCalled();
    expect(downloadReleaseSnapshotJsonMock).not.toHaveBeenCalled();
    expect(uiErrorMock).toHaveBeenCalledWith(expect.stringContaining('Releases are encrypted'));
    expect(uiNoteMock).toHaveBeenCalledWith(expect.stringContaining('openssl rand -hex 32'));
    expect(process.exitCode).toBe(1);
  });

  it('release list blocks when ENSEMBLE_ENCRYPTION_KEY is missing', async () => {
    await fs.rm(path.join(projectRoot, '.env.secrets'));

    await releaseListCommand({});

    expect(listVersionsMock).not.toHaveBeenCalled();
    expect(uiErrorMock).toHaveBeenCalledWith(expect.stringContaining('Releases are encrypted'));
    expect(uiNoteMock).toHaveBeenCalledWith(expect.stringContaining('openssl rand -hex 32'));
    expect(process.exitCode).toBe(1);
  });

  it('release use restores snapshot config and secrets', async () => {
    downloadReleaseSnapshotJsonMock.mockResolvedValueOnce(
      mockEncryptedSnapshot({
        id: 'app1',
        name: 'App',
        screens: [],
        config: { envVariables: { E1: 'EV1' } },
        secrets: { secrets: { S1: 'SNAPSHOT-SECRET' } },
      })
    );
    await writeEnvConfig(projectRoot, ['E1=EV-WRONG']);
    await fs.appendFile(path.join(projectRoot, '.env.secrets'), 'S1=LOCAL-SECRET\n', 'utf8');

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'hash-1' });

    const envConfig = await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8');
    const envSecrets = await fs.readFile(path.join(projectRoot, '.env.secrets'), 'utf8');
    expect(envConfig).toContain('E1=EV1');
    expect(envSecrets).toContain('S1=SNAPSHOT-SECRET');
    expect(envSecrets).not.toContain('LOCAL-SECRET');
  });

  it('release use removes env keys not in snapshot', async () => {
    await writeEnvConfig(projectRoot, ['A1=a', 'E1=local-only', 'B1=b']);
    downloadReleaseSnapshotJsonMock.mockResolvedValueOnce(
      mockEncryptedSnapshot({
        id: 'app1',
        name: 'App',
        screens: [],
        config: { envVariables: { A1: 'a', B1: 'b' } },
      })
    );

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'hash-1' });

    const lines = (await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8'))
      .trim()
      .split('\n');
    expect(lines).toEqual(['A1=a', 'B1=b']);
  });

  it('release use writes canonical asset-then-config layout', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.env.config'),
      'assets=https://old/\nkwnd_png=old.png\nE1=old\n',
      'utf8'
    );

    downloadReleaseSnapshotJsonMock.mockResolvedValueOnce(
      mockEncryptedSnapshot({
        id: 'app1',
        name: 'App',
        screens: [],
        assets: [
          {
            id: 'asset-kwnd',
            name: 'kwnd.png',
            fileName: 'kwnd.png',
            content: '',
            type: EnsembleDocumentType.Asset,
          },
        ],
        config: {
          envVariables: {
            E1: 'EV1',
            assets: 'https://new/',
            kwnd_png: 'new.png',
          },
        },
      })
    );

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'hash-1' });

    const lines = (await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8'))
      .trim()
      .split('\n');
    expect(lines[0]).toMatch(/^assets=https:\/\/new\//);
    expect(lines[1]).toMatch(/^kwnd_png=new\.png$/);
    expect(lines[2]).toMatch(/^E1=EV1$/);
  });

  it('release use rejects legacy plain json snapshots', async () => {
    getVersionMock.mockResolvedValueOnce({
      id: 'legacy-1',
      message: 'Legacy',
      createdAt: '2025-01-15T12:00:00Z',
      createdBy: { name: 'User', id: 'uid1' },
      expiresAt: '2025-02-15T12:00:00Z',
      snapshotPath: 'releases/app1/legacy-1.json',
    });
    downloadReleaseSnapshotJsonMock.mockResolvedValueOnce(
      JSON.stringify({ id: 'app1', name: 'App', screens: [] })
    );

    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'legacy-1' });

    expect(uiErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('unencrypted legacy plaintext')
    );
    expect(process.exitCode).toBe(1);
  });

  it('release use --hash downloads from storage directly', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await releaseUseCommand({ hash: 'hash-1' });

    expect(downloadReleaseSnapshotJsonMock).toHaveBeenCalledWith(
      'token',
      'releases/app1/hash-1.enc.json'
    );
    expect(uiErrorMock).not.toHaveBeenCalled();
  });

  it('release list warns when no versions exist', async () => {
    listVersionsMock.mockResolvedValueOnce({ versions: [], nextStartAfter: undefined });
    await releaseListCommand({});
    expect(uiWarnMock).toHaveBeenCalledWith(
      'No releases found. Create one with "ensemble release create".'
    );
  });
});
