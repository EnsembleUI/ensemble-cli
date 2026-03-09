import type { CloudApp } from '../cloud/firestoreClient.js';
import type {
  ApplicationDTO,
  ScreenDTO,
  WidgetDTO,
  ScriptDTO,
  ThemeDTO,
  TranslationDTO,
} from './dto.js';

type ArtifactWithContent = {
  id: string;
  name: string;
  content: string;
  isArchived?: boolean;
  isRoot?: boolean;
  defaultLocale?: boolean;
};

/** Snapshot of artifact to archive in history sub-collection (for YAML artifacts). */
export interface HistoryEntry {
  content: string;
  name: string;
  type: string;
  isRoot?: boolean;
  isArchived?: boolean;
  updatedAt?: string;
  updatedBy?: { name: string; email?: string; id: string };
}

type YamlDocument = ScreenDTO | WidgetDTO | ScriptDTO | ThemeDTO | TranslationDTO;

type YamlUpdates = {
  content?: string;
  name?: string;
  isRoot?: boolean;
  isArchived?: boolean;
  updatedAt?: string;
  updatedBy?: {
    name: string;
    email?: string;
    id: string;
  };
  defaultLocale?: boolean;
};

/** Create: full document for new artifact. Update: history (old→archive) + updates (only changed fields). */
export type YamlArtifactPushItem =
  | { operation: 'create'; document: YamlDocument }
  | {
      operation: 'update';
      id: string;
      history: HistoryEntry;
      updates: YamlUpdates;
    };

export interface PushPayload {
  id: string;
  name?: string;
  updatedAt: string;
  screens?: YamlArtifactPushItem[];
  widgets?: YamlArtifactPushItem[];
  scripts?: YamlArtifactPushItem[];
  translations?: YamlArtifactPushItem[];
  theme?: YamlArtifactPushItem;
}

export interface BundleDiff {
  screens: { changed: ArtifactWithContent[]; new: ArtifactWithContent[] };
  widgets: { changed: ArtifactWithContent[]; new: ArtifactWithContent[] };
  scripts: { changed: ArtifactWithContent[]; new: ArtifactWithContent[] };
  themeChanged: boolean;
  translations: { changed: ArtifactWithContent[]; new: ArtifactWithContent[] };
}

function diffArtifacts(
  bundleItems: ArtifactWithContent[] | undefined,
  cloudItems: ArtifactWithContent[] | undefined,
): { changed: ArtifactWithContent[]; new: ArtifactWithContent[] } {
  const cloudById = new Map<string, ArtifactWithContent>();
  for (const item of cloudItems ?? []) {
    cloudById.set(item.id, item);
  }
  const cloudByName = new Map<string, ArtifactWithContent>();
  for (const item of cloudItems ?? []) {
    cloudByName.set(item.name, item);
  }

  const changed: ArtifactWithContent[] = [];
  const newItems: ArtifactWithContent[] = [];

  for (const bundle of bundleItems ?? []) {
    const cloud = cloudById.get(bundle.id) ?? cloudByName.get(bundle.name);
    if (cloud) {
      const contentChanged = bundle.content !== (cloud as ArtifactWithContent).content;
      const archivedChanged =
        (bundle.isArchived ?? false) !== ((cloud as ArtifactWithContent).isArchived ?? false);
      const isRootChanged = bundle.isRoot !== (cloud as ArtifactWithContent).isRoot;
      const defaultLocaleChanged =
        (bundle as { defaultLocale?: boolean }).defaultLocale !==
        (cloud as { defaultLocale?: boolean }).defaultLocale;
      if (contentChanged || archivedChanged || isRootChanged || defaultLocaleChanged) {
        changed.push(bundle);
      }
    } else {
      newItems.push(bundle);
    }
  }

  return { changed, new: newItems };
}

type ArtifactDisplay = ArtifactWithContent & { fileName?: string };

function artifactFileName(item: ArtifactDisplay, defaultExt: string): string {
  const withFileName = item as { fileName?: string };
  if (withFileName.fileName) return withFileName.fileName;
  if (item.id.includes('/') && !/^[0-9a-f-]{36}$/i.test(item.id)) {
    return item.id.split('/').pop() ?? item.name;
  }
  return `${item.name}${defaultExt}`;
}

const LABELS = {
  new: '✨ new',
  modified: '✏️  modified',
  removed: '🗑️  removed',
} as const;

const LINE_PREFIX = '        ';
const LABEL_WIDTH = 14;

/** Format diff as grouped lines with icons (new/modified/removed). Used for both dry run and actual run. */
export function formatDiffSummary(diff: BundleDiff): string[] {
  const lines: string[] = [];
  const pad = (label: string) => label.padEnd(LABEL_WIDTH);

  const addGroup = (
    title: string,
    changed: ArtifactWithContent[],
    added: ArtifactWithContent[],
    type: string,
    ext: string,
  ) => {
    if (changed.length === 0 && added.length === 0) return;
    lines.push(`  ${title}:`);
    // Group by status: removed first, then modified, then new
    const removed = changed.filter((i) => i.isArchived);
    const modified = changed.filter((i) => !i.isArchived);
    for (const item of removed) {
      lines.push(`${LINE_PREFIX}${pad(LABELS.removed)}${artifactFileName(item, ext)}`);
    }
    for (const item of modified) {
      lines.push(`${LINE_PREFIX}${pad(LABELS.modified)}${artifactFileName(item, ext)}`);
    }
    for (const item of added) {
      lines.push(`${LINE_PREFIX}${pad(LABELS.new)}${artifactFileName(item, ext)}`);
    }
  };

  addGroup('screens', diff.screens.changed, diff.screens.new, 'screen', '.yaml');
  addGroup('widgets', diff.widgets.changed, diff.widgets.new, 'widget', '.yaml');
  addGroup('scripts', diff.scripts.changed, diff.scripts.new, 'script', '.js');
  addGroup('translations', diff.translations.changed, diff.translations.new, 'translation', '.yaml');

  if (diff.themeChanged) {
    lines.push('  theme:');
    lines.push(`${LINE_PREFIX}${pad(LABELS.modified)}theme.yaml`);
  }

  return lines;
}

/**
 * Compute which artifacts in the bundle have changed compared to the cloud app.
 * Only changed and new items need to be pushed.
 */
export function computeBundleDiff(
  bundle: ApplicationDTO,
  cloudApp: CloudApp,
): BundleDiff {
  const screens = diffArtifacts(
    bundle.screens as ArtifactWithContent[] | undefined,
    cloudApp.screens as ArtifactWithContent[] | undefined,
  );
  const widgets = diffArtifacts(
    bundle.widgets as ArtifactWithContent[] | undefined,
    cloudApp.widgets as ArtifactWithContent[] | undefined,
  );
  const scripts = diffArtifacts(
    bundle.scripts as ArtifactWithContent[] | undefined,
    cloudApp.scripts as ArtifactWithContent[] | undefined,
  );

  const themeChanged =
    !!bundle.theme &&
    (!cloudApp.theme || bundle.theme.content !== cloudApp.theme.content);

  const translations = diffArtifacts(
    bundle.translations as ArtifactWithContent[] | undefined,
    cloudApp.translations as ArtifactWithContent[] | undefined,
  );

  return {
    screens,
    widgets,
    scripts,
    themeChanged,
    translations,
  };
}

function buildHistoryEntry(cloud: ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object }): HistoryEntry {
  return {
    content: cloud.content,
    name: cloud.name,
    type: cloud.type ?? 'unknown',
    isRoot: (cloud as { isRoot?: boolean }).isRoot,
    isArchived: cloud.isArchived,
    updatedAt: cloud.updatedAt,
    updatedBy: cloud.updatedBy as HistoryEntry['updatedBy'],
  };
}

function buildPartialUpdates(
  cloud: ArtifactWithContent & { isRoot?: boolean; updatedAt?: string; updatedBy?: object },
  bundle: ArtifactWithContent & { isRoot?: boolean; updatedAt?: string; updatedBy?: object },
): YamlUpdates {
  const updates: Record<string, unknown> = {};
  if (bundle.content !== cloud.content) updates.content = bundle.content;
  if (bundle.name !== cloud.name) updates.name = bundle.name;
  if (bundle.isRoot !== cloud.isRoot) updates.isRoot = bundle.isRoot;
  if (bundle.isArchived !== cloud.isArchived) updates.isArchived = bundle.isArchived;
  if (bundle.updatedAt !== cloud.updatedAt) updates.updatedAt = bundle.updatedAt;
  if (bundle.defaultLocale !== (cloud as { defaultLocale?: boolean }).defaultLocale) {
    updates.defaultLocale = bundle.defaultLocale;
  }
  if (JSON.stringify(bundle.updatedBy) !== JSON.stringify(cloud.updatedBy)) updates.updatedBy = bundle.updatedBy;
  return updates as YamlUpdates;
}

function buildYamlPushItems(
  diff: { changed: ArtifactWithContent[]; new: ArtifactWithContent[] },
  cloudItems: ArtifactWithContent[] | undefined,
  bundleItems: (ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object })[] | undefined,
  cloudById: Map<string, ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object }>,
  cloudByName: Map<string, ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object }>,
  now: string,
  updatedBy: { name: string; email?: string; id: string },
): YamlArtifactPushItem[] {
  const items: YamlArtifactPushItem[] = [];
  for (const doc of diff.new) {
    const baseDoc = doc as ArtifactWithContent & { createdAt?: string };
    items.push({
      operation: 'create',
      document: {
        ...(baseDoc as unknown as YamlDocument),
        isRoot: (baseDoc as { isRoot?: boolean }).isRoot ?? false,
        isArchived: baseDoc.isArchived ?? false,
        createdAt: baseDoc.createdAt ?? now,
        updatedAt: now,
        updatedBy,
        // createdBy is not part of YamlDocument DTO, but Firestore encoder
        // will look for it via a cast, so we attach it here.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...( { createdBy: updatedBy } as any ),
      },
    });
  }
  for (const bundle of diff.changed) {
    const cloud = cloudById.get(bundle.id) ?? cloudByName.get(bundle.name);
    if (!cloud) continue;
    const docWithMeta = { ...bundle, updatedAt: now, updatedBy };
    const updates = buildPartialUpdates(cloud, docWithMeta);
    const cloudUpdatedBy = (cloud as { updatedBy?: object }).updatedBy;
    const updatedByChanged =
      !cloudUpdatedBy || JSON.stringify(updatedBy) !== JSON.stringify(cloudUpdatedBy);
    items.push({
      operation: 'update',
      id: cloud.id,
      history: buildHistoryEntry(cloud),
      updates: {
        ...updates,
        updatedAt: now,
        ...(updatedByChanged && { updatedBy }),
      },
    });
  }
  return items;
}

/**
 * Build push payload with history + partial updates for YAML artifacts.
 * - create: full document for new items
 * - update: history (old→archive) + only changed fields
 */
export function buildPushPayload(
  bundle: ApplicationDTO,
  diff: BundleDiff,
  cloudApp: CloudApp,
  updatedBy: { name: string; email?: string; id: string },
): PushPayload {
  const now = bundle.updatedAt ?? new Date().toISOString();

  const cloudById = <T extends { id: string }>(items: T[] | undefined) =>
    new Map((items ?? []).map((x) => [x.id, x]));
  const cloudByName = <T extends { name: string }>(items: T[] | undefined) =>
    new Map((items ?? []).map((x) => [x.name, x]));

  const screens = buildYamlPushItems(
    diff.screens,
    cloudApp.screens as ArtifactWithContent[] | undefined,
    bundle.screens as (ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object })[] | undefined,
    cloudById(cloudApp.screens as { id: string; name: string; content: string; type?: string; updatedAt?: string; updatedBy?: object }[]),
    cloudByName(cloudApp.screens as { id: string; name: string; content: string; type?: string; updatedAt?: string; updatedBy?: object }[]),
    now,
    updatedBy,
  );
  const widgets = buildYamlPushItems(
    diff.widgets,
    cloudApp.widgets as ArtifactWithContent[] | undefined,
    bundle.widgets as (ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object })[] | undefined,
    cloudById(cloudApp.widgets as { id: string; name: string; content: string; type?: string; updatedAt?: string; updatedBy?: object }[]),
    cloudByName(cloudApp.widgets as { id: string; name: string; content: string; type?: string; updatedAt?: string; updatedBy?: object }[]),
    now,
    updatedBy,
  );
  const scripts = buildYamlPushItems(
    diff.scripts,
    cloudApp.scripts as ArtifactWithContent[] | undefined,
    bundle.scripts as (ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object })[] | undefined,
    cloudById(cloudApp.scripts as { id: string; name: string; content: string; type?: string; updatedAt?: string; updatedBy?: object }[]),
    cloudByName(cloudApp.scripts as { id: string; name: string; content: string; type?: string; updatedAt?: string; updatedBy?: object }[]),
    now,
    updatedBy,
  );
  const translations = buildYamlPushItems(
    diff.translations,
    cloudApp.translations as ArtifactWithContent[] | undefined,
    bundle.translations as (ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object })[] | undefined,
    cloudById(cloudApp.translations as { id: string; name: string; content: string; type?: string; updatedAt?: string; updatedBy?: object }[]),
    cloudByName(cloudApp.translations as { id: string; name: string; content: string; type?: string; updatedAt?: string; updatedBy?: object }[]),
    now,
    updatedBy,
  );

  let theme: PushPayload['theme'];
  if (diff.themeChanged && bundle.theme) {
    if (cloudApp.theme) {
      const cloudTheme = cloudApp.theme as ArtifactWithContent & { updatedAt?: string; updatedBy?: object };
      const themeUpdates = buildPartialUpdates(
        cloudTheme,
        { ...bundle.theme, updatedAt: now, updatedBy } as ArtifactWithContent & { updatedAt?: string; updatedBy?: object },
      );
      const themeUpdatedByChanged =
        !cloudTheme.updatedBy || JSON.stringify(updatedBy) !== JSON.stringify(cloudTheme.updatedBy);
      theme = {
        operation: 'update',
        id: cloudApp.theme.id,
        history: buildHistoryEntry(cloudApp.theme as ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object }),
        updates: {
          ...themeUpdates,
          updatedAt: now,
          ...(themeUpdatedByChanged && { updatedBy }),
        },
      };
    } else {
      theme = { operation: 'create', document: { ...bundle.theme, updatedAt: now, updatedBy } as ThemeDTO };
    }
  }

  return {
    id: bundle.id,
    name: bundle.name,
    updatedAt: now,
    ...(screens.length > 0 && { screens }),
    ...(widgets.length > 0 && { widgets }),
    ...(scripts.length > 0 && { scripts }),
    ...(translations.length > 0 && { translations }),
    ...(theme && { theme }),
  };
}
