import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import {
  checkAppAccess,
  createVersion,
  fetchCloudApp,
  submitCliPush,
  FirestoreClientError,
  type FirestoreClientOptions,
  type CloudApp,
} from '../cloud/firestoreClient.js';
import { buildDocumentsFromParsed } from '../core/buildDocuments.js';
import { buildPushPayload, formatDiffSummary, type BundleDiff } from '../core/bundleDiff.js';
import { collectAppFiles } from '../core/appCollector.js';
import { ArtifactProps, type ArtifactProp } from '../core/artifacts.js';
import { resolveVerboseFlag } from '../core/cliError.js';
import { resolveAppContext } from '../config/projectConfig.js';
import { getValidAuthSession } from '../auth/session.js';
import { withSpinner } from '../lib/spinner.js';
import { writeVerboseJson } from '../core/debugFiles.js';
import { computePushPlan, type PushSummary, type PushCounts } from '../core/sync.js';
import { buildAndWriteManifest, getCloudHomeScreenName } from '../core/manifest.js';
import { ui } from '../core/ui.js';

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
    ui.info(
      `Pushed app "${appName}" to environment "${environment}" (no changes; already up to date).`,
    );
    return;
  }

  const parts: string[] = [];
  if (counts.created > 0) parts.push(`${counts.created} created`);
  if (counts.updated > 0) parts.push(`${counts.updated} updated`);
  if (counts.deleted > 0) parts.push(`${counts.deleted} deleted`);

  ui.success(`Pushed app "${appName}" to environment "${environment}" (${parts.join(', ')}).`);

  if (options.verbose) {
    const entries: [string, PushCounts][] = [
      ['screens', summary.byKind.screens],
      ['widgets', summary.byKind.widgets],
      ['scripts', summary.byKind.scripts],
      ['actions', summary.byKind.actions],
      ['translations', summary.byKind.translations],
      ['theme', summary.byKind.theme],
    ];

    for (const [kind, c] of entries) {
      if (c.created === 0 && c.updated === 0 && c.deleted === 0) continue;
      // eslint-disable-next-line no-console
      console.log(
        `  ${kind}: ${c.created} created, ${c.updated} updated, ${c.deleted} deleted`,
      );
    }
  }
}

function printPushDryRun(diff: BundleDiff): void {
  ui.heading('Push dry run');
  ui.note('The following changes would be applied:');
  for (const line of formatDiffSummary(diff)) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  ui.note('\nRun `ensemble push` without `--dry-run` to apply these changes.');
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

  const [access, dataWithLang, cloudAppResult] = await withSpinner(
    'Checking app access, collecting files, and fetching cloud app...',
    async () => {
      const [accessRes, filesAndLang, cloudRes] = await Promise.all([
        checkAppAccess(appId, idToken, userId, firestoreOptions),
        Promise.all([collectAppFiles(root), readDefaultLanguage(root)]).then(
          ([files, defLang]) => [files, defLang] as const,
        ),
        fetchCloudApp(appId, idToken, firestoreOptions).catch((e: unknown) => e),
      ]);
      return [accessRes, filesAndLang, cloudRes] as const;
    },
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

  const [data, defaultLanguage] = dataWithLang;
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
  if (cloudAppResult instanceof Error) {
    const err = cloudAppResult;
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
    } else if (err instanceof FirestoreClientError && err.code === 'NETWORK_UNAVAILABLE') {
      console.error('Check your internet connection or proxy settings, then try again.');
    } else if (err instanceof FirestoreClientError && err.code === 'AUTH_EXPIRED') {
      console.error('Run `ensemble login` and try again.');
    }
    process.exitCode = 1;
    return;
  }
  cloudApp = cloudAppResult as CloudApp | null;
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
      ui.info('Up to date. Nothing to push.');
      return;
    }

    const pushPayload = buildPushPayload(bundle!, plan.diff, cloudApp, updatedBy);
    await writeVerboseJson(root, 'ensemble-push-payload.json', pushPayload, {
      verbose,
    });

    if (options.dryRun) {
      printPushDryRun(plan.diff);
      return;
    }

    ui.heading('Changes to be pushed');
    for (const line of formatDiffSummary(plan.diff)) {
      // eslint-disable-next-line no-console
      console.log(line);
    }

    const appHome = appConfig.appHome as string | undefined;
    const cloudHome = getCloudHomeScreenName(cloudApp);
    const hasHomeConflict = appHome && cloudHome && appHome !== cloudHome;
    if (hasHomeConflict && process.stdout.isTTY && process.stdin.isTTY && !options.yes) {
      const { proceed } = await prompts({
        type: 'confirm',
        name: 'proceed',
        message: `Cloud has "${cloudHome}" as root. ensemble.config.json has appHome: "${appHome}". Pushing will set "${appHome}" as root. Continue?`,
        initial: false,
      });
      if (!proceed) {
        ui.warn('Push cancelled.');
        process.exitCode = 130;
        return;
      }
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
        ui.error(
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
      ui.note('Proceeding without interactive confirmation because --yes was provided.');
    }

    if (!confirmed) {
      ui.warn('Push cancelled.');
      process.exitCode = 130;
      return;
    }

    try {
      await withSpinner('Pushing changes to cloud...', () =>
        submitCliPush(appId, idToken, pushPayload, firestoreOptions),
      );

      if (manifestNeedsRefresh && bundle) {
        // Only refresh manifest when artifact changes can affect its contents.
        // Use appHome from config (what we pushed), not cloud's root.
        try {
          await withSpinner('Refreshing local manifest...', async () => {
            await buildAndWriteManifest(root, bundle as CloudApp, {
              appHomeFromConfig: appHome,
              ...(appHome && { homeScreenNameOverride: appHome }),
            });
          });
        } catch (manifestErr) {
          if (verbose) {
            // eslint-disable-next-line no-console
          ui.warn(
            'Push succeeded, but failed to refresh .manifest.json. You can run "ensemble pull" later to regenerate it.',
          );
            // eslint-disable-next-line no-console
            ui.note(
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

    if (isInteractive && !options.yes && bundle) {
      const { createVersion: wantVersion } = await prompts({
        type: 'confirm',
        name: 'createVersion',
        message: 'Create a version (snapshot) of this state?',
        initial: false,
      });
      if (wantVersion) {
        const { message: versionMessage } = await prompts({
          type: 'text',
          name: 'message',
          message: 'Version message:',
          initial: '',
        });
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const snapshot: CloudApp = {
          id: bundle.id,
          name: bundle.name,
          createdAt: bundle.createdAt ?? now.toISOString(),
          updatedAt: bundle.updatedAt ?? now.toISOString(),
          ...(bundle.screens && bundle.screens.length > 0 && { screens: bundle.screens }),
          ...(bundle.widgets && bundle.widgets.length > 0 && { widgets: bundle.widgets }),
          ...(bundle.scripts && bundle.scripts.length > 0 && { scripts: bundle.scripts }),
          ...(bundle.actions && bundle.actions.length > 0 && { actions: bundle.actions }),
          ...(bundle.translations && bundle.translations.length > 0 && { translations: bundle.translations }),
          ...(bundle.theme && { theme: bundle.theme }),
        };
        try {
          await createVersion(
            appId,
            idToken,
            {
              message: typeof versionMessage === 'string' ? versionMessage : '',
              createdAt: now.toISOString(),
              createdBy: updatedBy,
              expiresAt,
              snapshot,
            },
            firestoreOptions,
          );
          ui.success('Version saved. Run `ensemble revert` to revert to this version.');
        } catch (versionErr) {
          ui.warn('Push succeeded, but failed to save version.');
          if (versionErr instanceof FirestoreClientError && versionErr.hint) {
            ui.note(versionErr.hint);
          } else if (verbose && versionErr instanceof Error) {
            ui.note(versionErr.message);
          }
        }
      }
    }
  }
}
