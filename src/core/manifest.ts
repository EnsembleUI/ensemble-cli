import fs from 'fs/promises';
import path from 'path';

import type { CloudApp } from '../cloud/firestoreClient.js';

export type RootManifest = Record<string, unknown> & {
  scripts?: { name: string }[];
  widgets?: { name: string }[];
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

/** Preserve existing manifest entries by name; only add minimal { name } for new ones. */
function mergeByName<T extends { name: string }>(
  existing: T[] | undefined,
  cloudNames: string[],
): T[] {
  const existingByName = new Map((existing ?? []).map((e) => [e.name, e]));
  return cloudNames.map((name) => existingByName.get(name) ?? ({ name } as T));
}

export function buildManifestObject(
  existing: RootManifest,
  cloudApp: CloudApp,
  options: BuildManifestOptions = {},
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
    ...(homeScreenName ? { homeScreenName } : {}),
    ...(languages.length > 0 ? { languages } : {}),
    ...(defaultLanguage ? { defaultLanguage } : {}),
  };

  return merged;
}

export async function buildAndWriteManifest(
  projectRoot: string,
  cloudApp: CloudApp,
  options: BuildManifestOptions = {},
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

