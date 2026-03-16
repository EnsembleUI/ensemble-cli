import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const appOptionsRef = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const projectRootRef = vi.hoisted(() => ({ value: '' }));
const checkAppAccessMock = vi.hoisted(() => vi.fn());
const listVersionsMock = vi.hoisted(() => vi.fn());
const collectAppFilesMock = vi.hoisted(() => vi.fn());
const applyCloudStateToFsMock = vi.hoisted(() => vi.fn());
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
            appHome: 'Home',
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
    listVersions: (...args: unknown[]) => listVersionsMock(...args),
  };
});

vi.mock('../../src/core/applyToFs.js', () => ({
  applyCloudStateToFs: (...args: unknown[]) => applyCloudStateToFsMock(...args),
}));

vi.mock('../../src/core/appCollector.js', () => ({
  collectAppFiles: (...args: unknown[]) => collectAppFilesMock(...args),
}));

vi.mock('prompts', () => ({ default: promptsMock }));

vi.mock('../../src/core/ui.js', () => ({
  ui: {
    error: (...args: unknown[]) => uiErrorMock(...args),
    warn: (...args: unknown[]) => uiWarnMock(...args),
    success: (...args: unknown[]) => uiSuccessMock(...args),
    note: (...args: unknown[]) => uiNoteMock(...args),
  },
}));

vi.mock('../../src/lib/spinner.js', () => ({
  withSpinner: vi.fn(async (_msg: string, fn: () => Promise<unknown>) => fn()),
}));

import { revertCommand } from '../../src/commands/revert.js';

describe('revert command', () => {
  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'revert-test-'));
    projectRootRef.value = projectRoot;
    appOptionsRef.value = {};
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    checkAppAccessMock.mockResolvedValue({ ok: true as const, app: { name: 'App' } });
    listVersionsMock.mockResolvedValue({
      versions: [
        {
          id: 'ver1',
          message: 'First version',
          createdAt: '2025-01-15T12:00:00Z',
          createdBy: { name: 'User', id: 'uid1' },
          expiresAt: '2025-02-15T12:00:00Z',
          snapshot: { id: 'app1', name: 'App', screens: [], widgets: [], scripts: [], translations: [] },
        },
      ],
      nextStartAfter: undefined,
    });
    collectAppFilesMock.mockResolvedValue({
      screens: {},
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    });
    applyCloudStateToFsMock.mockResolvedValue(undefined);
    promptsMock.mockResolvedValue({ selected: 0 });
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

  it('exits with error when not interactive', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await revertCommand({});

    expect(uiErrorMock).toHaveBeenCalledWith('Revert requires interactive mode to choose a version.');
    expect(process.exitCode).toBe(1);
    expect(checkAppAccessMock).not.toHaveBeenCalled();
  });

  it('exits with error when no app configured for key', async () => {
    const { resolveAppContext } = await import('../../src/config/projectConfig.js');
    vi.mocked(resolveAppContext).mockResolvedValueOnce({
      projectRoot,
      config: { default: 'default', apps: {} },
      appKey: 'missing',
      appId: '',
    } as never);

    await revertCommand({ appKey: 'missing' });

    expect(uiErrorMock).toHaveBeenCalledWith('No app configured for key "missing".');
    expect(process.exitCode).toBe(1);
  });

  it('exits with error when session invalid', async () => {
    const { getValidAuthSession } = await import('../../src/auth/session.js');
    vi.mocked(getValidAuthSession).mockResolvedValueOnce({
      ok: false as const,
      message: 'Not logged in.',
    } as never);

    await revertCommand({});

    expect(uiErrorMock).toHaveBeenCalledWith('Not logged in.');
    expect(process.exitCode).toBe(1);
  });

  it('exits with error when access check fails', async () => {
    checkAppAccessMock.mockResolvedValueOnce({
      ok: false as const,
      reason: 'no_access' as const,
      message: 'You do not have write access.',
    });

    await revertCommand({});

    expect(uiErrorMock).toHaveBeenCalledWith('You do not have write access.');
    expect(process.exitCode).toBe(1);
  });

  it('shows warn and returns when no versions', async () => {
    listVersionsMock.mockResolvedValueOnce({ versions: [], nextStartAfter: undefined });

    await revertCommand({});

    expect(uiWarnMock).toHaveBeenCalledWith(
      'No versions found. Create one with "ensemble push" and choose to save a version.',
    );
    expect(promptsMock).not.toHaveBeenCalled();
  });

  it('calls applyCloudStateToFs with selected version snapshot on success', async () => {
    const snapshot = { id: 'app1', name: 'App', screens: [], widgets: [], scripts: [], translations: [] };
    listVersionsMock.mockResolvedValueOnce({
      versions: [
        {
          id: 'ver1',
          message: 'v1',
          createdAt: '2025-01-15T12:00:00Z',
          createdBy: { name: 'User', id: 'uid1' },
          expiresAt: '2025-02-15T12:00:00Z',
          snapshot,
        },
      ],
      nextStartAfter: undefined,
    });
    promptsMock.mockResolvedValueOnce({ selected: 0 });

    await revertCommand({});

    expect(applyCloudStateToFsMock).toHaveBeenCalledTimes(1);
    const [, appliedSnapshot] = applyCloudStateToFsMock.mock.calls[0]!;
    expect(appliedSnapshot).toEqual(snapshot);
    expect(uiSuccessMock).toHaveBeenCalledWith('Local files reverted. Run "ensemble push" to apply changes to the cloud.');
  });

  it('on FirestoreClientError shows message and hint and sets exit code', async () => {
    const { FirestoreClientError } = await import('../../src/cloud/firestoreClient.js');
    listVersionsMock.mockRejectedValueOnce(
      new FirestoreClientError({
        message: 'List versions failed (403)',
        code: 'PERMISSION_DENIED',
        hint: 'Add a Firestore rule.',
      }),
    );

    await revertCommand({});

    expect(uiErrorMock).toHaveBeenCalledWith('List versions failed (403)');
    expect(uiNoteMock).toHaveBeenCalledWith('Add a Firestore rule.');
    expect(process.exitCode).toBe(1);
  });

  it('on cancel (selected undefined) shows warn and exit code 130', async () => {
    promptsMock.mockResolvedValueOnce({ selected: undefined });

    await revertCommand({});

    expect(uiWarnMock).toHaveBeenCalledWith('Revert cancelled.');
    expect(process.exitCode).toBe(130);
  });
});
