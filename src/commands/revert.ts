import prompts from 'prompts';

import {
  checkAppAccess,
  FirestoreClientError,
  listVersions,
  type FirestoreClientOptions,
  type VersionDoc,
} from '../cloud/firestoreClient.js';
import { applyCloudStateToFs } from '../core/applyToFs.js';
import { ArtifactProps, type ArtifactProp } from '../core/artifacts.js';
import { collectAppFiles } from '../core/appCollector.js';
import { resolveAppContext } from '../config/projectConfig.js';
import { getValidAuthSession } from '../auth/session.js';
import { withSpinner } from '../lib/spinner.js';
import { ui } from '../core/ui.js';

const SHOW_MORE_VALUE = '__show_more__';
const PAGE_SIZE = 5;

export interface RevertOptions {
  /** App alias (defaults to config default) */
  appKey?: string;
  /** Show full log messages */
  verbose?: boolean;
}

function formatVersionChoice(v: VersionDoc): string {
  const date = v.createdAt ? new Date(v.createdAt).toLocaleString() : 'Unknown date';
  const msg = v.message?.trim() ? v.message : '(no message)';
  return `${date} — ${msg}`;
}

export async function revertCommand(options: RevertOptions = {}): Promise<void> {
  const isInteractive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (!isInteractive) {
    ui.error('Revert requires interactive mode to choose a version.');
    process.exitCode = 1;
    return;
  }

  const { projectRoot, config, appKey, appId } = await resolveAppContext(options.appKey);
  const appConfig = config.apps[appKey];
  if (!appConfig) {
    ui.error(`No app configured for key "${appKey}".`);
    process.exitCode = 1;
    return;
  }
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

  const firestoreOptions: FirestoreClientOptions | undefined = undefined;

  try {
  const { access, versions: initialVersions, nextStartAfter: initialNext } = await withSpinner(
    'Loading versions...',
    () =>
      Promise.all([
        checkAppAccess(appId, idToken, userId, firestoreOptions),
        listVersions(appId, idToken, { limit: PAGE_SIZE }, firestoreOptions),
      ]).then(([accessRes, listRes]) => ({
        access: accessRes,
        versions: listRes.versions,
        nextStartAfter: listRes.nextStartAfter,
      })),
  );

  if (!access.ok) {
    ui.error(access.message);
    process.exitCode = 1;
    return;
  }

  if (initialVersions.length === 0) {
    ui.warn('No versions found. Create one with "ensemble push" and choose to save a version.');
    return;
  }

  let allVersions = initialVersions;
  let nextStartAfter: string | undefined = initialNext;
  let versionDoc: VersionDoc;
  for (;;) {
    const choices: { title: string; value: number | string }[] = allVersions.map((v, i) => ({
      title: formatVersionChoice(v),
      value: i,
    }));
    if (nextStartAfter !== undefined) {
      choices.push({ title: 'Show more...', value: SHOW_MORE_VALUE });
    }

    const { selected } = await prompts({
      type: 'select',
      name: 'selected',
      message: 'Choose a version to revert to:',
      choices,
      initial: 0,
    });

    if (selected === undefined) {
      ui.warn('Revert cancelled.');
      process.exitCode = 130;
      return;
    }
    if (selected === SHOW_MORE_VALUE) {
      const nextPage = await withSpinner('Loading versions...', () =>
        listVersions(appId, idToken, { limit: PAGE_SIZE, startAfter: nextStartAfter }, firestoreOptions),
      );
      allVersions = [...allVersions, ...nextPage.versions];
      nextStartAfter = nextPage.nextStartAfter;
      continue;
    }
    versionDoc = allVersions[selected as number];
    break;
  }

  const localFiles = await collectAppFiles(projectRoot);
  const appHome = appConfig.appHome as string | undefined;
  await withSpinner('Writing local files...', () =>
    applyCloudStateToFs(
      projectRoot,
      versionDoc.snapshot,
      localFiles,
      enabledByProp,
      {
        manifestOptions: { appHomeFromConfig: appHome },
        onProgress: (completed, total) => {
          if (total > 0 && completed % 25 === 0) {
            // eslint-disable-next-line no-console
            console.log(`Writing files... (${completed}/${total})`);
          }
        },
      },
    ),
  );
  ui.success('Local files reverted. Run "ensemble push" to apply changes to the cloud.');
  } catch (err) {
    if (err instanceof FirestoreClientError) {
      ui.error(err.message);
      if (err.hint) ui.note(err.hint);
    } else {
      ui.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  }
}
