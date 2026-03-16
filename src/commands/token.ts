import { readGlobalConfig } from '../config/globalConfig.js';
import { ui } from '../core/ui.js';

export interface TokenCommandOptions {
  json?: boolean;
  quiet?: boolean;
}

/**
 * Print the current user's refresh token so it can be used as ENSEMBLE_TOKEN in CI.
 * User must have run `ensemble login` first (browser flow stores the refresh token).
 *
 * By default, prints the raw token followed by a short note. Use:
 * - --quiet to print only the token (no extra text) for scripting.
 * - --json to print {"token": "..."} as JSON for machine consumption.
 */
export async function tokenCommand(options: TokenCommandOptions = {}): Promise<void> {
  const config = (await readGlobalConfig()) ?? {};
  const refreshToken = config.user?.refreshToken;

  if (!refreshToken || typeof refreshToken !== 'string') {
    ui.error('No token found. Run `ensemble login` first (complete sign-in in the browser).');
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ token: refreshToken }));
    return;
  }

  // Default / --quiet behavior prints only the token when quiet=true.
  // eslint-disable-next-line no-console
  console.log(refreshToken);
  if (!options.quiet) {
    ui.note(
      'Add this value to your CI environment as ENSEMBLE_TOKEN (e.g. GitHub Actions secret).'
    );
  }
}
