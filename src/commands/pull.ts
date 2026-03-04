import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import { checkAppAccess, fetchCloudApp } from '../cloud/firestoreClient.js';
import { collectAppFiles } from '../core/appCollector.js';
import { resolveAppContext } from '../config/projectConfig.js';
import { getValidAuthSession } from '../auth/session.js';
import { withSpinner } from '../lib/spinner.js';

export interface PullOptions {
  verbose?: boolean;
  appKey?: string;
  /** Skip confirmation prompt (e.g. for CI) */
  yes?: boolean;
}

async function writeVerbose(
  root: string,
  filename: string,
  data: unknown,
  verbose: boolean,
): Promise<void> {
  if (!verbose) return;
  const filePath = path.join(root, filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Wrote ${filePath}`);
}

async function rmDirIfExists(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function safeFileName(name: string, ext: string): string {
  // Keep user-provided names as-is as much as possible, but guard against path separators.
  const base = name.replace(/[\\/]/g, '_');
  return `${base}${ext}`;
}

function mapsEqual(
  expected: Record<string, string>,
  actual: Record<string, string>,
): boolean {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (expectedKeys.length !== actualKeys.length) return false;
  for (let i = 0; i < expectedKeys.length; i++) {
    if (expectedKeys[i] !== actualKeys[i]) return false;
    const k = expectedKeys[i]!;
    if (expected[k] !== actual[k]) return false;
  }
  return true;
}

type RootManifest = Record<string, unknown> & {
  scripts?: { name: string }[];
  widgets?: { name: string }[];
  homeScreenName?: string;
  defaultLanguage?: string;
  languages?: string[];
};

function buildManifestObject(
  existing: RootManifest,
  cloudApp: Awaited<ReturnType<typeof fetchCloudApp>>,
): RootManifest {
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

async function buildAndWriteManifest(
  projectRoot: string,
  cloudApp: Awaited<ReturnType<typeof fetchCloudApp>>,
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

export async function pullCommand(options: PullOptions = {}): Promise<void> {
  const { projectRoot, config, appKey, appId } = await resolveAppContext(options.appKey);
  const appConfig = config.apps[appKey];
  void appConfig; // reserved for future pull options

  const session = await getValidAuthSession();
  if (!session.ok) {
    // eslint-disable-next-line no-console
    console.error(session.message);
    return;
  }
  const { idToken, userId } = session;

  const access = await withSpinner('Checking app access...', () =>
    checkAppAccess(appId, idToken, userId),
  );
  if (!access.ok) {
    // eslint-disable-next-line no-console
    console.error(access.message);
    return;
  }

  const cloudApp = await withSpinner('Fetching cloud app...', () =>
    fetchCloudApp(appId, idToken),
  );
  await writeVerbose(
    projectRoot,
    'ensemble-cloud-app.json',
    cloudApp,
    options.verbose ?? false,
  );

  // Fast-path: detect if pull would be a no-op.
  const localFiles = await collectAppFiles(projectRoot);

  const expectedScreens: Record<string, string> = {};
  for (const s of cloudApp.screens ?? []) {
    if (s.isArchived === true) continue;
    expectedScreens[safeFileName(s.name, '.yaml')] = s.content ?? '';
  }

  const expectedWidgets: Record<string, string> = {};
  for (const w of cloudApp.widgets ?? []) {
    if (w.isArchived === true) continue;
    expectedWidgets[safeFileName(w.name, '.yaml')] = w.content ?? '';
  }

  const expectedScripts: Record<string, string> = {};
  for (const s of cloudApp.scripts ?? []) {
    if (s.isArchived === true) continue;
    expectedScripts[safeFileName(s.name, '.js')] = s.content ?? '';
  }

  const expectedTranslations: Record<string, string> = {};
  for (const t of cloudApp.translations ?? []) {
    if (t.isArchived === true) continue;
    expectedTranslations[safeFileName(t.name, '.yaml')] = t.content ?? '';
  }

  const expectedThemeContent =
    cloudApp.theme && cloudApp.theme.isArchived !== true
      ? cloudApp.theme.content ?? ''
      : undefined;

  const screensMatch = mapsEqual(expectedScreens, localFiles.screens);
  const widgetsMatch = mapsEqual(expectedWidgets, localFiles.widgets);
  const scriptsMatch = mapsEqual(expectedScripts, localFiles.scripts);
  const translationsMatch = mapsEqual(expectedTranslations, localFiles.translations);
  let themeMatch = false;
  if (expectedThemeContent === undefined) {
    themeMatch = localFiles.theme === undefined;
  } else {
    themeMatch = localFiles.theme === expectedThemeContent;
  }

  // Manifest no-op check: compare current manifest JSON to what pull would write.
  const manifestPath = path.join(projectRoot, '.manifest.json');
  let manifestRaw = '';
  let manifestExisting: RootManifest = {};
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf8');
    manifestExisting = JSON.parse(manifestRaw) as RootManifest;
  } catch {
    manifestRaw = '';
    manifestExisting = {};
  }
  const manifestExpectedObj = buildManifestObject(manifestExisting, cloudApp);
  const manifestExpectedRaw = JSON.stringify(manifestExpectedObj, null, 2) + '\n';
  const manifestMatch =
    (manifestRaw === '' && manifestExpectedRaw === JSON.stringify({}, null, 2) + '\n') ||
    manifestRaw === manifestExpectedRaw;

  if (screensMatch && widgetsMatch && scriptsMatch && translationsMatch && themeMatch && manifestMatch) {
    console.log('Up to date. Nothing to pull.');
    return;
  }

  const warning =
    'This will REPLACE your local app artifacts with the cloud version.';

  console.warn(warning);

  let confirmed = options.yes ?? false;
  if (!confirmed) {
    const { proceed } = await prompts({
      type: 'confirm',
      name: 'proceed',
      message: 'Proceed with pull (overwrite local files)?',
      initial: false,
    });
    confirmed = proceed === true;
  }

  if (!confirmed) {
    // eslint-disable-next-line no-console
    console.log('Pull cancelled.');
    return;
  }

  await withSpinner('Writing local files...', async () => {
    const screensDir = path.join(projectRoot, 'screens');
    const widgetsDir = path.join(projectRoot, 'widgets');
    const scriptsDir = path.join(projectRoot, 'scripts');
    const translationsDir = path.join(projectRoot, 'translations');

    await rmDirIfExists(screensDir);
    await rmDirIfExists(widgetsDir);
    await rmDirIfExists(scriptsDir);
    await rmDirIfExists(translationsDir);

    await ensureDir(screensDir);
    await ensureDir(widgetsDir);
    await ensureDir(scriptsDir);
    await ensureDir(translationsDir);

    for (const screen of cloudApp.screens ?? []) {
      if (screen.isArchived === true) continue;
      const filePath = path.join(screensDir, safeFileName(screen.name, '.yaml'));
      await fs.writeFile(filePath, screen.content ?? '', 'utf8');
    }

    for (const widget of cloudApp.widgets ?? []) {
      if (widget.isArchived === true) continue;
      const filePath = path.join(widgetsDir, safeFileName(widget.name, '.yaml'));
      await fs.writeFile(filePath, widget.content ?? '', 'utf8');
    }

    for (const script of cloudApp.scripts ?? []) {
      if (script.isArchived === true) continue;
      const filePath = path.join(scriptsDir, safeFileName(script.name, '.js'));
      await fs.writeFile(filePath, script.content ?? '', 'utf8');
    }

    for (const tr of cloudApp.translations ?? []) {
      if (tr.isArchived === true) continue;
      const filePath = path.join(translationsDir, safeFileName(tr.name, '.yaml'));
      await fs.writeFile(filePath, tr.content ?? '', 'utf8');
    }

    const themePath = path.join(projectRoot, 'theme.yaml');
    if (cloudApp.theme && cloudApp.theme.isArchived !== true) {
      await fs.writeFile(themePath, cloudApp.theme.content ?? '', 'utf8');
    } else {
      await fs.rm(themePath, { force: true });
    }

    await buildAndWriteManifest(projectRoot, cloudApp);
  });

  console.log('Pull complete.');
}

