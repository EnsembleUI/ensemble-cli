import { describe, it, expect } from 'vitest';
import {
  computePullPlan,
  computePushPlan,
  ARTIFACT_FS_CONFIG,
} from '../../src/core/sync.js';
import { buildDocumentsFromParsed } from '../../src/core/buildDocuments.js';
import type { ParsedAppFiles } from '../../src/core/appCollector.js';
import type { CloudApp } from '../../src/cloud/firestoreClient.js';
import { EnsembleDocumentType } from '../../src/core/dto.js';

const enabledByProp = {
  screens: true,
  widgets: true,
  scripts: true,
  actions: true,
  translations: true,
  theme: true,
};

const emptyManifest = {
  scripts: [],
  widgets: [],
  homeScreenName: undefined as string | undefined,
  defaultLanguage: undefined as string | undefined,
  languages: [] as string[],
};

function screen(
  id: string,
  name: string,
  content: string,
  opts?: { isArchived?: boolean; isRoot?: boolean },
) {
  return {
    id,
    name,
    content,
    type: EnsembleDocumentType.Screen as const,
    isArchived: opts?.isArchived,
    isRoot: opts?.isRoot,
  };
}

function widget(
  id: string,
  name: string,
  content: string,
  opts?: { isArchived?: boolean },
) {
  return {
    id,
    name,
    content,
    type: EnsembleDocumentType.Widget as const,
    isArchived: opts?.isArchived,
  };
}

describe('computePullPlan + computePushPlan consistency', () => {
  /**
   * Critical invariant: when pull says "up to date", push must say "nothing to push".
   * These tests would have caught the duplicate-cloud and content-normalization bugs.
   */
  it('when pull reports up to date, push reports no changes (screens)', () => {
    const content = 'View:\n  body:\n    Text:\n      text: hello';
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', content, { isRoot: true })],
      widgets: [],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: { 'Home.yaml': content },
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };

    const pullPlan = computePullPlan({
      appName: 'App',
      environment: 'dev',
      cloudApp,
      localFiles,
      manifestExisting: { ...emptyManifest, homeScreenName: 'Home' },
      enabledByProp,
    });
    expect(pullPlan.allArtifactsMatch).toBe(true);

    const localApp = buildDocumentsFromParsed(
      localFiles,
      'app1',
      'App',
      'Home',
    );
    const pushPlan = computePushPlan({
      appId: 'app1',
      appName: 'App',
      environment: 'dev',
      localApp,
      cloudApp,
      enabledByProp,
      updatedBy: { name: 'Test', id: 'u1' },
    });

    expect(pushPlan.diff.screens.changed).toHaveLength(0);
    expect(pushPlan.diff.screens.new).toHaveLength(0);
    expect(pushPlan.summary.counts.updated).toBe(0);
    expect(pushPlan.summary.counts.created).toBe(0);
  });

  it('when pull reports up to date, push reports no changes (content with trailing newline)', () => {
    const localContent = 'View:\n  body: Text\n';
    const cloudContent = 'View:\n  body: Text';
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', cloudContent, { isRoot: true })],
      widgets: [],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: { 'Home.yaml': localContent },
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };

    const pullPlan = computePullPlan({
      appName: 'App',
      environment: 'dev',
      cloudApp,
      localFiles,
      manifestExisting: { ...emptyManifest, homeScreenName: 'Home' },
      enabledByProp,
    });
    expect(pullPlan.allArtifactsMatch).toBe(true);

    const localApp = buildDocumentsFromParsed(
      localFiles,
      'app1',
      'App',
      'Home',
    );
    const pushPlan = computePushPlan({
      appId: 'app1',
      appName: 'App',
      environment: 'dev',
      localApp,
      cloudApp,
      enabledByProp,
      updatedBy: { name: 'Test', id: 'u1' },
    });

    expect(pushPlan.diff.screens.changed).toHaveLength(0);
    expect(pushPlan.summary.counts.updated).toBe(0);
  });

  it('when pull reports up to date, push reports no changes (content with CRLF vs LF)', () => {
    const localContent = 'View:\r\n  body: Text\r\n';
    const cloudContent = 'View:\n  body: Text\n';
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', cloudContent, { isRoot: true })],
      widgets: [],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: { 'Home.yaml': localContent },
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };

    const pullPlan = computePullPlan({
      appName: 'App',
      environment: 'dev',
      cloudApp,
      localFiles,
      manifestExisting: { ...emptyManifest, homeScreenName: 'Home' },
      enabledByProp,
    });
    expect(pullPlan.allArtifactsMatch).toBe(true);

    const localApp = buildDocumentsFromParsed(
      localFiles,
      'app1',
      'App',
      'Home',
    );
    const pushPlan = computePushPlan({
      appId: 'app1',
      appName: 'App',
      environment: 'dev',
      localApp,
      cloudApp,
      enabledByProp,
      updatedBy: { name: 'Test', id: 'u1' },
    });

    expect(pushPlan.diff.screens.changed).toHaveLength(0);
    expect(pushPlan.summary.counts.updated).toBe(0);
  });

  it('when cloud has duplicate names (archived + active), pull up to date implies push no changes', () => {
    const activeContent = 'View:\n  body: active';
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [
        screen('archived-id', 'Home', 'archived content', { isArchived: true }),
        screen('active-id', 'Home', activeContent, { isRoot: true }),
      ],
      widgets: [],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: { 'Home.yaml': activeContent },
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };

    const pullPlan = computePullPlan({
      appName: 'App',
      environment: 'dev',
      cloudApp,
      localFiles,
      manifestExisting: { ...emptyManifest, homeScreenName: 'Home' },
      enabledByProp,
    });
    expect(pullPlan.allArtifactsMatch).toBe(true);

    const localApp = buildDocumentsFromParsed(
      localFiles,
      'app1',
      'App',
      'Home',
    );
    const pushPlan = computePushPlan({
      appId: 'app1',
      appName: 'App',
      environment: 'dev',
      localApp,
      cloudApp,
      enabledByProp,
      updatedBy: { name: 'Test', id: 'u1' },
    });

    expect(pushPlan.diff.screens.changed).toHaveLength(0);
    expect(pushPlan.diff.screens.new).toHaveLength(0);
    expect(pushPlan.summary.counts.updated).toBe(0);
    expect(pushPlan.summary.counts.created).toBe(0);
  });

  it('when cloud has duplicate names (active first, archived second), push still reports no changes', () => {
    const activeContent = 'View:\n  body: active';
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [
        screen('active-id', 'Home', activeContent, { isRoot: true }),
        screen('archived-id', 'Home', 'archived content', { isArchived: true }),
      ],
      widgets: [],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: { 'Home.yaml': activeContent },
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };

    const pullPlan = computePullPlan({
      appName: 'App',
      environment: 'dev',
      cloudApp,
      localFiles,
      manifestExisting: { ...emptyManifest, homeScreenName: 'Home' },
      enabledByProp,
    });
    expect(pullPlan.allArtifactsMatch).toBe(true);

    const localApp = buildDocumentsFromParsed(
      localFiles,
      'app1',
      'App',
      'Home',
    );
    const pushPlan = computePushPlan({
      appId: 'app1',
      appName: 'App',
      environment: 'dev',
      localApp,
      cloudApp,
      enabledByProp,
      updatedBy: { name: 'Test', id: 'u1' },
    });

    expect(pushPlan.diff.screens.changed).toHaveLength(0);
    expect(pushPlan.summary.counts.updated).toBe(0);
  });

  it('when pull reports changes, push may report changes (real diff)', () => {
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'old content', { isRoot: true })],
      widgets: [],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: { 'Home.yaml': 'new content' },
      widgets: {},
      scripts: {},
      actions: {},
      translations: {},
    };

    const pullPlan = computePullPlan({
      appName: 'App',
      environment: 'dev',
      cloudApp,
      localFiles,
      manifestExisting: { ...emptyManifest, homeScreenName: 'Home' },
      enabledByProp,
    });
    expect(pullPlan.allArtifactsMatch).toBe(false);

    const localApp = buildDocumentsFromParsed(
      localFiles,
      'app1',
      'App',
      'Home',
    );
    const pushPlan = computePushPlan({
      appId: 'app1',
      appName: 'App',
      environment: 'dev',
      localApp,
      cloudApp,
      enabledByProp,
      updatedBy: { name: 'Test', id: 'u1' },
    });

    expect(pushPlan.diff.screens.changed).toHaveLength(1);
    expect(pushPlan.summary.counts.updated).toBe(1);
  });

  it('consistency: widgets with duplicate names (archived + active)', () => {
    const activeContent = 'Widget:\n  body: Text';
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [],
      widgets: [
        widget('archived-id', 'Button', 'archived', { isArchived: true }),
        widget('active-id', 'Button', activeContent),
      ],
      scripts: [],
      translations: [],
    };
    const localFiles: ParsedAppFiles = {
      screens: {},
      widgets: { 'Button.yaml': activeContent },
      scripts: {},
      actions: {},
      translations: {},
    };

    const pullPlan = computePullPlan({
      appName: 'App',
      environment: 'dev',
      cloudApp,
      localFiles,
      manifestExisting: emptyManifest,
      enabledByProp,
    });
    expect(pullPlan.allArtifactsMatch).toBe(true);

    const localApp = buildDocumentsFromParsed(localFiles, 'app1', 'App');
    const pushPlan = computePushPlan({
      appId: 'app1',
      appName: 'App',
      environment: 'dev',
      localApp,
      cloudApp,
      enabledByProp,
      updatedBy: { name: 'Test', id: 'u1' },
    });

    expect(pushPlan.diff.widgets.changed).toHaveLength(0);
    expect(pushPlan.diff.widgets.new).toHaveLength(0);
  });

  it('consistency: theme with trailing newline', () => {
    const localTheme = 'colors:\n  primary: blue\n';
    const cloudTheme = 'colors:\n  primary: blue';
    const cloudApp: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [],
      widgets: [],
      scripts: [],
      translations: [],
      theme: {
        id: 'theme',
        name: 'theme',
        content: cloudTheme,
        type: EnsembleDocumentType.Theme,
      },
    };
    const localFiles: ParsedAppFiles = {
      screens: {},
      widgets: {},
      scripts: {},
      translations: {},
      actions: {},
      theme: localTheme,
    };

    const pullPlan = computePullPlan({
      appName: 'App',
      environment: 'dev',
      cloudApp,
      localFiles,
      manifestExisting: emptyManifest,
      enabledByProp,
    });
    expect(pullPlan.allArtifactsMatch).toBe(true);

    const localApp = buildDocumentsFromParsed(localFiles, 'app1', 'App');
    const pushPlan = computePushPlan({
      appId: 'app1',
      appName: 'App',
      environment: 'dev',
      localApp,
      cloudApp,
      enabledByProp,
      updatedBy: { name: 'Test', id: 'u1' },
    });

    expect(pushPlan.diff.themeChanged).toBe(false);
  });
});

describe('ARTIFACT_FS_CONFIG', () => {
  it('has expected artifact kinds with correct extensions', () => {
    const props = ARTIFACT_FS_CONFIG.map((c) => c.prop);
    expect(props).toContain('screens');
    expect(props).toContain('widgets');
    expect(props).toContain('scripts');
    expect(props).toContain('actions');
    expect(props).toContain('translations');
    expect(props).toContain('theme');

    const screens = ARTIFACT_FS_CONFIG.find((c) => c.prop === 'screens');
    expect(screens?.ext).toBe('.yaml');
    expect(screens?.isTheme).toBeFalsy();

    const theme = ARTIFACT_FS_CONFIG.find((c) => c.prop === 'theme');
    expect(theme?.isTheme).toBe(true);
  });
});
