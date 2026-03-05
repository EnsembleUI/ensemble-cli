import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import {
  checkAppAccess,
  fetchCloudApp,
  submitCliPush,
  FirestoreClientError,
  type FirestoreClientOptions,
  type CloudApp,
} from '../cloud/firestoreClient.js';
import { buildDocumentsFromParsed } from '../core/buildDocuments.js';
import { buildPushPayload, formatDiffSummary, type BundleDiff } from '../core/bundleDiff.js';
import { collectAppFiles } from '../core/appCollector.js';
import { ArtifactProps, type ArtifactProp, type ApplicationDTO } from '../core/dto.js';
import { resolveVerboseFlag } from '../core/cliError.js';
import { resolveAppContext } from '../config/projectConfig.js';
import { getValidAuthSession } from '../auth/session.js';
import { withSpinner } from '../lib/spinner.js';
import { writeVerboseJson } from '../core/debugFiles.js';
import { computePushPlan, type PushSummary, type PushCounts } from '../core/sync.js';
import { buildAndWriteManifest, type RootManifest } from '../core/manifest.js';

export interface PushOptions {
  verbose?: boolean;
  appKey?: string;
  /** Skip confirmation prompt (e.g. for CI) */
  yes?: boolean;
  /** Dry run: show diff but do not push to cloud */
  dryRun?: boolean;
}

const DESTRUCTIVE_CHANGE_PROMPT_THRESHOLD = 25;

function printPushSummary(summary: PushSummary, options: { verbose?: boolean; isNoop?: boolean }) {
  const { appName, environment, counts } = summary;
  const totalChanges = counts.created + counts.updated + counts.deleted;

  if (options.isNoop || totalChanges === 0) {
    console.log(
      `Pushed app "${appName}" to environment "${environment}" (no changes; already up to date).`,
    );
    return;
  }

  const parts: string[] = [];
  if (counts.created > 0) parts.push(`${counts.created} created`);
  if (counts.updated > 0) parts.push(`${counts.updated} updated`);
  if (counts.deleted > 0) parts.push(`${counts.deleted} deleted`);

  console.log(
    `Pushed app "${appName}" to environment "${environment}" (${parts.join(', ')}).`,
  );

  if (options.verbose) {
    const entries: [string, PushCounts][] = [
      ['screens', summary.byKind.screens],
      ['widgets', summary.byKind.widgets],
      ['scripts', summary.byKind.scripts],
      ['translations', summary.byKind.translations],
      ['theme', summary.byKind.theme],
    ];

    for (const [kind, c] of entries) {
      if (c.created === 0 && c.updated === 0 && c.deleted === 0) continue;
      console.log(
        `  ${kind}: ${c.created} created, ${c.updated} updated, ${c.deleted} deleted`,
      );
    }
  }
}

function fileLabel(name: string, defaultExt: string): string {
  if (name.includes('.')) return name;
  return `${name}${defaultExt}`;
}

function printPushDryRun(diff: BundleDiff): void {
  console.log('Push dry run – the following changes would be applied:');

  const printGroup = (
    title: string,
    changed: { name: string; isArchived?: boolean }[],
    added: { name: string }[],
    defaultExt: string,
  ) => {
    if (changed.length === 0 && added.length === 0) return;
    console.log(`\n  ${title}:`);
    for (const item of added) {
      console.log(`    + create ${title.slice(0, -1)} ${fileLabel(item.name, defaultExt)}`);
    }
    for (const item of changed) {
      if (item.isArchived) {
        console.log(
          `    - delete ${title.slice(0, -1)} ${fileLabel(item.name, defaultExt)}`,
        );
      } else {
        console.log(
          `    ~ update ${title.slice(0, -1)} ${fileLabel(item.name, defaultExt)}`,
        );
      }
    }
  };

  printGroup('screens', diff.screens.changed, diff.screens.new, '.yaml');
  printGroup('widgets', diff.widgets.changed, diff.widgets.new, '.yaml');
  printGroup('scripts', diff.scripts.changed, diff.scripts.new, '.js');
  printGroup('translations', diff.translations.changed, diff.translations.new, '.yaml');

  if (diff.themeChanged) {
    console.log('\n  theme:');
    console.log('    ~ update theme theme.yaml');
  }

  console.log(
    '\nRun `ensemble push` without `--dry-run` to apply these changes.',
  );
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

async function readExistingManifest(root: string): Promise<RootManifest | null> {
  const manifestPath = path.join(root, '.manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as RootManifest;
  } catch {
    return null;
  }
}

function hasManifestRelevantChanges(cloudApp: CloudApp, diff: BundleDiff): boolean {
  // Any new artifacts in these kinds will affect manifest lists or home screen/languages.
  if (
    diff.screens.new.length > 0 ||
    diff.widgets.new.length > 0 ||
    diff.scripts.new.length > 0 ||
    diff.translations.new.length > 0
  ) {
    return true;
  }

  const scriptsCloudById = new Map((cloudApp.scripts ?? []).map((s) => [s.id, s]));
  const scriptsCloudByName = new Map((cloudApp.scripts ?? []).map((s) => [s.name, s]));
  for (const changed of diff.scripts.changed) {
    const cloud = scriptsCloudById.get(changed.id) ?? scriptsCloudByName.get(changed.name);
    if (!cloud) continue;
    if ((changed.isArchived ?? false) !== (cloud.isArchived ?? false)) {
      return true;
    }
  }

  const widgetsCloudById = new Map((cloudApp.widgets ?? []).map((w) => [w.id, w]));
  const widgetsCloudByName = new Map((cloudApp.widgets ?? []).map((w) => [w.name, w]));
  for (const changed of diff.widgets.changed) {
    const cloud = widgetsCloudById.get(changed.id) ?? widgetsCloudByName.get(changed.name);
    if (!cloud) continue;
    if ((changed.isArchived ?? false) !== (cloud.isArchived ?? false)) {
      return true;
    }
  }

  const translationsCloudById = new Map((cloudApp.translations ?? []).map((t) => [t.id, t]));
  const translationsCloudByName = new Map((cloudApp.translations ?? []).map((t) => [t.name, t]));
  for (const changed of diff.translations.changed) {
    const cloud = translationsCloudById.get(changed.id) ?? translationsCloudByName.get(changed.name);
    if (!cloud) continue;
    if ((changed.isArchived ?? false) !== (cloud.isArchived ?? false)) {
      return true;
    }
    if ((changed as { defaultLocale?: boolean }).defaultLocale !== (cloud as { defaultLocale?: boolean }).defaultLocale) {
      return true;
    }
  }

  const screensCloudById = new Map((cloudApp.screens ?? []).map((s) => [s.id, s]));
  const screensCloudByName = new Map((cloudApp.screens ?? []).map((s) => [s.name, s]));
  for (const changed of diff.screens.changed) {
    const cloud = screensCloudById.get(changed.id) ?? screensCloudByName.get(changed.name);
    if (!cloud) continue;
    if ((changed.isArchived ?? false) !== (cloud.isArchived ?? false)) {
      return true;
    }
    if ((changed as { isRoot?: boolean }).isRoot !== (cloud as { isRoot?: boolean }).isRoot) {
      return true;
    }
  }

  return false;
}

export async function pushCommand(options: PushOptions = {}): Promise<void> {
  const root = process.cwd();
  const verbose = resolveVerboseFlag(options.verbose);
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
    console.error('Run `ensemble login` and try again.');
    process.exitCode = 1;
    return;
  }
  const { idToken, userId } = session;

  const debugEnabled = verbose;
  const firestoreOptions: FirestoreClientOptions | undefined = debugEnabled
    ? {
        debug: (event) => {
          // eslint-disable-next-line no-console
          console.log(
            `[debug:firestore] ${event.kind}`,
            JSON.stringify(
              {
                ...(event.kind === 'request' && {
                  method: event.method,
                  url: event.url,
                  context: event.context,
                }),
                ...(event.kind === 'response' && {
                  method: event.method,
                  url: event.url,
                  status: event.status,
                  context: event.context,
                }),
                ...(event.kind === 'list_documents' && {
                  collection: event.collection,
                  parentPath: event.parentPath,
                  count: event.count,
                }),
                ...(event.kind === 'push_operation' && {
                  appId: event.appId,
                  operation: event.operation,
                  artifactKind: event.artifactKind,
                  documentId: event.documentId,
                }),
              },
              null,
              2,
            ),
          );
        },
      }
    : undefined;

  const access = await withSpinner('Checking app access...', () =>
    checkAppAccess(appId, idToken, userId, firestoreOptions),
  );
  if (!access.ok) {
    console.error(access.message);
    if (access.reason === 'not_logged_in') {
      console.error('Run `ensemble login` and try again.');
    } else if (access.reason === 'network_error') {
      console.error('Check your internet connection or proxy settings.');
    }
    process.exitCode = 1;
    return;
  }

  const [data, defaultLanguage] = await withSpinner(
    'Collecting app files...',
    async () => {
      const [files, defLang] = await Promise.all([
        collectAppFiles(root),
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
  await writeVerboseJson(root, 'ensemble-local-app.json', localApp, {
    verbose,
  });

  let cloudApp: Awaited<ReturnType<typeof fetchCloudApp>> | null = null;
  try {
    cloudApp = await withSpinner('Fetching cloud app...', () =>
      fetchCloudApp(appId, idToken, firestoreOptions),
    );
  } catch (err) {
    console.error('Failed to fetch app from cloud.');
    if (err instanceof FirestoreClientError) {
      console.error(`${err.message} (${err.code})`);
      if (err.hint) {
        console.error(err.hint);
      }
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    if (!(err instanceof FirestoreClientError)) {
      console.error('Check your internet connection or proxy settings, then try again.');
    } else if (err.code === 'NETWORK_UNAVAILABLE') {
      console.error('Check your internet connection or proxy settings, then try again.');
    } else if (err.code === 'AUTH_EXPIRED') {
      console.error('Run `ensemble login` and try again.');
    }
    process.exitCode = 1;
    return;
  }
  let bundle: typeof localApp | null = null;
  if (cloudApp) {
    await writeVerboseJson(root, 'ensemble-cloud-app.json', cloudApp, {
      verbose,
    });
  }

  if (cloudApp) {
    const updatedBy = {
      name: session.name ?? session.email ?? 'CLI',
      email: session.email,
      id: session.userId,
    };
    const plan = computePushPlan({
      appId,
      appName,
      environment: appKey,
      localApp,
      cloudApp,
      enabledByProp,
      updatedBy,
    });
    bundle = plan.bundle;
    await writeVerboseJson(root, 'ensemble-bundle.json', bundle, {
      verbose,
    });
    await writeVerboseJson(root, 'ensemble-diff.json', plan.diff, {
      verbose,
    });

    const summary = plan.summary;
    const changedCount =
      summary.counts.created + summary.counts.updated + summary.counts.deleted;

    if (changedCount === 0) {
      console.log('Up to date. Nothing to push.');
      return;
    }

    if (options.dryRun) {
      printPushDryRun(plan.diff);
      return;
    }

    console.log('Changes to be pushed:');
    for (const line of formatDiffSummary(plan.diff)) {
      console.log(line);
    }

    // Load existing manifest so we only warn when deletes actually affect it.
    const existingManifest = await readExistingManifest(root);

    // Detect deletions that are both being deleted in cloud and referenced in .manifest.json.
    const deletedScriptsAll = plan.diff.scripts.changed
      .filter((i) => i.isArchived)
      .map((i) => i.name);
    const deletedWidgetsAll = plan.diff.widgets.changed
      .filter((i) => i.isArchived)
      .map((i) => i.name);
    const deletedTranslationsAll = plan.diff.translations.changed
      .filter((i) => i.isArchived)
      .map((i) => i.name);
    const deletedScreensAll = plan.diff.screens.changed
      .filter((i) => i.isArchived)
      .map((i) => i.name);

    let manifestScriptsToWarn: string[] = [];
    let manifestWidgetsToWarn: string[] = [];
    let manifestTranslationsToWarn: string[] = [];
    let manifestHomeScreensToWarn: string[] = [];

    if (existingManifest) {
      const manifestScriptNames = new Set(
        (existingManifest.scripts ?? []).map((s: { name: string }) => s.name),
      );
      const manifestWidgetNames = new Set(
        (existingManifest.widgets ?? []).map((w: { name: string }) => w.name),
      );
      const manifestLanguages = new Set<string>(existingManifest.languages ?? []);
      const manifestDefaultLanguage =
        typeof existingManifest.defaultLanguage === 'string'
          ? existingManifest.defaultLanguage
          : undefined;
      const manifestHomeScreen =
        typeof existingManifest.homeScreenName === 'string'
          ? existingManifest.homeScreenName
          : undefined;

      manifestScriptsToWarn = deletedScriptsAll.filter((name) => manifestScriptNames.has(name));
      manifestWidgetsToWarn = deletedWidgetsAll.filter((name) => manifestWidgetNames.has(name));
      manifestTranslationsToWarn = deletedTranslationsAll.filter(
        (name) => manifestLanguages.has(name) || name === manifestDefaultLanguage,
      );
      manifestHomeScreensToWarn = manifestHomeScreen
        ? deletedScreensAll.filter((name) => name === manifestHomeScreen)
        : [];
    }

    const manifestNeedsRefresh = hasManifestRelevantChanges(cloudApp, plan.diff);

    let confirmed = options.yes ?? false;
    const isInteractive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    const hasDeletes = summary.counts.deleted > 0;
    const largeChangeSet =
      summary.counts.created + summary.counts.updated + summary.counts.deleted >=
      DESTRUCTIVE_CHANGE_PROMPT_THRESHOLD;

    if (!confirmed) {
      if (!isInteractive) {
        console.error(
          'Refusing to run push non-interactively without --yes. Re-run with --dry-run to inspect changes.',
        );
        process.exitCode = 1;
        return;
      }

      const headline = hasDeletes || largeChangeSet
        ? `This will delete ${summary.counts.deleted} item(s) and apply ${
            summary.counts.created + summary.counts.updated
          } other change(s). Continue? [y/N]`
        : 'Proceed with push?';

      const { proceed } = await prompts({
        type: 'confirm',
        name: 'proceed',
        message: headline,
        // Default to "No" for destructive operations.
        initial: !(hasDeletes || largeChangeSet),
      });
      confirmed = proceed === true;
    } else if (hasDeletes || largeChangeSet) {
      console.log(
        'Proceeding without interactive confirmation because --yes was provided.',
      );
    }

    if (!confirmed) {
      console.log('Push cancelled.');
      process.exitCode = 130;
      return;
    }

    const pushPayload = buildPushPayload(bundle!, plan.diff, cloudApp, updatedBy);
    await writeVerboseJson(root, 'ensemble-push-payload.json', pushPayload, {
      verbose,
    });

    try {
      await withSpinner('Pushing changes to cloud...', () =>
        submitCliPush(appId, idToken, pushPayload, firestoreOptions),
      );

      if (manifestNeedsRefresh && bundle) {
        // Only refresh manifest when artifact changes can affect its contents,
        // and build it from the merged bundle we just pushed (no extra network call).
        try {
          await withSpinner('Refreshing local manifest...', async () => {
            await buildAndWriteManifest(root, bundle as CloudApp);
          });
        } catch (manifestErr) {
          if (verbose) {
            // eslint-disable-next-line no-console
            console.error(
              'Push succeeded, but failed to refresh .manifest.json. You can run "ensemble pull" later to regenerate it.',
            );
            // eslint-disable-next-line no-console
            console.error(
              manifestErr instanceof Error ? manifestErr.message : String(manifestErr),
            );
          }
        }
      }
    } catch (err) {
      console.error('Push failed.');
      if (err instanceof FirestoreClientError) {
        console.error(`${err.message} (${err.code})`);
        if (err.hint) {
          console.error(err.hint);
        }
        if (err.code === 'AUTH_EXPIRED') {
          console.error('Authentication failed. Run `ensemble login` and try again.');
        } else if (err.code === 'NETWORK_UNAVAILABLE') {
          console.error('Network error. Check your internet connection or proxy settings.');
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        if (/401|403|unauth|expired/i.test(message)) {
          console.error('Authentication failed. Run `ensemble login` and try again.');
        } else if (/network|ECONN|ENOTFOUND|ETIMEDOUT|timeout/i.test(message)) {
          console.error('Network error. Check your internet connection or proxy settings.');
        }
      }
      process.exitCode = 1;
      return;
    }

    printPushSummary(summary, { verbose, isNoop: false });
  }
}
