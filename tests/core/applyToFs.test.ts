import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { applyCloudStateToFs } from '../../src/core/applyToFs.js';
import type { ParsedAppFiles } from '../../src/core/appCollector.js';
import type { ArtifactProp } from '../../src/core/artifacts.js';
import type { CloudApp } from '../../src/cloud/firestoreClient.js';
import { EnsembleDocumentType, ScreenDTO } from '../../src/core/dto.js';

const allEnabled: Record<ArtifactProp, boolean> = {
  screens: true,
  widgets: true,
  scripts: true,
  actions: true,
  translations: true,
  theme: true,
};

describe('applyCloudStateToFs', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'applyToFs-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes screen and translation files from cloud state', async () => {
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [
        {
          id: 's1',
          name: 'Home',
          content: 'View:\n  body:\n    Text:\n      text: Hi',
          type: EnsembleDocumentType.Screen,
          isRoot: true,
        },
      ],
      widgets: [],
      scripts: [],
      translations: [
        {
          id: 'i18n_en',
          name: 'en',
          content: 'en: content',
          type: EnsembleDocumentType.I18n,
          defaultLocale: true,
        },
      ],
    };
    const localFiles: ParsedAppFiles = {
      screens: {},
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };

    await applyCloudStateToFs(projectRoot, cloudApp, localFiles, allEnabled);

    const homeContent = await fs.readFile(path.join(projectRoot, 'screens', 'Home.yaml'), 'utf8');
    expect(homeContent).toBe('View:\n  body:\n    Text:\n      text: Hi');
    const enContent = await fs.readFile(path.join(projectRoot, 'translations', 'en.yaml'), 'utf8');
    expect(enContent).toBe('en: content');
  });

  it('deletes local files not present in cloud state', async () => {
    await fs.mkdir(path.join(projectRoot, 'screens'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'screens', 'Obsolete.yaml'), 'old', 'utf8');

    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [],
      widgets: [],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: { 'Obsolete.yaml': 'old' },
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };

    await applyCloudStateToFs(projectRoot, cloudApp, localFiles, allEnabled);

    await expect(fs.access(path.join(projectRoot, 'screens', 'Obsolete.yaml'))).rejects.toThrow();
  });

  it('writes theme.yaml when cloud has theme, deletes when not', async () => {
    const cloudWithTheme: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [],
      widgets: [],
      scripts: [],
      translations: [],
      theme: {
        id: 't1',
        name: 'theme',
        content: 'colors:\n  primary: red',
        type: EnsembleDocumentType.Theme,
      },
    };
    const localFiles: ParsedAppFiles = {
      screens: {},
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };

    await applyCloudStateToFs(projectRoot, cloudWithTheme, localFiles, allEnabled);
    const themeContent = await fs.readFile(path.join(projectRoot, 'theme.yaml'), 'utf8');
    expect(themeContent).toBe('colors:\n  primary: red');

    const cloudNoTheme: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [],
      widgets: [],
      scripts: [],
      translations: [],
    };
    await applyCloudStateToFs(projectRoot, cloudNoTheme, localFiles, allEnabled);
    await expect(fs.access(path.join(projectRoot, 'theme.yaml'))).rejects.toThrow();
  });

  it('skips artifact kinds when disabled in enabledByProp', async () => {
    await fs.mkdir(path.join(projectRoot, 'screens'), { recursive: true });
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [
        { id: 's1', name: 'Home', content: 'x', type: EnsembleDocumentType.Screen, isRoot: true },
      ],
      widgets: [],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: {},
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };
    const enabledNoScreens = { ...allEnabled, screens: false };

    await applyCloudStateToFs(projectRoot, cloudApp, localFiles, enabledNoScreens);

    await expect(fs.access(path.join(projectRoot, 'screens', 'Home.yaml'))).rejects.toThrow();
  });

  it('writes .manifest.json when manifestOptions provided', async () => {
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [
        { id: 's1', name: 'Home', content: 'x', type: EnsembleDocumentType.Screen, isRoot: true },
      ],
      widgets: [],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: {},
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };

    await applyCloudStateToFs(projectRoot, cloudApp, localFiles, allEnabled, {
      manifestOptions: { appHomeFromConfig: 'Home' },
    });

    const manifestPath = path.join(projectRoot, '.manifest.json');
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as {
      homeScreenName?: string;
      scripts?: unknown[];
      widgets?: unknown[];
    };
    expect(manifest.homeScreenName).toBe('Home');
  });

  it('invokes onProgress every 25 completed tasks', async () => {
    const screens = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      name: `Screen${i}`,
      content: `content ${i}`,
      type: 'screen' as const,
      isRoot: i === 0,
    })) as ScreenDTO[];
    const cloudApp = {
      id: 'app1',
      name: 'App',
      screens: screens,
      widgets: [],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: {},
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };
    const progressCalls: [number, number][] = [];

    await applyCloudStateToFs(projectRoot, cloudApp, localFiles, allEnabled, {
      onProgress: (completed, total) => progressCalls.push([completed, total]),
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    progressCalls.forEach(([completed, total]) => {
      expect(completed % 25).toBe(0);
      expect(total).toBeGreaterThanOrEqual(30);
    });
  });
});
