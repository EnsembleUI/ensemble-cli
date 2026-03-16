import prompts from 'prompts';

import {
  checkAppAccess,
  createVersion,
  listVersions,
  getVersion,
  FirestoreClientError,
  type CloudApp,
  type FirestoreClientOptions,
  type VersionDoc,
} from '../cloud/firestoreClient.js';
import { applyCloudStateToFs } from '../core/applyToFs.js';
import { buildDocumentsFromParsed } from '../core/buildDocuments.js';
import { ArtifactProps, type ArtifactProp } from '../core/artifacts.js';
import { collectAppFiles } from '../core/appCollector.js';
import { resolveAppContext } from '../config/projectConfig.js';
import { getValidAuthSession } from '../auth/session.js';
import { withSpinner } from '../lib/spinner.js';
import { ui } from '../core/ui.js';

export interface ReleaseCreateOptions {
  /** App alias (defaults to config default) */
  appKey?: string;
  /** Release message/label (skips prompt when provided) */
  message?: string;
  /** Skip message prompt (use empty message) */
  yes?: boolean;
}

export interface ReleaseListOptions {
  /** App alias (defaults to config default) */
  appKey?: string;
  /** Max releases to show (default: 20) */
  limit?: number;
}

export interface ReleaseUseOptions {
  /** App alias (defaults to config default) */
  appKey?: string;
  /** Non-interactive: hash (version id) of the release to use. */
  hash?: string;
}

function formatReleaseLine(index: number, v: VersionDoc): string {
  const date = v.createdAt ? new Date(v.createdAt).toLocaleString() : 'Unknown date';
  const msg = v.message?.trim() ? v.message : '(no message)';
  return `${index + 1}. ${date} — ${msg} [hash: ${v.id}]`;
}

export async function releaseCreateCommand(
  options: ReleaseCreateOptions = {},
): Promise<void> {
  const root = process.cwd();
  const { config, appKey, appId } = await resolveAppContext(options.appKey);
  const appConfig = config.apps[appKey];
  if (!appConfig) {
    ui.error(`No app configured for key "${appKey}".`);
    process.exitCode = 1;
    return;
  }

  const session = await getValidAuthSession();
  if (!session.ok) {
    ui.error(session.message);
    process.exitCode = 1;
    return;
  }
  const { idToken, userId } = session;

  const firestoreOptions: FirestoreClientOptions | undefined = undefined;

  let message = options.message ?? '';
  const isInteractive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  // In non-interactive contexts (e.g. tests, CI), skip prompt entirely.
  if (message === '' && !options.yes && isInteractive) {
    const result = await prompts({
      type: 'text',
      name: 'message',
      message: 'Release message (optional):',
      initial: '',
    });
    const promptMessage = result.message;
    // If user cancels (Esc/Ctrl+C), do not create a release.
    if (promptMessage === undefined) {
      ui.warn('Release creation cancelled.');
      process.exitCode = 130;
      return;
    }
    message = typeof promptMessage === 'string' ? promptMessage : '';
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Build snapshot from local files, like git commit/tag.
  const appName = (appConfig.name as string | undefined) ?? 'App';
  const appHome = appConfig.appHome as string | undefined;
  const localFiles = await collectAppFiles(root);
  const localApp = buildDocumentsFromParsed(
    localFiles,
    appId,
    appName,
    appHome,
    undefined,
  );
  const snapshot: CloudApp = {
    id: localApp.id,
    name: localApp.name,
    createdAt: localApp.createdAt,
    updatedAt: localApp.updatedAt,
    ...(localApp.screens && localApp.screens.length > 0 && { screens: localApp.screens }),
    ...(localApp.widgets && localApp.widgets.length > 0 && { widgets: localApp.widgets }),
    ...(localApp.scripts && localApp.scripts.length > 0 && { scripts: localApp.scripts }),
    ...(localApp.actions && localApp.actions.length > 0 && { actions: localApp.actions }),
    ...(localApp.translations &&
      localApp.translations.length > 0 && { translations: localApp.translations }),
    ...(localApp.theme && { theme: localApp.theme }),
  };

  try {
    await createVersion(
      appId,
      idToken,
      {
        message: message.trim(),
        createdAt: now.toISOString(),
        createdBy: { name: session.name ?? 'User', id: userId },
        expiresAt,
        snapshot,
      },
      firestoreOptions,
    );
    ui.success('Release saved. Run "ensemble release use" to use it.');
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

export async function releaseListCommand(
  options: ReleaseListOptions = {},
): Promise<void> {
  const { config, appKey, appId } = await resolveAppContext(options.appKey);
  const appConfig = config.apps[appKey];
  if (!appConfig) {
    ui.error(`No app configured for key "${appKey}".`);
    process.exitCode = 1;
    return;
  }

  const session = await getValidAuthSession();
  if (!session.ok) {
    ui.error(session.message);
    process.exitCode = 1;
    return;
  }
  const { idToken, userId } = session;

  const firestoreOptions: FirestoreClientOptions | undefined = undefined;
  const limit = options.limit ?? 20;

  try {
    const accessAndFirst = await withSpinner('Loading releases...', () =>
      Promise.all([
        checkAppAccess(appId, idToken, userId, firestoreOptions),
        listVersions(appId, idToken, { limit }, firestoreOptions),
      ]),
    );
    const access = accessAndFirst[0];
    let { versions, nextStartAfter } = accessAndFirst[1];

    if (!access.ok) {
      ui.error(access.message);
      process.exitCode = 1;
      return;
    }

    if (versions.length === 0) {
      ui.warn('No releases found. Create one with "ensemble release create".');
      return;
    }

    while (nextStartAfter !== undefined && versions.length < limit) {
      const next = await listVersions(
        appId,
        idToken,
        { limit: limit - versions.length, startAfter: nextStartAfter },
        firestoreOptions,
      );
      versions = [...versions, ...next.versions];
      nextStartAfter = next.nextStartAfter;
    }

    ui.heading(`Releases for app "${appConfig.name ?? appKey}":`);
    versions.forEach((v, idx) => {
      ui.note(formatReleaseLine(idx, v));
    });
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

export async function releaseUseCommand(
  options: ReleaseUseOptions = {},
): Promise<void> {
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

  let versionDoc: VersionDoc;
  try {
    // Non-interactive: hash provided, fetch that specific version directly.
    if (options.hash) {
      const access = await checkAppAccess(appId, idToken, userId, firestoreOptions);
      if (!access.ok) {
        ui.error(access.message);
        process.exitCode = 1;
        return;
      }
      versionDoc = await withSpinner('Loading release...', () =>
        getVersion(appId, idToken, options.hash!, firestoreOptions),
      );
    } else {
      // Interactive picker over recent releases.
      const isInteractive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
      if (!isInteractive) {
        ui.error(
          'Release use requires either interactive mode or --hash <hash> for non-interactive use.',
        );
        process.exitCode = 1;
        return;
      }

      const PAGE_SIZE = 5;
      const SHOW_MORE_VALUE = '__show_more__';

      const { access, versions: initialVersions, nextStartAfter: initialNext } =
        await withSpinner('Loading releases...', () =>
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
        ui.warn('No releases found. Create one with "ensemble release create".');
        return;
      }

      let allVersions = initialVersions;
      let nextStartAfter: string | undefined = initialNext;
      for (;;) {
        const choices: { title: string; value: number | string }[] = allVersions.map(
          (v, i) => ({
            title: formatReleaseLine(i, v),
            value: i,
          }),
        );
        if (nextStartAfter !== undefined) {
          choices.push({ title: 'Show more (next 5)', value: SHOW_MORE_VALUE });
        }

        const { selected } = await prompts({
          type: 'select',
          name: 'selected',
          message: 'Choose a release to use (local files only):',
          choices,
          initial: 0,
        });

        if (selected === undefined) {
          ui.warn('Release use cancelled.');
          process.exitCode = 130;
          return;
        }
        if (selected === SHOW_MORE_VALUE) {
          const nextPage = await withSpinner('Loading releases...', () =>
            listVersions(
              appId,
              idToken,
              { limit: PAGE_SIZE, startAfter: nextStartAfter },
              firestoreOptions,
            ),
          );
          allVersions = [...allVersions, ...nextPage.versions];
          nextStartAfter = nextPage.nextStartAfter;
          continue;
        }
        versionDoc = allVersions[selected as number];
        break;
      }
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
    ui.success('Local files updated to selected release. Run "ensemble push" to apply to the cloud.');
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

