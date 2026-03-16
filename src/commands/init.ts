import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import { checkAppAccess, fetchRootScreenName } from '../cloud/firestoreClient.js';
import { getValidAuthSession } from '../auth/session.js';
import { upsertAppAlias } from '../config/projectConfig.js';
import { ui } from '../core/ui.js';

export async function initCommand(): Promise<void> {
  const session = await getValidAuthSession();
  if (!session.ok) {
    ui.error(session.message);
    process.exitCode = 1;
    return;
  }
  const { idToken, userId } = session;

  const answers = await prompts([
    {
      type: 'text',
      name: 'alias',
      message: 'Local project alias (e.g. dev, staging, prod). This is what you pass to --app.',
      initial: 'dev',
    },
    {
      type: 'text',
      name: 'appId',
      message: 'Existing Ensemble app id to link',
    },
  ]);

  if (!answers.alias || !answers.appId) {
    console.log('Alias or app id missing; init aborted.');
    process.exitCode = 1;
    return;
  }

  const alias = answers.alias as string;
  const appId = answers.appId as string;

  const access = await checkAppAccess(appId, idToken, userId);
  if (!access.ok) {
    ui.error(access.message);
    process.exitCode = 1;
    return;
  }

  let appHome: string | undefined;
  try {
    appHome = await fetchRootScreenName(appId, idToken);
  } catch {
    // Ignore; appHome will stay undefined
  }

  await upsertAppAlias(alias, appId, {
    name: access.app.name,
    description: access.app.description,
    ...(appHome !== undefined && { appHome }),
  });

  if (appHome) {
    const manifestPath = path.join(process.cwd(), '.manifest.json');
    let manifest: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      manifest = {};
    }

    if (typeof manifest.homeScreenName !== 'string') {
      manifest.homeScreenName = appHome;
      await fs.writeFile(
        manifestPath,
        JSON.stringify(manifest, null, 2) + '\n',
        'utf8',
      );
      ui.note(`Updated .manifest.json: homeScreenName set to "${appHome}".`);
    }
  }
  ui.success(
    `Initialized Ensemble config and linked alias "${alias}" to app "${appId}".`,
  );
  ui.note(
    `You can now run \`ensemble push --app ${alias}\` or \`ensemble pull --app ${alias}\`.`,
  );
}
