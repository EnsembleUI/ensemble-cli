import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';
import pc from 'picocolors';

import {
  checkAppAccess,
  fetchCloudApp,
  FirestoreClientError,
  type CloudApp,
} from '../cloud/firestoreClient.js';
import { collectAppFiles } from '../core/appCollector.js';
import { ArtifactProps, type ArtifactProp } from '../core/artifacts.js';
import { resolveVerboseFlag } from '../core/cliError.js';
import { resolveAppContext } from '../config/projectConfig.js';
import { getValidAuthSession } from '../auth/session.js';
import { withSpinner } from '../lib/spinner.js';
import { applyCloudStateToFs } from '../core/applyToFs.js';
import { type RootManifest } from '../core/manifest.js';
import { createFirestoreDebugOptions, writeVerboseJson } from '../core/debugFiles.js';
import { computePullPlan, type PullSummary } from '../core/sync.js';
import { applyCloudAssetsToFs, buildEnvConfigForCloudAssets } from '../core/pullAssets.js';
import { upsertEnvFile } from '../core/envConfig.js';
import { applyCloudEnvToFs, readProjectEnvFiles } from '../core/envSync.js';
import { ui } from '../core/ui.js';

export interface PullOptions {
  verbose?: boolean;
  appKey?: string;
  /** Skip confirmation prompt (e.g. for CI) */
  yes?: boolean;
  /** Dry run: show what would change but do not modify files */
  dryRun?: boolean;
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
  const byKind = new Map<
    string,
    { operation: PullSummary['changes'][number]['operation']; file: string }[]
  >();
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
  const formatLabel = (raw: string, color: (value: string) => string) => color(pad(raw));
  const sortByOp = (list: { operation: string; file: string }[]) =>
    [...list].sort((a, b) => {
      const order = { delete: 0, update: 1, create: 2 };
      return (
        (order[a.operation as keyof typeof order] ?? 3) -
        (order[b.operation as keyof typeof order] ?? 3)
      );
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
      'Dry run only: no files were changed. Run `ensemble pull` without `--dry-run` when you are ready to apply remote changes.'
    );
    return;
  }

  ui.note('The following changes would be applied:\n');
  for (const line of formatPullSummary(changes)) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  ui.note(
    '\nDry run only: no files were changed. Run `ensemble pull` without `--dry-run` to apply these changes.'
  );
}

function printPullSummary(summary: PullSummary): void {
  const { appName, environment, created, updated, deleted, skipped } = summary;
  const total = created + updated + deleted;

  if (total === 0) {
    ui.info(
      `Pulled app ${appName} (${environment}): no file changes were applied (metadata may have been updated).`
    );
  } else {
    ui.success(
      `Pulled app ${appName} (${environment}): applied ${total} change${
        total === 1 ? '' : 's'
      } (created: ${created}, updated: ${updated}, deleted: ${deleted}, skipped: ${skipped}).`
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
    ArtifactProps.map((prop) => [prop, appOptions[prop] !== false])
  ) as Record<ArtifactProp, boolean>;

  const session = await getValidAuthSession();
  if (!session.ok) {
    ui.error(session.message);
    process.exitCode = 1;
    return;
  }
  const { idToken, userId } = session;

  const firestoreOptions = verbose ? createFirestoreDebugOptions() : undefined;

  const manifestPath = path.join(projectRoot, '.manifest.json');
  const readManifest = (): Promise<RootManifest> =>
    fs.readFile(manifestPath, 'utf8').then(
      (raw) => JSON.parse(raw) as RootManifest,
      () => ({})
    );

  const [access, cloudAppResult, localFiles, manifestExisting] = await withSpinner(
    'Preparing app for pull...',
    async () => {
      const [accessRes, cloudRes, files, manifest] = await Promise.all([
        checkAppAccess(appId, idToken, userId, firestoreOptions),
        fetchCloudApp(appId, idToken, firestoreOptions).catch((e: unknown) => e),
        collectAppFiles(projectRoot),
        readManifest(),
      ]);
      return [accessRes, cloudRes, files, manifest] as const;
    }
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
    localEnv: await readProjectEnvFiles(projectRoot, appKey, config.default),
  });

  if (plan.allArtifactsMatch && plan.manifestMatch) {
    ui.info('Up to date. Nothing to pull.');
    return;
  }

  const pullSummary: PullSummary = plan.summary;

  if (pullSummary.changes.length > 0 && !options.dryRun) {
    ui.heading('Changes to be pulled:');
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
      'If you are unsure, cancel this pull and re-run with `--dry-run` to inspect the plan, or back up your local changes first.'
    );
  }

  const isInteractive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let confirmed = options.yes ?? false;
  if (!confirmed && !isInteractive) {
    ui.error(
      'Refusing to run pull non-interactively without --yes. Re-run with --dry-run to inspect changes.'
    );
    process.exitCode = 1;
    return;
  }
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
    await applyCloudStateToFs(projectRoot, cloudApp, localFiles, enabledByProp, {
      refreshManifest: true,
      onProgress: (completed, total) => {
        // eslint-disable-next-line no-console
        console.log(`Writing files... (${completed}/${total})`);
      },
    });
  });

  // Sync assets/ after YAML files are written.
  // This pulls binary files via each asset's publicUrl and deletes local extras.
  await withSpinner('Syncing assets...', async () => {
    const result = await applyCloudAssetsToFs({
      projectRoot,
      cloudAssets: cloudApp.assets,
    });
    // Fold any asset changes into the already-computed pullSummary so the final output reflects what we did.
    if (result.created || result.deleted || result.skipped) {
      (
        pullSummary.changes as PullSummary['changes'] as unknown as Array<{
          kind: string;
          file: string;
          operation: string;
        }>
      ).push(...result.changes);
      (pullSummary as unknown as { created: number }).created += result.created;
      (pullSummary as unknown as { deleted: number }).deleted += result.deleted;
      (pullSummary as unknown as { skipped: number }).skipped += result.skipped;
    }

    if (result.failures.length > 0) {
      ui.warn(`Some assets failed to download (${result.failures.length}).`);
      const maxLines = 8;
      for (const f of result.failures.slice(0, maxLines)) {
        ui.warn(f.message);
      }
      if (result.failures.length > maxLines) {
        ui.note(`(and ${result.failures.length - maxLines} more asset download issues...)`);
      }
    }

    // Always (best-effort) update env config for assets so ${env.assets}${env.<key>} references work after pull.
    const envLayout = await readProjectEnvFiles(projectRoot, appKey, config.default);
    const envResult = buildEnvConfigForCloudAssets(cloudApp.assets);
    if (envResult.entries.length > 0) {
      await upsertEnvFile(projectRoot, envLayout.configWriteFile, envResult.entries);
    }
    if (envResult.failures.length > 0) {
      ui.warn(
        `Some assets had invalid metadata and may be missing from ${envLayout.configWriteFile} (${envResult.failures.length}).`
      );
    }

    await applyCloudEnvToFs(
      projectRoot,
      {
        config: cloudApp.config,
        secrets: cloudApp.secrets,
      },
      (cloudApp.assets ?? [])
        .map((asset) => asset.fileName)
        .filter(
          (fileName): fileName is string => typeof fileName === 'string' && fileName.length > 0
        ),
      appKey,
      config.default
    );
  });

  printPullSummary(pullSummary);
}
