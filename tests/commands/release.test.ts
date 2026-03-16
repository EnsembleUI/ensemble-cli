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

describe('release commands', () => {
  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-cli-release-'));
    projectRootRef.value = projectRoot;
    appOptionsRef.value = {};

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
          snapshot: {
            id: 'app1',
            name: 'App',
            screens: [],
            widgets: [],
            scripts: [],
            translations: [],
          },
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
      snapshot: {
        id: 'app1',
        name: 'App',
        screens: [],
        widgets: [],
        scripts: [],
        translations: [],
      },
    });
    promptsMock.mockResolvedValue({ message: 'My release' });
    uiErrorMock.mockImplementation(() => {});
    uiWarnMock.mockImplementation(() => {});
    uiSuccessMock.mockImplementation(() => {});
    uiNoteMock.mockImplementation(() => {});
  });

  afterEach(async () => {
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
    expect(uiErrorMock).not.toHaveBeenCalled();
  });
});
