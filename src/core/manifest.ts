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

export function buildManifestObject(existing: RootManifest, cloudApp: CloudApp): RootManifest {
  const widgets = (cloudApp.widgets ?? [])
    .filter((w) => w.isArchived !== true)
    .map((w) => ({ name: w.name }));

  const scripts = (cloudApp.scripts ?? [])
    .filter((s) => s.isArchived !== true)
    .map((s) => ({ name: s.name }));

  const screens = (cloudApp.screens ?? []).filter((s) => s.isArchived !== true);
  const homeScreenName =
    screens.find((s) => s.isRoot === true)?.name ??
    (typeof existing.homeScreenName === 'string' ? existing.homeScreenName : undefined) ??
    screens[0]?.name;

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
  await fs.writeFile(manifestPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

