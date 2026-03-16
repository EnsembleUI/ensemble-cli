import fs from 'fs/promises';
import path from 'path';

import type { CloudApp } from '../cloud/firestoreClient.js';

export type RootManifest = Record<string, unknown> & {
  scripts?: { name: string }[];
  widgets?: { name: string }[];
  actions?: { name: string }[];
  homeScreenName?: string;
  defaultLanguage?: string;
  languages?: string[];
};

/** Get the screen name that cloud has as root (isRoot: true). */
export function getCloudHomeScreenName(cloudApp: CloudApp): string | undefined {
  const screens = (cloudApp.screens ?? []).filter((s) => s.isArchived !== true);
  return screens.find((s) => s.isRoot === true)?.name ?? screens[0]?.name;
}

export interface BuildManifestOptions {
  /** appHome from ensemble.config.json for the current app. */
  appHomeFromConfig?: string;
  /** When provided (e.g. from user prompt after conflict), use this value. Otherwise preserve existing if set. */
  homeScreenNameOverride?: string;
}

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

export function buildManifestObject(
  existing: RootManifest,
  cloudApp: CloudApp,
  options: BuildManifestOptions = {}
): RootManifest {
  const { appHomeFromConfig, homeScreenNameOverride } = options;

  const cloudWidgetNames = (cloudApp.widgets ?? [])
    .filter((w) => w.isArchived !== true)
    .map((w) => w.name);
  const widgets = mergeByName(existing.widgets, cloudWidgetNames);

  const cloudScriptNames = (cloudApp.scripts ?? [])
    .filter((s) => s.isArchived !== true)
    .map((s) => s.name);
  const scripts = mergeByName(existing.scripts, cloudScriptNames);

  const cloudActionNames = (cloudApp.actions ?? [])
    .filter((a) => a.isArchived !== true)
    .map((a) => a.name);
  const actions = mergeByName(existing.actions, cloudActionNames);

  const screens = (cloudApp.screens ?? []).filter((s) => s.isArchived !== true);
  const cloudHome = screens.find((s) => s.isRoot === true)?.name ?? screens[0]?.name;

  let homeScreenName: string | undefined;
  if (homeScreenNameOverride) {
    homeScreenName = homeScreenNameOverride;
  } else if (typeof existing.homeScreenName === 'string') {
    homeScreenName = existing.homeScreenName;
  } else {
    homeScreenName = appHomeFromConfig ?? cloudHome;
  }

  const translations = (cloudApp.translations ?? []).filter((t) => t.isArchived !== true);
  const languages = translations.map((t) => t.name);
  const defaultLanguage =
    translations.find((t) => t.defaultLocale === true)?.name ??
    (typeof existing.defaultLanguage === 'string' ? existing.defaultLanguage : undefined) ??
    languages[0];

  const merged: RootManifest = {
    ...existing,
    widgets,
    scripts,
    actions,
    ...(homeScreenName ? { homeScreenName } : {}),
    ...(languages.length > 0 ? { languages } : {}),
    ...(defaultLanguage ? { defaultLanguage } : {}),
  };

  return merged;
}

export async function buildAndWriteManifest(
  projectRoot: string,
  cloudApp: CloudApp,
  options: BuildManifestOptions = {}
): Promise<void> {
  const manifestPath = path.join(projectRoot, '.manifest.json');
  let existing: RootManifest = {};
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    existing = JSON.parse(raw) as RootManifest;
  } catch {
    existing = {};
  }

  const merged = buildManifestObject(existing, cloudApp, options);
  await fs.writeFile(manifestPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
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
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
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
