import type { CloudApp } from '../cloud/firestoreClient.js';
import pc from 'picocolors';
import type {
  ApplicationDTO,
  ScreenDTO,
  WidgetDTO,
  ScriptDTO,
  ActionDTO,
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
  defaultLocale?: boolean;
  updatedAt?: string;
  updatedBy?: { name: string; email?: string; id: string };
}

type YamlDocument = ScreenDTO | WidgetDTO | ScriptDTO | ActionDTO | ThemeDTO | TranslationDTO;

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
   actions?: YamlArtifactPushItem[];
  translations?: YamlArtifactPushItem[];
  theme?: YamlArtifactPushItem;
}

export interface BundleDiff {
  screens: { changed: ArtifactWithContent[]; new: ArtifactWithContent[] };
  widgets: { changed: ArtifactWithContent[]; new: ArtifactWithContent[] };
  scripts: { changed: ArtifactWithContent[]; new: ArtifactWithContent[] };
  actions: { changed: ArtifactWithContent[]; new: ArtifactWithContent[] };
  themeChanged: boolean;
  translations: { changed: ArtifactWithContent[]; new: ArtifactWithContent[] };
}

/** Normalize content for comparison to avoid false diffs from line endings or trailing newlines. */
export function normalizeContentForCompare(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '');
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
      const contentChanged =
        normalizeContentForCompare(bundle.content) !==
        normalizeContentForCompare((cloud as ArtifactWithContent).content);
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

const LINE_PREFIX = '        ';
const LABEL_WIDTH = 14;

const LABEL_TEXT = {
  new: '🍀 new',
  modified: '✏️  modified',
  removed: '❌  removed',
} as const;

/** Format diff as grouped lines with icons (new/modified/removed). Used for both dry run and actual run. */
export function formatDiffSummary(diff: BundleDiff): string[] {
  const lines: string[] = [];
  const pad = (label: string) => label.padEnd(LABEL_WIDTH);
  const formatLabel = (raw: string, color: (value: string) => string) =>
    color(pad(raw));

  const addGroup = (
    title: string,
    changed: ArtifactWithContent[],
    added: ArtifactWithContent[],
    type: string,
    ext: string,
  ) => {
    if (changed.length === 0 && added.length === 0) return;
    lines.push(pc.cyan(pc.bold(`  ${title}:`)));
    // Group by status: removed first, then modified, then new
    const removed = changed.filter((i) => i.isArchived);
    const modified = changed.filter((i) => !i.isArchived);
    for (const item of removed) {
      const label = formatLabel(LABEL_TEXT.removed, pc.red);
      lines.push(`${LINE_PREFIX}${label} ${artifactFileName(item, ext)}`);
    }
    for (const item of modified) {
      const label = formatLabel(LABEL_TEXT.modified, pc.yellow);
      lines.push(`${LINE_PREFIX}${label} ${artifactFileName(item, ext)}`);
    }
    for (const item of added) {
      const label = formatLabel(LABEL_TEXT.new, pc.green);
      lines.push(`${LINE_PREFIX}${label} ${artifactFileName(item, ext)}`);
    }
  };

  addGroup('screens', diff.screens.changed, diff.screens.new, 'screen', '.yaml');
  addGroup('widgets', diff.widgets.changed, diff.widgets.new, 'widget', '.yaml');
  addGroup('scripts', diff.scripts.changed, diff.scripts.new, 'script', '.js');
  addGroup('actions', diff.actions.changed, diff.actions.new, 'action', '.yaml');
  addGroup('translations', diff.translations.changed, diff.translations.new, 'translation', '.yaml');

  if (diff.themeChanged) {
    lines.push(pc.cyan(pc.bold('  theme:')));
    const label = formatLabel(LABEL_TEXT.modified, pc.yellow);
    lines.push(`${LINE_PREFIX}${label} theme.yaml`);
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
  const actions = diffArtifacts(
    bundle.actions as ArtifactWithContent[] | undefined,
    (cloudApp.actions as ArtifactWithContent[] | undefined) ?? [],
  );

  const themeChanged =
    !!bundle.theme &&
    (!cloudApp.theme ||
      normalizeContentForCompare(bundle.theme.content) !==
        normalizeContentForCompare(cloudApp.theme.content));

  const translations = diffArtifacts(
    bundle.translations as ArtifactWithContent[] | undefined,
    cloudApp.translations as ArtifactWithContent[] | undefined,
  );

  return {
    screens,
    widgets,
    scripts,
    actions,
    themeChanged,
    translations,
  };
}

function buildHistoryEntry(cloud: ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object; defaultLocale?: boolean }): HistoryEntry {
  return {
    content: cloud.content,
    name: cloud.name,
    type: cloud.type ?? 'unknown',
    isRoot: (cloud as { isRoot?: boolean }).isRoot,
    isArchived: cloud.isArchived,
    defaultLocale: (cloud as { defaultLocale?: boolean }).defaultLocale,
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
  const actions = buildYamlPushItems(
    diff.actions,
    (cloudApp.actions as ArtifactWithContent[] | undefined) ?? [],
    bundle.actions as (ArtifactWithContent & { type?: string; updatedAt?: string; updatedBy?: object })[] | undefined,
    cloudById(
      (cloudApp.actions as { id: string; name: string; content: string; type?: string; updatedAt?: string; updatedBy?: object }[] | undefined) ?? [],
    ),
    cloudByName(
      (cloudApp.actions as { id: string; name: string; content: string; type?: string; updatedAt?: string; updatedBy?: object }[] | undefined) ?? [],
    ),
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
    ...(actions.length > 0 && { actions }),
    ...(translations.length > 0 && { translations }),
    ...(theme && { theme }),
  };
}
