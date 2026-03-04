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
import { resolveAppContext } from '../config/projectConfig.js';
import { getValidAuthSession } from '../auth/session.js';
import { withSpinner } from '../lib/spinner.js';

export interface PushOptions {
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
  console.log(`Wrote ${filePath}`);
}

export async function pushCommand(options: PushOptions = {}): Promise<void> {
  const root = process.cwd();
  const { config, appKey, appId } = await resolveAppContext(options.appKey);
  const appConfig = config.apps[appKey];
  const appName = (appConfig.name as string | undefined) ?? 'App';

  const session = await getValidAuthSession();
  if (!session.ok) {
    console.error(session.message);
    return;
  }
  const { idToken, userId } = session;

  const access = await withSpinner('Checking app access...', () =>
    checkAppAccess(appId, idToken, userId),
  );
  if (!access.ok) {
    console.error(access.message);
    return;
  }

  const data = await withSpinner('Collecting app files...', () =>
    collectAppFiles(root, appConfig.options ?? {}),
  );
  const localApp = buildDocumentsFromParsed(
    data,
    appId,
    appName,
    appConfig.appHome as string | undefined,
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
    } else {
      console.log('Changes to be pushed:');
      for (const line of formatDiffSummary(diff)) {
        console.log(line);
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
}
