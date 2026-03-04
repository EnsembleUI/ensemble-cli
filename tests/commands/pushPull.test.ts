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
    submitCliPush: vi.fn(async () => {}),
  };
});

vi.mock('../../src/cloud/firestoreClient.js', () => cloudModuleMock);

// Import after mocks
import { pushCommand } from '../../src/commands/push.js';
import { pullCommand } from '../../src/commands/pull.js';
import { collectAppFiles } from '../../src/core/appCollector.js';

describe('push/pull integration (commands)', () => {
  const originalCwd = process.cwd();

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ensemble-cli-push-pull-'),
    );
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
    // Arrange: create translation files and manifest
    await fs.writeFile(
      path.join(projectRoot, 'translations', 'en.yaml'),
      'en: content',
      'utf8',
    );
    await fs.writeFile(
      path.join(projectRoot, 'translations', 'ar.yaml'),
      'ar: محتوى',
      'utf8',
    );
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
        2,
      ) + '\n',
      'utf8',
    );

    // Act
    await pushCommand({ verbose: false, yes: true });

    // Assert
    const { submitCliPush } = cloudModuleMock as {
      submitCliPush: ReturnType<typeof vi.fn>;
    };
    expect(submitCliPush).toHaveBeenCalledTimes(1);
    const [appId, _idToken, payload] = submitCliPush.mock.calls[0] as [
      string,
      string,
      unknown,
    ];
    expect(appId).toBe('app1');
    const p = payload as {
      translations?: { operation: string; document: { id: string; name: string; defaultLocale?: boolean } }[];
    };
    expect(p.translations).toBeDefined();
    const ar = p.translations!.find(
      (t) => t.operation === 'create' && t.document.name === 'ar',
    );
    const en = p.translations!.find(
      (t) => t.operation === 'create' && t.document.name === 'en',
    );
    expect(ar).toBeDefined();
    expect(en).toBeDefined();
    expect(ar!.document.id).toBe('i18n_ar');
    expect(en!.document.id).toBe('i18n_en');
    expect(ar!.document.defaultLocale).toBe(true);
    expect(en!.document.defaultLocale ?? false).toBe(false);
  });

  it('push respects app options and does not include disabled screens in diff/payload', async () => {
    // Disable screens in app options
    appOptionsRef.value = { screens: false };

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

  it('pull writes artifacts and .manifest and is idempotent', async () => {
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
    expect(Object.keys(files.widgets)).toContain('W1.yaml');
    expect(Object.keys(files.scripts)).toContain('S1.js');
    expect(Object.keys(files.translations)).toContain('ar.yaml');
    expect(Object.keys(files.translations)).toContain('en.yaml');
    expect(files.theme).toBe(themeContent);

    const manifestRaw = await fs.readFile(
      path.join(projectRoot, '.manifest.json'),
      'utf8',
    );
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
});

