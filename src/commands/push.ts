import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import {
  checkAppAccess,
  fetchCloudApp,
  submitCliPush,
  FirestoreClientError,
  type FirestoreClientOptions,
} from '../cloud/firestoreClient.js';
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
import { resolveVerboseFlag } from '../core/cliError.js';
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

interface PushCounts {
  created: number;
  updated: number;
  deleted: number;
}

interface PushSummary {
  appId: string;
  appName: string;
  environment: string;
  counts: PushCounts;
  byKind: {
    screens: PushCounts;
    widgets: PushCounts;
    scripts: PushCounts;
    translations: PushCounts;
    theme: PushCounts;
  };
}

const DESTRUCTIVE_CHANGE_PROMPT_THRESHOLD = 25;

function computeKindCounts(items: BundleDiff['screens']): PushCounts {
  let created = 0;
  let updated = 0;
  let deleted = 0;

  created += items.new.length;
  for (const item of items.changed) {
    if (item.isArchived) {
      deleted += 1;
    } else {
      updated += 1;
    }
  }

  return { created, updated, deleted };
}

function computePushSummary(
  appId: string,
  appName: string,
  environment: string,
  diff: BundleDiff,
): PushSummary {
  const screens = computeKindCounts(diff.screens);
  const widgets = computeKindCounts(diff.widgets);
  const scripts = computeKindCounts(diff.scripts);
  const translations = computeKindCounts(diff.translations);

  // Theme currently only supports modified (no explicit create/delete in diff),
  // so treat a changed theme as an update.
  const theme: PushCounts = diff.themeChanged
    ? { created: 0, updated: 1, deleted: 0 }
    : { created: 0, updated: 0, deleted: 0 };

  const counts: PushCounts = {
    created:
      screens.created +
      widgets.created +
      scripts.created +
      translations.created +
      theme.created,
    updated:
      screens.updated +
      widgets.updated +
      scripts.updated +
      translations.updated +
      theme.updated,
    deleted:
      screens.deleted +
      widgets.deleted +
      scripts.deleted +
      translations.deleted +
      theme.deleted,
  };

  return {
    appId,
    appName,
    environment,
    counts,
    byKind: {
      screens,
      widgets,
      scripts,
      translations,
      theme,
    },
  };
}

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
  await writeVerbose(root, 'ensemble-local-app.json', localApp, verbose);

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
  let bundle: Awaited<ReturnType<typeof buildMergedBundle>> | null = null;
  if (cloudApp) {
    await writeVerbose(root, 'ensemble-cloud-app.json', cloudApp, verbose);
  }

  if (cloudApp) {
    const updatedBy = {
      name: session.name ?? session.email ?? 'CLI',
      email: session.email,
      id: session.userId,
    };
    bundle = buildMergedBundle(localApp, cloudApp, updatedBy);
    await writeVerbose(root, 'ensemble-bundle.json', bundle, verbose);
    let diff: BundleDiff | null = computeBundleDiff(bundle, cloudApp);
    await writeVerbose(root, 'ensemble-diff.json', diff, verbose);

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

    const summary = computePushSummary(appId, appName, appKey, diff);
    const changedCount =
      summary.counts.created + summary.counts.updated + summary.counts.deleted;

    if (changedCount === 0) {
      console.log('Up to date. Nothing to push.');
      return;
    }

    if (options.dryRun) {
      printPushDryRun(diff);
      return;
    }

    console.log('Changes to be pushed:');
    for (const line of formatDiffSummary(diff)) {
      console.log(line);
    }

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

    const pushPayload = buildPushPayload(bundle!, diff, cloudApp, updatedBy);
    await writeVerbose(root, 'ensemble-push-payload.json', pushPayload, verbose);

    try {
      await withSpinner('Pushing changes to cloud...', () =>
        submitCliPush(appId, idToken, pushPayload, firestoreOptions),
      );
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
