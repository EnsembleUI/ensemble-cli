import type { CloudApp } from '../cloud/firestoreClient.js';
import type { ParsedAppFiles } from './appCollector.js';
import type { ApplicationDTO, ArtifactProp } from './dto.js';
import { ArtifactProps } from './dto.js';
import type { BundleDiff } from './bundleDiff.js';
import { computeBundleDiff, normalizeContentForCompare } from './bundleDiff.js';
import { buildMergedBundle } from './buildDocuments.js';
import type { RootManifest } from './manifest.js';
import { buildManifestObject } from './manifest.js';

export interface PushCounts {
  created: number;
  updated: number;
  deleted: number;
}

export interface PushSummary {
  appId: string;
  appName: string;
  environment: string;
  counts: PushCounts;
  byKind: {
    screens: PushCounts;
    widgets: PushCounts;
    scripts: PushCounts;
    actions: PushCounts;
    translations: PushCounts;
    theme: PushCounts;
  };
}

export interface PushPlan {
  appId: string;
  appName: string;
  environment: string;
  bundle: ApplicationDTO;
  diff: BundleDiff;
  summary: PushSummary;
}

export interface ComputePushPlanArgs {
  appId: string;
  appName: string;
  environment: string;
  localApp: ApplicationDTO;
  cloudApp: CloudApp;
  enabledByProp: Record<ArtifactProp, boolean>;
  updatedBy: { name: string; email?: string; id: string };
}

function computeKindCounts(items: BundleDiff['screens']): PushCounts {
  let created = 0;
  let updated = 0;
  let deleted = 0;

  created += items.new.length;
  for (const item of items.changed) {
    if (item.isArchived) {
      deleted += 1;
    } else {
      updated += 1;
    }
  }

  return { created, updated, deleted };
}

function computePushSummary(
  appId: string,
  appName: string,
  environment: string,
  diff: BundleDiff,
): PushSummary {
  const screens = computeKindCounts(diff.screens);
  const widgets = computeKindCounts(diff.widgets);
  const scripts = computeKindCounts(diff.scripts);
  const actions = computeKindCounts(diff.actions);
  const translations = computeKindCounts(diff.translations);

  // Theme currently only supports modified (no explicit create/delete in diff),
  // so treat a changed theme as an update.
  const theme: PushCounts = diff.themeChanged
    ? { created: 0, updated: 1, deleted: 0 }
    : { created: 0, updated: 0, deleted: 0 };

  const counts: PushCounts = {
    created:
      screens.created +
      widgets.created +
      scripts.created +
      actions.created +
      translations.created +
      theme.created,
    updated:
      screens.updated +
      widgets.updated +
      scripts.updated +
      actions.updated +
      translations.updated +
      theme.updated,
    deleted:
      screens.deleted +
      widgets.deleted +
      scripts.deleted +
      actions.deleted +
      translations.deleted +
      theme.deleted,
  };

  return {
    appId,
    appName,
    environment,
    counts,
    byKind: {
      screens,
      widgets,
      scripts,
      actions,
      translations,
      theme,
    },
  };
}

export function computePushPlan(args: ComputePushPlanArgs): PushPlan {
  const { appId, appName, environment, localApp, cloudApp, enabledByProp, updatedBy } = args;

  const bundle = buildMergedBundle(localApp, cloudApp, updatedBy);
  let diff = computeBundleDiff(bundle, cloudApp);

  // Respect per-artifact app options: ignore changes for disabled kinds, driven by ArtifactProps.
  for (const prop of ArtifactProps) {
    if (enabledByProp[prop]) continue;
    if (prop === 'theme') {
      diff = { ...diff, themeChanged: false };
      continue;
    }
    const key = prop as Exclude<ArtifactProp, 'theme'>;
    const current = diff[key] ?? { changed: [], new: [] };
    diff = {
      ...diff,
      [key]: {
        ...current,
        changed: [],
        new: [],
      },
    } as BundleDiff;
  }

  const summary = computePushSummary(appId, appName, environment, diff);

  return {
    appId,
    appName,
    environment,
    bundle,
    diff,
    summary,
  };
}

export type PullOperation = 'create' | 'update' | 'delete';

export interface PullChange {
  readonly kind: string;
  readonly file: string;
  readonly operation: PullOperation;
}

export interface PullSummary {
  readonly appName: string;
  readonly environment: string;
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly changes: readonly PullChange[];
}

export interface PullPlan {
  readonly summary: PullSummary;
  readonly manifestExpected: RootManifest;
  readonly allArtifactsMatch: boolean;
  readonly manifestMatch: boolean;
}

export interface ArtifactFsConfig {
  readonly prop: ArtifactProp;
  readonly ext?: string;
  readonly isTheme?: boolean;
}

export const ARTIFACT_FS_CONFIG: ArtifactFsConfig[] = [
  { prop: 'screens', ext: '.yaml' },
  { prop: 'widgets', ext: '.yaml' },
  { prop: 'scripts', ext: '.js' },
  { prop: 'actions', ext: '.yaml' },
  { prop: 'translations', ext: '.yaml' },
  { prop: 'theme', isTheme: true },
];

export interface ComputePullPlanArgs {
  appName: string;
  environment: string;
  cloudApp: CloudApp;
  localFiles: ParsedAppFiles;
  manifestExisting: RootManifest;
  enabledByProp: Record<ArtifactProp, boolean>;
}

export function computePullPlan({
  appName,
  environment,
  cloudApp,
  localFiles,
  manifestExisting,
  enabledByProp,
}: ComputePullPlanArgs): PullPlan {
  const matchesByProp: Partial<Record<ArtifactProp, boolean>> = {};

  for (const cfg of ARTIFACT_FS_CONFIG) {
    const { prop, isTheme, ext } = cfg;
    if (!enabledByProp[prop]) {
      matchesByProp[prop] = true;
      continue;
    }

    if (isTheme) {
      const expectedThemeContent =
        cloudApp.theme && cloudApp.theme.isArchived !== true
          ? cloudApp.theme.content ?? ''
          : undefined;
      let themeMatch = true;
      if (expectedThemeContent === undefined) {
        themeMatch = localFiles.theme === undefined;
      } else {
        themeMatch =
          localFiles.theme !== undefined &&
          normalizeContentForCompare(localFiles.theme) ===
            normalizeContentForCompare(expectedThemeContent);
      }
      matchesByProp[prop] = themeMatch;
      continue;
    }

    const expected: Record<string, string> = {};
    const cloudItems = (cloudApp as Record<string, unknown>)[prop] as
      | { name: string; content?: string; isArchived?: boolean }[]
      | undefined;
    for (const item of cloudItems ?? []) {
      if (item.isArchived === true) continue;
      expected[`${item.name}${ext!}`] = item.content ?? '';
    }
    const actual = (localFiles as unknown as Record<string, unknown>)[
      prop
    ] as Record<string, string> | undefined;
    const actualMap = actual ?? {};

    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actualMap).sort();

    let equal = expectedKeys.length === actualKeys.length;
    for (let i = 0; equal && i < expectedKeys.length; i += 1) {
      if (expectedKeys[i] !== actualKeys[i]) {
        equal = false;
        break;
      }
      const k = expectedKeys[i]!;
      if (
        normalizeContentForCompare(expected[k] ?? '') !==
        normalizeContentForCompare(actualMap[k] ?? '')
      ) {
        equal = false;
        break;
      }
    }
    matchesByProp[prop] = equal;
  }

  const manifestExpected = buildManifestObject(manifestExisting, cloudApp);
  const manifestExpectedRaw = JSON.stringify(manifestExpected, null, 2) + '\n';
  const manifestExistingRaw = JSON.stringify(manifestExisting, null, 2) + '\n';
  const manifestMatch = manifestExistingRaw === manifestExpectedRaw;

  const allArtifactsMatch = ArtifactProps.every((prop) => matchesByProp[prop] ?? true);

  const changes: PullChange[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;

  const typeLabelByProp: Record<Exclude<ArtifactProp, 'theme'>, string> = {
    screens: 'screen',
    widgets: 'widget',
    scripts: 'script',
    actions: 'action',
    translations: 'translation',
  };

  for (const cfg of ARTIFACT_FS_CONFIG) {
    const { prop, isTheme, ext } = cfg;
    if (!enabledByProp[prop]) continue;

    if (isTheme) {
      const expectedThemeContent =
        cloudApp.theme && cloudApp.theme.isArchived !== true
          ? cloudApp.theme.content ?? ''
          : undefined;
      const actualTheme = localFiles.theme;
      if (
        expectedThemeContent === undefined
          ? actualTheme === undefined
          : actualTheme !== undefined &&
            normalizeContentForCompare(actualTheme) ===
              normalizeContentForCompare(expectedThemeContent)
      )
        continue;
      if (expectedThemeContent && !actualTheme) {
        createdCount += 1;
        changes.push({
          kind: 'theme',
          file: 'theme.yaml',
          operation: 'create',
        });
      } else if (!expectedThemeContent && actualTheme) {
        deletedCount += 1;
        changes.push({
          kind: 'theme',
          file: 'theme.yaml',
          operation: 'delete',
        });
      } else {
        updatedCount += 1;
        changes.push({
          kind: 'theme',
          file: 'theme.yaml',
          operation: 'update',
        });
      }
      continue;
    }

    const kind = typeLabelByProp[prop as Exclude<ArtifactProp, 'theme'>];
    const expected: Record<string, string> = {};
    const cloudItems = (cloudApp as Record<string, unknown>)[prop] as
      | { name: string; content?: string; isArchived?: boolean }[]
      | undefined;
    for (const item of cloudItems ?? []) {
      if (item.isArchived === true) continue;
      expected[`${item.name}${ext!}`] = item.content ?? '';
    }
    const actual = (localFiles as unknown as Record<string, unknown>)[
      prop
    ] as Record<string, string> | undefined;
    const actualMap = actual ?? {};

    const expectedKeys = new Set(Object.keys(expected));
    const actualKeys = new Set(Object.keys(actualMap));

    for (const file of expectedKeys) {
      if (!actualKeys.has(file)) {
        createdCount += 1;
        changes.push({
          kind,
          file: `${prop}/${file}`,
          operation: 'create',
        });
      }
    }
    for (const file of actualKeys) {
      if (!expectedKeys.has(file)) {
        deletedCount += 1;
        changes.push({
          kind,
          file: `${prop}/${file}`,
          operation: 'delete',
        });
      }
    }
    for (const file of expectedKeys) {
      if (!actualKeys.has(file)) continue;
      if (expected[file] !== actualMap[file]) {
        updatedCount += 1;
        changes.push({
          kind,
          file: `${prop}/${file}`,
          operation: 'update',
        });
      }
    }
  }

  const summary: PullSummary = {
    appName,
    environment,
    created: createdCount,
    updated: updatedCount,
    deleted: deletedCount,
    skipped: 0,
    changes,
  };

  return {
    summary,
    manifestExpected,
    allArtifactsMatch,
    manifestMatch,
  };
}

