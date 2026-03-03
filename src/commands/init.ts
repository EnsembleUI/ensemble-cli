import prompts from 'prompts';

import { checkAppAccess, fetchRootScreenName } from '../cloud/firestoreClient.js';
import { getValidAuthSession } from '../auth/session.js';
import { upsertAppAlias } from '../config/projectConfig.js';

export async function initCommand(): Promise<void> {
  const session = await getValidAuthSession();
  if (!session.ok) {
    console.error(session.message);
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
    return;
  }

  const alias = answers.alias as string;
  const appId = answers.appId as string;

  const access = await checkAppAccess(appId, idToken, userId);
  if (!access.ok) {
    console.error(access.message);
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
  console.log(
    `Initialized Ensemble config and linked alias "${alias}" to app "${appId}". You can now run \`ensemble push --app ${alias}\` or \`ensemble pull --app ${alias}\``
  );
}
