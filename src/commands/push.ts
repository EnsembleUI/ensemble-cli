import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import { checkAppAccess, fetchCloudApp, submitCliPush } from '../cloud/firestoreClient.js';
import {
  buildDocumentsFromParsed,
  buildMergedBundle,
} from '../core/buildDocuments.js';
import {
  computeBundleDiff,
  buildPushPayload,
  formatDiffSummary,
  type BundleDiff,
} from '../core/bundleDiff.js';
import { collectAppFiles } from '../core/appCollector.js';
import { ArtifactProps, type ArtifactProp } from '../core/dto.js';
import { resolveAppContext } from '../config/projectConfig.js';
import { getValidAuthSession } from '../auth/session.js';
import { withSpinner } from '../lib/spinner.js';

export interface PushOptions {
  verbose?: boolean;
  appKey?: string;
  /** Skip confirmation prompt (e.g. for CI) */
  yes?: boolean;
  /** Dry run: show diff but do not push to cloud */
  dryRun?: boolean;
}

async function writeVerbose(
  root: string,
  filename: string,
  data: unknown,
  verbose: boolean,
): Promise<void> {
  if (!verbose) return;
  const filePath = path.join(root, filename);
  const replacer = (key: string, value: unknown) => {
    if (key === 'content' && typeof value === 'string') {
      const limit = 2000;
      return value.length > limit ? `${value.slice(0, limit)}\n/* ... truncated ... */` : value;
    }
    return value;
  };
  await fs.writeFile(filePath, JSON.stringify(data, replacer, 2), 'utf8');
  console.log(`Wrote ${filePath}`);
}

async function readDefaultLanguage(root: string): Promise<string | undefined> {
  const manifestPath = path.join(root, '.manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as { defaultLanguage?: unknown };
    const value = parsed.defaultLanguage;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function pushCommand(options: PushOptions = {}): Promise<void> {
  const root = process.cwd();
  const { config, appKey, appId } = await resolveAppContext(options.appKey);
  const appConfig = config.apps[appKey];
  const appName = (appConfig.name as string | undefined) ?? 'App';
  const appOptions = (appConfig.options ?? {}) as Record<string, unknown>;
  const enabledByProp = Object.fromEntries(
    ArtifactProps.map((prop) => [prop, appOptions[prop] !== false]),
  ) as Record<ArtifactProp, boolean>;

  const session = await getValidAuthSession();
  if (!session.ok) {
    console.error(session.message);
    process.exitCode = 1;
    return;
  }
  const { idToken, userId } = session;

  const access = await withSpinner('Checking app access...', () =>
    checkAppAccess(appId, idToken, userId),
  );
  if (!access.ok) {
    console.error(access.message);
    process.exitCode = 1;
    return;
  }

  const [data, defaultLanguage] = await withSpinner(
    'Collecting app files...',
    async () => {
      const [files, defLang] = await Promise.all([
        collectAppFiles(root, appOptions),
        readDefaultLanguage(root),
      ]);
      return [files, defLang] as const;
    },
  );
  const localApp = buildDocumentsFromParsed(
    data,
    appId,
    appName,
    appConfig.appHome as string | undefined,
    defaultLanguage,
  );
  await writeVerbose(root, 'ensemble-local-app.json', localApp, options.verbose ?? false);

  let cloudApp: Awaited<ReturnType<typeof fetchCloudApp>> | null = null;
  try {
    cloudApp = await withSpinner('Fetching cloud app...', () =>
      fetchCloudApp(appId, idToken),
    );
  } catch (err) {
    console.warn('Could not fetch cloud app:', err instanceof Error ? err.message : err);
  }
  if (cloudApp) {
    await writeVerbose(root, 'ensemble-cloud-app.json', cloudApp, options.verbose ?? false);
  }

  let bundle: Awaited<ReturnType<typeof buildMergedBundle>> | null = null;
  let diff: BundleDiff | null = null;
  let changedCount = 0;

  if (cloudApp) {
    const updatedBy = {
      name: session.name ?? session.email ?? 'CLI',
      email: session.email,
      id: session.userId,
    };
    bundle = buildMergedBundle(localApp, cloudApp, updatedBy);
    await writeVerbose(root, 'ensemble-bundle.json', bundle, options.verbose ?? false);
    diff = computeBundleDiff(bundle, cloudApp);
    await writeVerbose(root, 'ensemble-diff.json', diff, options.verbose ?? false);

    // Respect per-artifact app options: ignore changes for disabled kinds, driven by ArtifactProps.
    for (const prop of ArtifactProps) {
      if (enabledByProp[prop]) continue;
      if (prop === 'theme') {
        diff = { ...diff, themeChanged: false };
        continue;
      }
      // For array-backed artifact props, clear out changed/new lists.
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

    changedCount =
      diff.screens.changed.length +
      diff.screens.new.length +
      diff.widgets.changed.length +
      diff.widgets.new.length +
      diff.scripts.changed.length +
      diff.scripts.new.length +
      (diff.themeChanged ? 1 : 0) +
      diff.translations.changed.length +
      diff.translations.new.length;

    if (changedCount === 0) {
      console.log('Up to date. Nothing to push.');
      return;
    }

    console.log('Changes to be pushed:');
    for (const line of formatDiffSummary(diff)) {
      console.log(line);
    }

    if (options.dryRun) {
      console.log('Dry run: no changes were pushed.');
      return;
    }

    let confirmed = options.yes ?? false;
    if (!confirmed) {
      const { proceed } = await prompts({
        type: 'confirm',
        name: 'proceed',
        message: 'Proceed with push?',
        initial: true,
      });
      confirmed = proceed === true;
    }

    if (!confirmed) {
      console.log('Push cancelled.');
      process.exitCode = 130;
      return;
    }

    const pushPayload = buildPushPayload(bundle!, diff!, cloudApp, updatedBy);
    await writeVerbose(
      root,
      'ensemble-push-payload.json',
      pushPayload,
      options.verbose ?? false,
    );

    await withSpinner('Pushing changes to cloud...', () =>
      submitCliPush(appId, idToken, pushPayload),
    );
    console.log('Push complete.');
  }
}
