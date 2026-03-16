import { readGlobalConfig } from '../config/globalConfig.js';
import { ui } from '../core/ui.js';

/**
 * Print the current user's refresh token so it can be used as ENSEMBLE_TOKEN in CI.
 * User must have run `ensemble login` first (browser flow stores the refresh token).
 */
export async function tokenCommand(): Promise<void> {
  const config = (await readGlobalConfig()) ?? {};
  const refreshToken = config.user?.refreshToken;

  if (!refreshToken || typeof refreshToken !== 'string') {
    ui.error('No token found. Run `ensemble login` first (complete sign-in in the browser).');
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.log(refreshToken);
  ui.note('Add this value to your CI environment as ENSEMBLE_TOKEN (e.g. GitHub Actions secret).');
}
