import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import { checkAppAccess, fetchCloudApp } from '../cloud/firestoreClient.js';
import { collectAppFiles } from '../core/appCollector.js';
import { ArtifactProps, type ArtifactProp } from '../core/dto.js';
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

const PULL_LABELS = {
  new: '✨ new',
  modified: '✏️  modified',
  removed: '🗑️  removed',
} as const;

interface ArtifactFsConfig {
  readonly prop: ArtifactProp;
  readonly ext?: string;
  readonly isTheme?: boolean;
}

const ARTIFACT_FS_CONFIG: ArtifactFsConfig[] = [
  { prop: 'screens', ext: '.yaml' },
  { prop: 'widgets', ext: '.yaml' },
  { prop: 'scripts', ext: '.js' },
  { prop: 'translations', ext: '.yaml' },
  { prop: 'theme', isTheme: true },
];

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
  const appOptions = (appConfig.options ?? {}) as Record<string, unknown>;
  const enabledByProp = Object.fromEntries(
    ArtifactProps.map((prop) => [prop, appOptions[prop] !== false]),
  ) as Record<ArtifactProp, boolean>;

  const session = await getValidAuthSession();
  if (!session.ok) {
    // eslint-disable-next-line no-console
    console.error(session.message);
    process.exitCode = 1;
    return;
  }
  const { idToken, userId } = session;

  const access = await withSpinner('Checking app access...', () =>
    checkAppAccess(appId, idToken, userId),
  );
  if (!access.ok) {
    // eslint-disable-next-line no-console
    console.error(access.message);
    process.exitCode = 1;
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

  // Fast-path: detect if pull would be a no-op, respecting app options.
  const localFiles = await collectAppFiles(projectRoot);

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
        themeMatch = localFiles.theme === expectedThemeContent;
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
      expected[safeFileName(item.name, ext!)] = item.content ?? '';
    }
    const actual = (localFiles as unknown as Record<string, unknown>)[
      prop
    ] as Record<string, string> | undefined;
    matchesByProp[prop] = mapsEqual(expected, actual ?? {});
  }

  // Manifest no-op check: compare current manifest JSON to what pull would write.
  const manifestPath = path.join(projectRoot, '.manifest.json');
  let manifestExisting: RootManifest = {};
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifestExisting = JSON.parse(raw) as RootManifest;
  } catch {
    manifestExisting = {};
  }
  const manifestExpectedObj = buildManifestObject(manifestExisting, cloudApp);
  const manifestExpectedRaw = JSON.stringify(manifestExpectedObj, null, 2) + '\n';
  const manifestExistingRaw = JSON.stringify(manifestExisting, null, 2) + '\n';
  const manifestMatch = manifestExistingRaw === manifestExpectedRaw;

  const allArtifactsMatch = ArtifactProps.every(
    (prop) => matchesByProp[prop] ?? true,
  );

  if (allArtifactsMatch && manifestMatch) {
    console.log('Up to date. Nothing to pull.');
    return;
  }

  // Build a human-readable summary of what will change.
  const summaryLines: string[] = [];
  const typeLabelByProp: Record<Exclude<ArtifactProp, 'theme'>, string> = {
    screens: 'screen',
    widgets: 'widget',
    scripts: 'script',
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
      if (expectedThemeContent === actualTheme) continue;
      if (expectedThemeContent && !actualTheme) {
        summaryLines.push(
          `        ${PULL_LABELS.new}  theme - theme.yaml`,
        );
      } else if (!expectedThemeContent && actualTheme) {
        summaryLines.push(
          `        ${PULL_LABELS.removed}  theme - theme.yaml`,
        );
      } else {
        summaryLines.push(
          `        ${PULL_LABELS.modified}  theme - theme.yaml`,
        );
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
      expected[safeFileName(item.name, ext!)] = item.content ?? '';
    }
    const actual = (localFiles as unknown as Record<string, unknown>)[
      prop
    ] as Record<string, string> | undefined;
    const actualMap = actual ?? {};

    const expectedKeys = new Set(Object.keys(expected));
    const actualKeys = new Set(Object.keys(actualMap));

    for (const file of expectedKeys) {
      if (!actualKeys.has(file)) {
        summaryLines.push(
          `        ${PULL_LABELS.new}  ${kind} - ${file}`,
        );
      }
    }
    for (const file of actualKeys) {
      if (!expectedKeys.has(file)) {
        summaryLines.push(
          `        ${PULL_LABELS.removed}  ${kind} - ${file}`,
        );
      }
    }
    for (const file of expectedKeys) {
      if (!actualKeys.has(file)) continue;
      if (expected[file] !== actualMap[file]) {
        summaryLines.push(
          `        ${PULL_LABELS.modified}  ${kind} - ${file}`,
        );
      }
    }
  }

  if (summaryLines.length > 0) {
    // eslint-disable-next-line no-console
    console.log('Changes to be pulled:');
    for (const line of summaryLines) {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

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
    process.exitCode = 130;
    return;
  }

  await withSpinner('Writing local files...', async () => {
    for (const cfg of ARTIFACT_FS_CONFIG) {
      const { prop, ext, isTheme } = cfg;
      if (!enabledByProp[prop]) continue;

      if (isTheme) {
        const themePath = path.join(projectRoot, 'theme.yaml');
        if (cloudApp.theme && cloudApp.theme.isArchived !== true) {
          await fs.writeFile(themePath, cloudApp.theme.content ?? '', 'utf8');
        } else {
          await fs.rm(themePath, { force: true });
        }
        continue;
      }

      const baseDir = path.join(projectRoot, prop);
      await rmDirIfExists(baseDir);
      await ensureDir(baseDir);

      const cloudItems = (cloudApp as Record<string, unknown>)[prop] as
        | { name: string; content?: string; isArchived?: boolean }[]
        | undefined;
      for (const item of cloudItems ?? []) {
        if (item.isArchived === true) continue;
        const filePath = path.join(baseDir, safeFileName(item.name, ext!));
        await fs.writeFile(filePath, item.content ?? '', 'utf8');
      }
    }

    await buildAndWriteManifest(projectRoot, cloudApp);
  });

  console.log('Pull complete.');
}

