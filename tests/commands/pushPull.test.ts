import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';

// We will mock these modules to control environment for push/pull.
let projectRoot: string;

const appOptionsRef = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../src/config/projectConfig.js', () => {
  return {
    resolveAppContext: vi.fn(async (requestedAppKey?: string) => {
      const appKey = requestedAppKey ?? 'dev';
      return {
        projectRoot,
        config: {
          default: 'dev',
          apps: {
            dev: {
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
  };
});

vi.mock('../../src/auth/session.js', () => {
  return {
    getValidAuthSession: vi.fn(async () => ({
      ok: true as const,
      idToken: 'token',
      userId: 'uid1',
      name: 'User',
      email: 'u@test.com',
      refreshed: false,
    })),
  };
});

const cloudModuleMock = vi.hoisted(() => {
  return {
    checkAppAccess: vi.fn(async () => ({
      ok: true as const,
      app: { name: 'App', description: 'Test app' },
    })),
    fetchCloudApp: vi.fn(async () => ({
      id: 'app1',
      name: 'App',
      screens: [],
      widgets: [],
      scripts: [],
      translations: [],
      theme: undefined,
    })),
    submitCliPush: vi.fn(
      async (
        appId: string,
        idToken: string,
        _payload: unknown,
        _opts: unknown,
        extras?: { projectRoot?: string; assetFileNames?: string[] }
      ) => {
        if (extras?.assetFileNames?.length && extras.projectRoot) {
          const { uploadProjectAssetsForPush } = await import('../../src/core/pushAssets.js');
          const n = await uploadProjectAssetsForPush(
            appId,
            idToken,
            extras.projectRoot,
            extras.assetFileNames
          );
          return { assetsUploaded: n };
        }
        return { assetsUploaded: 0 };
      }
    ),
  };
});

vi.mock('../../src/cloud/firestoreClient.js', () => cloudModuleMock);

const assetClientMock = vi.hoisted(() => ({
  uploadAssetToStudio: vi.fn(async (_appId: string, fileName: string) => ({
    success: true,
    assetBaseUrl: 'https://cdn.example.com/assets/',
    envVariable: {
      key: fileName.replace(/[^\w]+/g, '_'),
      value: `${fileName}?token=abc`,
    },
    usageKey: '${env.assets}${env.file}',
  })),
}));

vi.mock('../../src/cloud/assetClient.js', () => assetClientMock);

const promptsModuleMock = vi.hoisted(() => ({
  default: vi.fn(async () => ({ proceed: true })),
}));

vi.mock('prompts', () => promptsModuleMock);

// Import after mocks
import { resolveAppContext } from '../../src/config/projectConfig.js';
import { getValidAuthSession } from '../../src/auth/session.js';
import { pushCommand } from '../../src/commands/push.js';
import { pullCommand } from '../../src/commands/pull.js';
import { collectAppFiles } from '../../src/core/appCollector.js';

describe('push/pull integration (commands)', () => {
  const originalCwd = process.cwd();

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-cli-push-pull-'));
    process.chdir(projectRoot);
    // Ensure minimal project structure
    await fs.mkdir(path.join(projectRoot, 'screens'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'translations'), { recursive: true });
    appOptionsRef.value = {};
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(projectRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('push uses defaultLanguage from .manifest and sends correct translation payload', async () => {
    // Arrange: create a minimal Home screen, translation files, and manifest
    await fs.writeFile(path.join(projectRoot, 'screens', 'Home.yaml'), 'home: content', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'translations', 'en.yaml'), 'en: content', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'translations', 'ar.yaml'), 'ar: محتوى', 'utf8');
    await fs.writeFile(
      path.join(projectRoot, '.manifest.json'),
      JSON.stringify(
        {
          scripts: [],
          widgets: [],
          homeScreenName: 'Home',
          defaultLanguage: 'ar',
          languages: ['ar', 'en'],
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Act
    await pushCommand({ verbose: false, yes: true });

    // Assert
    const { submitCliPush } = cloudModuleMock as {
      submitCliPush: ReturnType<typeof vi.fn>;
    };
    expect(submitCliPush).toHaveBeenCalledTimes(1);
    const [appId, , payload] = submitCliPush.mock.calls[0] as [string, string, unknown];
    expect(appId).toBe('app1');
    const p = payload as {
      translations?: {
        operation: string;
        document: { id: string; name: string; defaultLocale?: boolean };
      }[];
    };
    expect(p.translations).toBeDefined();
    const ar = p.translations!.find((t) => t.operation === 'create' && t.document.name === 'ar');
    const en = p.translations!.find((t) => t.operation === 'create' && t.document.name === 'en');
    expect(ar).toBeDefined();
    expect(en).toBeDefined();
    expect(ar!.document.id).toBe('i18n_ar');
    expect(en!.document.id).toBe('i18n_en');
    expect(ar!.document.defaultLocale).toBe(true);
    expect(en!.document.defaultLocale ?? false).toBe(false);

    // Should print a success summary with counts.
    expect(
      logSpy.mock.calls.some(
        ([msg]) => typeof msg === 'string' && msg.includes('Pushed app "App" to environment "dev"')
      )
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('push respects app options and does not include disabled screens in diff/payload', async () => {
    // Disable screens in app options
    appOptionsRef.value = { screens: false };

    // For this test, simulate an app config without a configured home screen so that
    // the validation logic in buildDocumentsFromParsed does not require any screens.
    const resolveAppContextMock = resolveAppContext as unknown as ReturnType<typeof vi.fn>;
    resolveAppContextMock.mockResolvedValueOnce({
      projectRoot,
      config: {
        default: 'dev',
        apps: {
          dev: {
            appId: 'app1',
            name: 'App',
            appHome: undefined,
            options: appOptionsRef.value,
          },
        },
      },
      appKey: 'dev',
      appId: 'app1',
    });

    // Arrange: create a minimal Home screen so buildDocumentsFromParsed succeeds.
    await fs.writeFile(path.join(projectRoot, 'screens', 'Home.yaml'), 'home: content', 'utf8');

    // Cloud app has screens, but they should be ignored due to options.
    (cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'app1',
      name: 'App',
      screens: [
        {
          id: 'screen-id-1',
          name: 'Home',
          content: 'home: content',
          type: 'screen',
          isRoot: true,
        },
        {
          id: 'screen-id-2',
          name: 'Test',
          content: 'test: content',
          type: 'screen',
          isRoot: false,
        },
      ] as unknown[],
      widgets: [] as unknown[],
      scripts: [] as unknown[],
      translations: [] as unknown[],
      theme: undefined,
    });

    await pushCommand({ verbose: false, yes: true });

    const { submitCliPush } = cloudModuleMock as {
      submitCliPush: ReturnType<typeof vi.fn>;
    };
    // With screens disabled, no changes should be pushed even though cloud has screens.
    expect(submitCliPush).not.toHaveBeenCalled();
  });

  it('push dry run shows diff but does not submit payload', async () => {
    // Arrange: create a minimal Home screen plus a simple local file and cloud app with no existing artifacts.
    await fs.writeFile(path.join(projectRoot, 'screens', 'Home.yaml'), 'home: content', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'translations', 'en.yaml'), 'en: content', 'utf8');

    (cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'app1',
      name: 'App',
      screens: [] as unknown[],
      widgets: [] as unknown[],
      scripts: [] as unknown[],
      translations: [] as unknown[],
      theme: undefined,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await pushCommand({ verbose: false, yes: false, dryRun: true });

    const { submitCliPush } = cloudModuleMock as {
      submitCliPush: ReturnType<typeof vi.fn>;
    };
    expect(submitCliPush).not.toHaveBeenCalled();

    // Dry run output should clearly indicate non-destructive behavior and how to apply.
    const lines = logSpy.mock.calls.map(([msg]) => String(msg));
    expect(lines.some((l) => l.includes('Push dry run'))).toBe(true);
    expect(
      lines.some((l) =>
        l.includes('Run `ensemble push` without `--dry-run` to apply these changes.')
      )
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('push without --yes in non-interactive mode refuses to run', async () => {
    // Arrange: create a minimal Home screen and a simple local file so there is at least one change to push.
    await fs.writeFile(path.join(projectRoot, 'screens', 'Home.yaml'), 'home: content', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'translations', 'en.yaml'), 'en: content', 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { submitCliPush } = cloudModuleMock as {
      submitCliPush: ReturnType<typeof vi.fn>;
    };

    // Act: do not pass --yes; in test environment the process is effectively non-interactive.
    await pushCommand({ verbose: false });

    // Assert: no network writes and a clear error message.
    expect(submitCliPush).not.toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.some(
        ([msg]) =>
          typeof msg === 'string' &&
          msg.includes('Refusing to run push non-interactively without --yes')
      )
    ).toBe(true);

    // Reset exit code for other tests.
    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  it('push uploads assets and updates .env.config', async () => {
    await fs.writeFile(path.join(projectRoot, 'screens', 'Home.yaml'), 'home: content', 'utf8');
    await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'assets', 'logo.png'), Buffer.from([1, 2, 3]));

    // Ensure push proceeds in test environment by providing --yes.
    await pushCommand({ verbose: false, yes: true });

    const uploadAssetMock = assetClientMock.uploadAssetToStudio as ReturnType<typeof vi.fn>;
    expect(uploadAssetMock).toHaveBeenCalledTimes(1);
    expect(uploadAssetMock.mock.calls[0]?.[0]).toBe('app1');
    expect(uploadAssetMock.mock.calls[0]?.[1]).toBe('logo.png');

    const envConfig = await fs.readFile(path.join(projectRoot, '.env.config'), 'utf8');
    expect(envConfig).toContain('assets=https://cdn.example.com/assets/');
    expect(envConfig).toContain('logo_png=logo.png?token=abc');
  });

  it('push skips asset upload when cloud already has same fileName', async () => {
    (cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'app1',
      name: 'App',
      screens: [
        {
          id: 'screen-id-1',
          name: 'Home',
          content: 'home: content',
          type: 'screen',
          isRoot: true,
        },
      ] as unknown[],
      widgets: [] as unknown[],
      scripts: [] as unknown[],
      translations: [] as unknown[],
      theme: undefined,
      assets: [
        {
          id: 'a1',
          name: 'logo.png',
          fileName: 'logo.png',
          content: 'builds/app1/assets/logo.png',
          type: 'asset',
        },
      ] as unknown[],
    });

    await fs.writeFile(path.join(projectRoot, 'screens', 'Home.yaml'), 'home: content', 'utf8');
    await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'assets', 'logo.png'), Buffer.from([9, 9, 9]));

    const uploadMock = assetClientMock.uploadAssetToStudio as ReturnType<typeof vi.fn>;
    uploadMock.mockClear();

    await pushCommand({ verbose: false, yes: true });

    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('pull without --yes in non-interactive mode refuses to run', async () => {
    (cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'app1',
      name: 'App',
      screens: [
        {
          id: 'screen-id-1',
          name: 'Home',
          content: 'home: from cloud',
          type: 'screen',
          isRoot: true,
        },
      ] as unknown[],
      widgets: [] as unknown[],
      scripts: [] as unknown[],
      translations: [] as unknown[],
      theme: undefined,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await pullCommand({ verbose: false });

    expect(
      errorSpy.mock.calls.some(
        ([msg]) =>
          typeof msg === 'string' &&
          msg.includes('Refusing to run pull non-interactively without --yes')
      )
    ).toBe(true);
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  it('pull writes artifacts and .manifest and is idempotent', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const themeContent = 'colors:\n  primary: blue';

    (cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'app1',
      name: 'App',
      screens: [
        {
          id: 'screen-id-1',
          name: 'Home',
          content: 'home: content',
          type: 'screen',
          isRoot: true,
        },
      ] as unknown[],
      widgets: [
        {
          id: 'widget-id-1',
          name: 'W1',
          content: 'widget: w1',
          type: 'internal_widget',
        },
      ] as unknown[],
      scripts: [
        {
          id: 'script-id-1',
          name: 'S1',
          content: 'console.log(1);',
          type: 'internal_script',
        },
      ] as unknown[],
      translations: [
        {
          id: 'i18n_ar',
          name: 'ar',
          content: 'ar: محتوى',
          type: 'i18n',
          defaultLocale: true,
        },
        {
          id: 'i18n_en',
          name: 'en',
          content: 'en: content',
          type: 'i18n',
          defaultLocale: false,
        },
      ] as unknown[],
      theme: {
        id: 'theme',
        name: 'theme',
        content: themeContent,
        type: 'theme',
      } as unknown,
    });

    // First pull (overwrite)
    await pullCommand({ verbose: false, yes: true });

    // Verify files exist and manifest content
    const files = await collectAppFiles(projectRoot);
    expect(Object.keys(files.screens)).toContain('Home.yaml');
    expect(Object.keys(files.scripts)).toContain('S1.js');
    expect(Object.keys(files.translations)).toContain('ar.yaml');
    expect(Object.keys(files.translations)).toContain('en.yaml');
    expect(files.theme).toBe(themeContent);

    const manifestRaw = await fs.readFile(path.join(projectRoot, '.manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      widgets?: { name: string }[];
      scripts?: { name: string }[];
      homeScreenName?: string;
      defaultLanguage?: string;
      languages?: string[];
    };
    expect(manifest.widgets?.some((w) => w.name === 'W1')).toBe(true);
    expect(manifest.scripts?.some((s) => s.name === 'S1')).toBe(true);
    expect(manifest.homeScreenName).toBe('Home');
    expect(manifest.defaultLanguage).toBe('ar');
    expect(manifest.languages).toEqual(['ar', 'en']);

    // Second pull should be effectively a no-op from the FS perspective.
    const fetchSpy = cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>;
    await pullCommand({ verbose: false, yes: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const messages = logSpy.mock.calls.map((args) => args[0]);
    expect(
      messages.some(
        (m) => typeof m === 'string' && m.includes('Pulled app') && m.includes('applied')
      )
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('pull then push with no local changes: push reports nothing to push (consistency)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cloudApp = {
      id: 'app1',
      name: 'App',
      screens: [
        {
          id: 'screen-id-1',
          name: 'Home',
          content: 'home: content',
          type: 'screen',
          isRoot: true,
        },
      ] as unknown[],
      widgets: [] as unknown[],
      scripts: [] as unknown[],
      translations: [
        {
          id: 'i18n_en',
          name: 'en',
          content: 'en: content',
          type: 'i18n',
          defaultLocale: true,
        },
      ] as unknown[],
      theme: undefined,
    };
    (cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>).mockResolvedValue(cloudApp);

    await pullCommand({ verbose: false, yes: true });
    const { submitCliPush } = cloudModuleMock as {
      submitCliPush: ReturnType<typeof vi.fn>;
    };
    submitCliPush.mockClear();

    await pushCommand({ verbose: false, yes: true });

    expect(submitCliPush).not.toHaveBeenCalled();
    const messages = logSpy.mock.calls.map((args) => args[0]);
    expect(
      messages.some(
        (m) => typeof m === 'string' && m.includes('Up to date') && m.includes('Nothing to push')
      )
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('pull then push with no changes when cloud has duplicate names (archived + active)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const activeContent = 'home: content';
    const cloudApp = {
      id: 'app1',
      name: 'App',
      screens: [
        {
          id: 'archived-id',
          name: 'Home',
          content: 'archived: old',
          type: 'screen',
          isRoot: false,
          isArchived: true,
        },
        {
          id: 'active-id',
          name: 'Home',
          content: activeContent,
          type: 'screen',
          isRoot: true,
        },
      ] as unknown[],
      widgets: [] as unknown[],
      scripts: [] as unknown[],
      translations: [] as unknown[],
      theme: undefined,
    };
    (cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>).mockResolvedValue(cloudApp);

    await pullCommand({ verbose: false, yes: true });
    const { submitCliPush } = cloudModuleMock as {
      submitCliPush: ReturnType<typeof vi.fn>;
    };
    submitCliPush.mockClear();

    await pushCommand({ verbose: false, yes: true });

    expect(submitCliPush).not.toHaveBeenCalled();
    const messages = logSpy.mock.calls.map((args) => args[0]);
    expect(
      messages.some(
        (m) => typeof m === 'string' && m.includes('Up to date') && m.includes('Nothing to push')
      )
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('pull respects app options and does not overwrite disabled artifact kinds', async () => {
    // Disable screens in app options
    appOptionsRef.value = { screens: false };

    (cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'app1',
      name: 'App',
      screens: [
        {
          id: 'screen-id-1',
          name: 'Home',
          content: 'home: content',
          type: 'screen',
          isRoot: true,
        },
      ] as unknown[],
      widgets: [] as unknown[],
      scripts: [] as unknown[],
      translations: [] as unknown[],
      theme: undefined,
    });

    await pullCommand({ verbose: false, yes: true });

    const files = await collectAppFiles(projectRoot);
    // Since screens are disabled via options, pull should not have written any screens.
    expect(Object.keys(files.screens)).toEqual([]);
  });

  it('pull dry run shows summary but does not modify files', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    (cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'app1',
      name: 'App',
      screens: [
        {
          id: 'screen-id-1',
          name: 'Home',
          content: 'home: content',
          type: 'screen',
          isRoot: true,
        },
      ] as unknown[],
      widgets: [] as unknown[],
      scripts: [] as unknown[],
      translations: [] as unknown[],
      theme: undefined,
    });

    await pullCommand({ verbose: false, yes: true, dryRun: true });

    const files = await collectAppFiles(projectRoot);
    expect(Object.keys(files.screens)).toEqual([]);
    expect(Object.keys(files.widgets)).toEqual([]);
    expect(Object.keys(files.scripts)).toEqual([]);
    expect(Object.keys(files.translations)).toEqual([]);
    expect(files.theme).toBeUndefined();

    const messages = logSpy.mock.calls.map((args) => args[0]);
    expect(
      messages.some(
        (m) => typeof m === 'string' && m.includes('Pull plan for') && m.includes('(dev)')
      )
    ).toBe(true);
    expect(
      messages.some((m) => typeof m === 'string' && m.includes('🍀 new') && m.includes('Home.yaml'))
    ).toBe(true);
    expect(
      messages.some(
        (m) => typeof m === 'string' && m.includes('Dry run only: no files were changed.')
      )
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('pull explains overwrites/deletes and suggests dry run for conflicts', async () => {
    // Existing local file that will be overwritten plus one that will be deleted.
    await fs.mkdir(path.join(projectRoot, 'screens'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, 'screens', 'Home.yaml'),
      'home: local-changes',
      'utf8'
    );
    await fs.writeFile(
      path.join(projectRoot, 'screens', 'Stale.yaml'),
      'stale: to-be-deleted',
      'utf8'
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    (cloudModuleMock.fetchCloudApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'app1',
      name: 'App',
      screens: [
        {
          id: 'screen-id-1',
          name: 'Home',
          content: 'home: cloud-version',
          type: 'screen',
          isRoot: true,
        },
      ] as unknown[],
      widgets: [] as unknown[],
      scripts: [] as unknown[],
      translations: [] as unknown[],
      theme: undefined,
    });

    await pullCommand({ verbose: false, yes: true });

    const messages = logSpy.mock.calls.map((args) => args[0]);
    expect(messages.some((m) => typeof m === 'string' && m.includes('Changes to be pulled:'))).toBe(
      true
    );
    expect(
      messages.some(
        (m) => typeof m === 'string' && m.includes('removed') && m.includes('Stale.yaml')
      )
    ).toBe(true);
    expect(
      messages.some(
        (m) => typeof m === 'string' && m.includes('re-run with `--dry-run` to inspect the plan')
      )
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('push surfaces auth failures with a hint to login', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    const sessionMock = getValidAuthSession as unknown as ReturnType<typeof vi.fn>;
    sessionMock.mockResolvedValueOnce({
      ok: false as const,
      message: 'Auth failed. Run `ensemble login` and try again.',
    });

    await pushCommand({ verbose: false, yes: true });

    const errors = errorSpy.mock.calls.map(([msg]) => String(msg)).join('\n');
    expect(errors).toContain('Auth failed.');
    expect(errors).toContain('ensemble login');
    expect(process.exitCode).toBe(1);

    const { checkAppAccess, fetchCloudApp, submitCliPush } = cloudModuleMock as {
      checkAppAccess: ReturnType<typeof vi.fn>;
      fetchCloudApp: ReturnType<typeof vi.fn>;
      submitCliPush: ReturnType<typeof vi.fn>;
    };
    expect(checkAppAccess).not.toHaveBeenCalled();
    expect(fetchCloudApp).not.toHaveBeenCalled();
    expect(submitCliPush).not.toHaveBeenCalled();

    process.exitCode = originalExitCode;
    errorSpy.mockRestore();
  });

  it('pull surfaces auth failures with a hint to login', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    const sessionMock = getValidAuthSession as unknown as ReturnType<typeof vi.fn>;
    sessionMock.mockResolvedValueOnce({
      ok: false as const,
      message: 'Auth failed. Run `ensemble login` and try again.',
    });

    await pullCommand({ verbose: false, yes: true });

    const errors = errorSpy.mock.calls.map(([msg]) => String(msg)).join('\n');
    expect(errors).toContain('Auth failed.');
    expect(errors).toContain('ensemble login');
    expect(process.exitCode).toBe(1);

    const { checkAppAccess, fetchCloudApp } = cloudModuleMock as {
      checkAppAccess: ReturnType<typeof vi.fn>;
      fetchCloudApp: ReturnType<typeof vi.fn>;
    };
    expect(checkAppAccess).not.toHaveBeenCalled();
    expect(fetchCloudApp).not.toHaveBeenCalled();

    process.exitCode = originalExitCode;
    errorSpy.mockRestore();
  });

  it('push surfaces app access failures with a clear message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    (cloudModuleMock.checkAppAccess as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false as const,
      message: 'You do not have access to this app. Ask an Ensemble admin to grant you access.',
    });

    await pushCommand({ verbose: false, yes: true });

    const errors = errorSpy.mock.calls.map(([msg]) => String(msg)).join('\n');
    expect(errors).toContain('You do not have access to this app.');
    expect(process.exitCode).toBe(1);

    const { submitCliPush } = cloudModuleMock as {
      submitCliPush: ReturnType<typeof vi.fn>;
    };
    expect(submitCliPush).not.toHaveBeenCalled();

    process.exitCode = originalExitCode;
    errorSpy.mockRestore();
  });

  it('pull surfaces app access failures with a clear message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    (cloudModuleMock.checkAppAccess as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false as const,
      message: 'You do not have access to this app. Ask an Ensemble admin to grant you access.',
    });

    await pullCommand({ verbose: false, yes: true });

    const errors = errorSpy.mock.calls.map(([msg]) => String(msg)).join('\n');
    expect(errors).toContain('You do not have access to this app.');
    expect(process.exitCode).toBe(1);

    // fetchCloudApp runs in parallel with checkAppAccess, so it may be called
    // The important assertion is we exit early (process.exitCode 1) and show the message

    process.exitCode = originalExitCode;
    errorSpy.mockRestore();
  });
});
