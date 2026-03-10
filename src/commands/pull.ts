import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';
import pc from 'picocolors';

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
import { ui } from '../core/ui.js';

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

const PULL_LABEL_TEXT = {
  new: '🍀 new',
  modified: '✏️  modified',
  removed: '❌  removed',
} as const;

const PULL_LABEL_WIDTH = 14;
const PULL_LINE_PREFIX = '        ';

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
  const formatLabel = (raw: string, color: (value: string) => string) =>
    color(pad(raw));
  const sortByOp = (list: { operation: string; file: string }[]) =>
    [...list].sort((a, b) => {
      const order = { delete: 0, update: 1, create: 2 };
      return (order[a.operation as keyof typeof order] ?? 3) - (order[b.operation as keyof typeof order] ?? 3);
    });
  for (const kind of kindOrder) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    processed.add(kind);
    lines.push(pc.cyan(pc.bold(`  ${kindToSection[kind] ?? kind}:`)));
    for (const c of sortByOp(list)) {
      const label =
        c.operation === 'create'
          ? formatLabel(PULL_LABEL_TEXT.new, pc.green)
          : c.operation === 'update'
            ? formatLabel(PULL_LABEL_TEXT.modified, pc.yellow)
            : formatLabel(PULL_LABEL_TEXT.removed, pc.red);
      lines.push(`${PULL_LINE_PREFIX}${label} ${path.basename(c.file)}`);
    }
  }
  for (const [kind, list] of byKind) {
    if (processed.has(kind) || kind === 'manifest') continue;
    lines.push(pc.cyan(pc.bold(`  ${kindToSection[kind] ?? kind}:`)));
    for (const c of sortByOp(list)) {
      const label =
        c.operation === 'create'
          ? formatLabel(PULL_LABEL_TEXT.new, pc.green)
          : c.operation === 'update'
            ? formatLabel(PULL_LABEL_TEXT.modified, pc.yellow)
            : formatLabel(PULL_LABEL_TEXT.removed, pc.red);
      lines.push(`${PULL_LINE_PREFIX}${label} ${path.basename(c.file)}`);
    }
  }
  return lines;
}

function printPullDryRun(summary: PullSummary): void {
  const { appName, environment, changes } = summary;

  ui.heading(`Pull plan for ${appName} (${environment})`);

  if (changes.length === 0) {
    ui.info('No changes. Local files are already up to date with the cloud app.');
    ui.note(
      'Dry run only: no files were changed. Run `ensemble pull` without `--dry-run` when you are ready to apply remote changes.',
    );
    return;
  }

  ui.note('The following changes would be applied:\n');
  for (const line of formatPullSummary(changes)) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  ui.note(
    '\nDry run only: no files were changed. Run `ensemble pull` without `--dry-run` to apply these changes.',
  );
}

function printPullSummary(summary: PullSummary): void {
  const { appName, environment, created, updated, deleted, skipped } = summary;
  const total = created + updated + deleted;

  if (total === 0) {
    ui.info(
      `Pulled app ${appName} (${environment}): no file changes were applied (metadata may have been updated).`,
    );
  } else {
    ui.success(
      `Pulled app ${appName} (${environment}): applied ${total} change${
        total === 1 ? '' : 's'
      } (created: ${created}, updated: ${updated}, deleted: ${deleted}, skipped: ${skipped}).`,
    );
  }
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
    ui.error(session.message);
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
    ui.error(access.message);
    process.exitCode = 1;
    return;
  }

  if (cloudAppResult instanceof Error) {
    const err = cloudAppResult;
    ui.error('Failed to fetch app from cloud.');
    if (err instanceof FirestoreClientError) {
      // eslint-disable-next-line no-console
      ui.error(`${err.message} (${err.code})`);
      if (err.hint) {
        ui.note(err.hint);
      }
    } else {
      ui.error(err instanceof Error ? err.message : String(err));
    }
    if (!(err instanceof FirestoreClientError)) {
      // eslint-disable-next-line no-console
      ui.error('Check your internet connection or proxy settings, then try again.');
    } else if (err.code === 'NETWORK_UNAVAILABLE') {
      // eslint-disable-next-line no-console
      ui.error('Check your internet connection or proxy settings, then try again.');
    } else if (err.code === 'AUTH_EXPIRED') {
      ui.error('Run `ensemble login` and try again.');
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
    ui.info('Up to date. Nothing to pull.');
    return;
  }

  const pullSummary: PullSummary = plan.summary;

  if (pullSummary.changes.length > 0 && !options.dryRun) {
    ui.heading('Changes to be pulled');
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
    ui.note(
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
    ui.warn('Pull cancelled.');
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

