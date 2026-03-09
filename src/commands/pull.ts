import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import {
  checkAppAccess,
  fetchCloudApp,
  FirestoreClientError,
  type CloudApp,
  type FirestoreClientOptions,
} from '../cloud/firestoreClient.js';
import { collectAppFiles } from '../core/appCollector.js';
import { ArtifactProps, type ArtifactProp } from '../core/dto.js';
import { resolveVerboseFlag } from '../core/cliError.js';
import { resolveAppContext } from '../config/projectConfig.js';
import { getValidAuthSession } from '../auth/session.js';
import { withSpinner } from '../lib/spinner.js';
import { processWithConcurrency } from '../core/concurrency.js';
import { safeFileName } from '../core/fileNames.js';
import { type RootManifest, buildAndWriteManifest } from '../core/manifest.js';
import { writeVerboseJson } from '../core/debugFiles.js';
import { ARTIFACT_FS_CONFIG, computePullPlan, type PullSummary } from '../core/sync.js';

export interface PullOptions {
  verbose?: boolean;
  appKey?: string;
  /** Skip confirmation prompt (e.g. for CI) */
  yes?: boolean;
  /** Dry run: show what would change but do not modify files */
  dryRun?: boolean;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

const PULL_LABELS = {
  new: '✨ new',
  modified: '✏️  modified',
  removed: '🗑️  removed',
} as const;

const PULL_LABEL_WIDTH = 14;

/** Format pull changes as grouped lines with icons. Used for both dry run and actual run. */
function formatPullSummary(changes: PullSummary['changes']): string[] {
  const lines: string[] = [];
  const byKind = new Map<string, { operation: PullSummary['changes'][number]['operation']; file: string }[]>();
  for (const c of changes) {
    if (c.kind === 'manifest') continue; // Manifest is a generated file, never show in summary
    const list = byKind.get(c.kind) ?? [];
    list.push({ operation: c.operation, file: c.file });
    byKind.set(c.kind, list);
  }
  const kindToSection: Record<string, string> = {
    screen: 'screens',
    widget: 'widgets',
    script: 'scripts',
    translation: 'translations',
    theme: 'theme',
  };
  const kindOrder = ['screen', 'widget', 'script', 'translation', 'theme'];
  const processed = new Set<string>();
  const pad = (label: string) => label.padEnd(PULL_LABEL_WIDTH);
  const sortByOp = (list: { operation: string; file: string }[]) =>
    [...list].sort((a, b) => {
      const order = { delete: 0, update: 1, create: 2 };
      return (order[a.operation as keyof typeof order] ?? 3) - (order[b.operation as keyof typeof order] ?? 3);
    });
  for (const kind of kindOrder) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    processed.add(kind);
    lines.push(`  ${kindToSection[kind] ?? kind}:`);
    for (const c of sortByOp(list)) {
      const label =
        c.operation === 'create'
          ? PULL_LABELS.new
          : c.operation === 'update'
            ? PULL_LABELS.modified
            : PULL_LABELS.removed;
      lines.push(`        ${pad(label)}${path.basename(c.file)}`);
    }
  }
  for (const [kind, list] of byKind) {
    if (processed.has(kind) || kind === 'manifest') continue;
    lines.push(`  ${kindToSection[kind] ?? kind}:`);
    for (const c of sortByOp(list)) {
      const label =
        c.operation === 'create'
          ? PULL_LABELS.new
          : c.operation === 'update'
            ? PULL_LABELS.modified
            : PULL_LABELS.removed;
      lines.push(`        ${pad(label)}${path.basename(c.file)}`);
    }
  }
  return lines;
}

function printPullDryRun(summary: PullSummary): void {
  const { appName, environment, changes } = summary;

  // eslint-disable-next-line no-console
  console.log(`Pull plan for ${appName} (${environment})`);

  if (changes.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No changes. Local files are already up to date with the cloud app.');
    // eslint-disable-next-line no-console
    console.log(
      'Dry run only: no files were changed. Run `ensemble pull` without `--dry-run` when you are ready to apply remote changes.',
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log('The following changes would be applied:\n');
  for (const line of formatPullSummary(changes)) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  // eslint-disable-next-line no-console
  console.log(
    '\nDry run only: no files were changed. Run `ensemble pull` without `--dry-run` to apply these changes.',
  );
}

function printPullSummary(summary: PullSummary): void {
  const { appName, environment, created, updated, deleted, skipped } = summary;
  const total = created + updated + deleted;

  if (total === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `Pulled app ${appName} (${environment}): no file changes were applied (metadata may have been updated).`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `Pulled app ${appName} (${environment}): applied ${total} change${
        total === 1 ? '' : 's'
      } (created: ${created}, updated: ${updated}, deleted: ${deleted}, skipped: ${skipped}).`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    'Next steps: Review the updated files in your editor or version control, then run your tests.',
  );
}

export async function pullCommand(options: PullOptions = {}): Promise<void> {
  const { projectRoot, config, appKey, appId } = await resolveAppContext(options.appKey);
  const verbose = resolveVerboseFlag(options.verbose);
  const appConfig = config.apps[appKey];
  const appName = (appConfig.name as string | undefined) ?? 'App';
  const environment = appKey;
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

  const manifestPath = path.join(projectRoot, '.manifest.json');
  const readManifest = (): Promise<RootManifest> =>
    fs.readFile(manifestPath, 'utf8').then(
      (raw) => JSON.parse(raw) as RootManifest,
      () => ({}),
    );

  const [access, cloudAppResult, localFiles, manifestExisting] = await withSpinner(
    'Checking app access, fetching cloud app, and collecting files...',
    async () => {
      const [accessRes, cloudRes, files, manifest] = await Promise.all([
        checkAppAccess(appId, idToken, userId, firestoreOptions),
        fetchCloudApp(appId, idToken, firestoreOptions).catch((e: unknown) => e),
        collectAppFiles(projectRoot),
        readManifest(),
      ]);
      return [accessRes, cloudRes, files, manifest] as const;
    },
  );

  if (!access.ok) {
    // eslint-disable-next-line no-console
    console.error(access.message);
    process.exitCode = 1;
    return;
  }

  if (cloudAppResult instanceof Error) {
    const err = cloudAppResult;
    // eslint-disable-next-line no-console
    console.error('Failed to fetch app from cloud.');
    if (err instanceof FirestoreClientError) {
      // eslint-disable-next-line no-console
      console.error(`${err.message} (${err.code})`);
      if (err.hint) {
        // eslint-disable-next-line no-console
        console.error(err.hint);
      }
    } else {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : String(err));
    }
    if (!(err instanceof FirestoreClientError)) {
      // eslint-disable-next-line no-console
      console.error('Check your internet connection or proxy settings, then try again.');
    } else if (err.code === 'NETWORK_UNAVAILABLE') {
      // eslint-disable-next-line no-console
      console.error('Check your internet connection or proxy settings, then try again.');
    } else if (err.code === 'AUTH_EXPIRED') {
      // eslint-disable-next-line no-console
      console.error('Run `ensemble login` and try again.');
    }
    process.exitCode = 1;
    return;
  }
  const cloudApp = cloudAppResult as CloudApp;

  await writeVerboseJson(projectRoot, 'ensemble-cloud-app.json', cloudApp, {
    verbose,
  });

  const plan = computePullPlan({
    appName,
    environment,
    cloudApp,
    localFiles,
    manifestExisting,
    enabledByProp,
  });

  if (plan.allArtifactsMatch && plan.manifestMatch) {
    console.log('Up to date. Nothing to pull.');
    return;
  }

  const pullSummary: PullSummary = plan.summary;

  if (pullSummary.changes.length > 0 && !options.dryRun) {
    // eslint-disable-next-line no-console
    console.log('Changes to be pulled:\n');
    for (const line of formatPullSummary(pullSummary.changes)) {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  if (options.dryRun) {
    printPullDryRun(pullSummary);
    return;
  }

  if (pullSummary.updated > 0 || pullSummary.deleted > 0) {
    // eslint-disable-next-line no-console
    console.log(
      'If you are unsure, cancel this pull and re-run with `--dry-run` to inspect the plan, or back up your local changes first.',
    );
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
    type WriteTask =
      | { op: 'write'; filePath: string; content: string }
      | { op: 'delete'; filePath: string };

    const tasks: WriteTask[] = [];

    for (const cfg of ARTIFACT_FS_CONFIG) {
      const { prop, ext, isTheme } = cfg;
      if (!enabledByProp[prop]) continue;

      if (isTheme) {
        const themePath = path.join(projectRoot, 'theme.yaml');
        if (cloudApp.theme && cloudApp.theme.isArchived !== true) {
          tasks.push({
            op: 'write',
            filePath: themePath,
            content: cloudApp.theme.content ?? '',
          });
        } else {
          tasks.push({ op: 'delete', filePath: themePath });
        }
        continue;
      }

      const baseDir = path.join(projectRoot, prop);
      await ensureDir(baseDir);

      const cloudItems = (cloudApp as Record<string, unknown>)[prop] as
        | { name: string; content?: string; isArchived?: boolean }[]
        | undefined;

      const expected: Record<string, string> = {};
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

      // Writes for new or modified files.
      for (const file of expectedKeys) {
        const content = expected[file] ?? '';
        const filePath = path.join(baseDir, file);
        if (!actualKeys.has(file) || actualMap[file] !== content) {
          tasks.push({ op: 'write', filePath, content });
        }
      }

      // Deletes for files that no longer exist in cloud.
      for (const file of actualKeys) {
        if (!expectedKeys.has(file)) {
          const filePath = path.join(baseDir, file);
          tasks.push({ op: 'delete', filePath });
        }
      }
    }

    let completed = 0;
    const total = tasks.length;

    await processWithConcurrency(tasks, async (task) => {
      if (task.op === 'write') {
        await fs.writeFile(task.filePath, task.content, 'utf8');
      } else {
        await fs.rm(task.filePath, { force: true });
      }
      completed += 1;
      if (total > 0 && completed % 25 === 0) {
        // eslint-disable-next-line no-console
        console.log(`Writing files... (${completed}/${total})`);
      }
    });

    await buildAndWriteManifest(projectRoot, cloudApp);
  });

  printPullSummary(pullSummary);
}

