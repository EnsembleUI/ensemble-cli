import fs from 'fs/promises';
import path from 'path';

import type { CloudApp } from '../cloud/firestoreClient.js';

export type RootManifest = Record<string, unknown> & {
  scripts?: { name: string }[];
  widgets?: { name: string }[];
  actions?: { name: string }[];
  defaultLanguage?: string;
  languages?: string[];
};

/** Preserve existing manifest entries by name and order; only add minimal { name } for new ones. */
function mergeByName<T extends { name: string }>(
  existing: T[] | undefined,
  cloudNames: string[]
): T[] {
  const existingList = existing ?? [];
  const cloudNameSet = new Set(cloudNames);

  // 1. Keep existing entries that still exist in cloud, in the same order as manifest.
  const keptExisting: T[] = existingList.filter((e) => cloudNameSet.has(e.name));

  // 2. Append any new cloud names that are not already present.
  const keptNames = new Set(keptExisting.map((e) => e.name));
  const appended: T[] = cloudNames
    .filter((name) => !keptNames.has(name))
    .map((name) => ({ name }) as T);

  return [...keptExisting, ...appended];
}

function mergeLanguageNames(existing: string[] | undefined, cloudNames: string[]): string[] {
  return mergeByName(
    (existing ?? []).map((name) => ({ name })),
    cloudNames
  ).map((entry) => entry.name);
}

/** Build manifest literally from a release snapshot (pull/push merge rules do not apply). */
export function manifestFromSnapshot(cloudApp: CloudApp): RootManifest {
  const widgets = (cloudApp.widgets ?? [])
    .filter((w) => w.isArchived !== true)
    .map((w) => ({ name: w.name }));
  const scripts = (cloudApp.scripts ?? [])
    .filter((s) => s.isArchived !== true)
    .map((s) => ({ name: s.name }));
  const actions = (cloudApp.actions ?? [])
    .filter((a) => a.isArchived !== true)
    .map((a) => ({ name: a.name }));

  const translations = (cloudApp.translations ?? []).filter((t) => t.isArchived !== true);
  const languages = translations.map((t) => t.name);
  const defaultLanguage = translations.find((t) => t.defaultLocale === true)?.name ?? languages[0];

  const manifest: RootManifest = {};
  if (widgets.length > 0) manifest.widgets = widgets;
  if (scripts.length > 0) manifest.scripts = scripts;
  if (actions.length > 0) manifest.actions = actions;
  if (languages.length > 0) {
    manifest.languages = languages;
    if (defaultLanguage) manifest.defaultLanguage = defaultLanguage;
  }
  return manifest;
}

export async function writeManifestFromSnapshot(
  projectRoot: string,
  cloudApp: CloudApp
): Promise<void> {
  const manifest = manifestFromSnapshot(cloudApp);
  await fs.writeFile(
    path.join(projectRoot, '.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
}

/** Merge cloud lists into an existing manifest (pull/push). */
export function buildManifestObject(existing: RootManifest, cloudApp: CloudApp): RootManifest {
  const cloudWidgetNames = (cloudApp.widgets ?? [])
    .filter((w) => w.isArchived !== true)
    .map((w) => w.name);
  const cloudScriptNames = (cloudApp.scripts ?? [])
    .filter((s) => s.isArchived !== true)
    .map((s) => s.name);
  const cloudActionNames = (cloudApp.actions ?? [])
    .filter((a) => a.isArchived !== true)
    .map((a) => a.name);

  const translations = (cloudApp.translations ?? []).filter((t) => t.isArchived !== true);
  const languages = translations.map((t) => t.name);
  const cloudDefault = translations.find((t) => t.defaultLocale === true)?.name;

  const widgets = mergeByName(existing.widgets, cloudWidgetNames);
  const scripts = mergeByName(existing.scripts, cloudScriptNames);
  const actions = mergeByName(existing.actions, cloudActionNames);
  const mergedLanguages = mergeLanguageNames(existing.languages, languages);

  const existingDefault =
    typeof existing.defaultLanguage === 'string' ? existing.defaultLanguage : undefined;
  const mergedDefaultLanguage =
    cloudDefault ??
    (existingDefault && mergedLanguages.includes(existingDefault) ? existingDefault : undefined) ??
    mergedLanguages[0];

  const merged: RootManifest = {
    ...existing,
    languages: mergedLanguages,
  };

  for (const [key, value] of [
    ['widgets', widgets],
    ['scripts', scripts],
    ['actions', actions],
  ] as const) {
    if (value.length > 0) {
      merged[key] = value;
    } else if (key in existing) {
      merged[key] = value;
    } else {
      delete merged[key];
    }
  }

  if (mergedLanguages.length > 0 && mergedDefaultLanguage) {
    merged.defaultLanguage = mergedDefaultLanguage;
  } else {
    delete merged.defaultLanguage;
  }

  return merged;
}

export async function buildAndWriteManifest(
  projectRoot: string,
  cloudApp: CloudApp
): Promise<void> {
  const manifestPath = path.join(projectRoot, '.manifest.json');
  let existing: RootManifest = {};
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    existing = JSON.parse(raw) as RootManifest;
  } catch {
    existing = {};
  }

  const merged = buildManifestObject(existing, cloudApp);
  await fs.writeFile(manifestPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

export async function readProjectManifest(projectRoot: string): Promise<RootManifest> {
  return readRootManifest(path.join(projectRoot, '.manifest.json'));
}

export function orderByManifestNames<T extends { name: string }>(
  items: T[],
  manifestNames: string[] | undefined
): T[] {
  if (!manifestNames?.length) {
    return items;
  }
  const order = new Map(manifestNames.map((name, index) => [name, index]));
  return [...items].sort((a, b) => {
    const ai = order.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi || a.name.localeCompare(b.name);
  });
}

async function readRootManifest(manifestPath: string): Promise<RootManifest> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as RootManifest;
  } catch {
    return {};
  }
}

async function writeRootManifest(manifestPath: string, manifest: RootManifest): Promise<void> {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function upsertManifestEntry(
  projectRoot: string,
  kind: 'widget' | 'script' | 'action' | 'translation',
  name: string
): Promise<void> {
  const manifestPath = path.join(projectRoot, '.manifest.json');
  const manifest = await readRootManifest(manifestPath);

  const listKeyByKind: Record<'widget' | 'script' | 'action', keyof RootManifest> = {
    widget: 'widgets',
    script: 'scripts',
    action: 'actions',
  };

  if (kind in listKeyByKind) {
    const key = listKeyByKind[kind as 'widget' | 'script' | 'action'];
    const current = (manifest[key] as { name: string }[] | undefined) ?? [];
    if (!current.some((entry) => entry.name === name)) {
      (manifest as Record<string, unknown>)[key] = [...current, { name }];
    }
  } else if (kind === 'translation') {
    const currentLangs = manifest.languages ?? [];
    if (!currentLangs.includes(name)) {
      manifest.languages = [...currentLangs, name];
    }
    if (!manifest.defaultLanguage) {
      manifest.defaultLanguage = name;
    }
  }

  await writeRootManifest(manifestPath, manifest);
}
