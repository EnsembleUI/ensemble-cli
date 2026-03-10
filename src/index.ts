#!/usr/bin/env node
import { Command } from 'commander';
import { exec } from 'node:child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string };
const LOCAL_VERSION = pkg.version;

import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { initCommand } from './commands/init.js';
import { pushCommand } from './commands/push.js';
import { addCommand } from './commands/add.js';
import { pullCommand } from './commands/pull.js';
import { updateCommand } from './commands/update.js';
import { printCliError, resolveDebugFlag } from './core/cliError.js';

const program = new Command();

program
  .name('ensemble')
  .description('Ensemble CLI for logging in and configuring Ensemble apps.')
  .version(LOCAL_VERSION)
  .option('--debug', 'Print full debug information and stack traces', false);

program
  .command('login')
  .description('Log in to Ensemble.')
  .option('--verbose', 'Print additional login details', false)
  .action(async (options: { verbose?: boolean }) => {
    await loginCommand({ verbose: options.verbose });
  });

program
  .command('logout')
  .description('Log out of Ensemble.')
  .action(async () => {
    await logoutCommand();
  });

program
  .command('init')
  .description('Initialize or update Ensemble config in the current project.')
  .action(async () => {
    await initCommand();
  });

program
  .command('push')
  .description('Scan the current app directory and prepare data for upload.')
  .option('--app <alias>', 'App alias to use (defaults to "default")')
  .option('--verbose', 'Print the full collected data as JSON', false)
  .option('--dry-run', 'Show what would be pushed without sending to cloud', false)
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options: { verbose?: boolean; app?: string; yes?: boolean; dryRun?: boolean }) => {
    await pushCommand({
      verbose: options.verbose,
      appKey: options.app,
      yes: options.yes,
      dryRun: options.dryRun,
    });
  });

program
  .command('pull')
  .description('Pull app artifacts from the cloud and overwrite local files.')
  .option('--app <alias>', 'App alias to use (defaults to "default")')
  .option('--verbose', 'Write fetched cloud JSON to disk', false)
  .option('--dry-run', 'Show what would be pulled without modifying files', false)
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options: { verbose?: boolean; app?: string; yes?: boolean; dryRun?: boolean }) => {
    await pullCommand({
      verbose: options.verbose,
      appKey: options.app,
      yes: options.yes,
      dryRun: options.dryRun,
    });
  });

program
  .command('add')
  .description('Add a new screen, widget, script, or translation.')
  .argument('[kind]', 'Artifact type: screen | widget | script | translation')
  .argument('[name]', 'Name of the artifact, e.g. "Hello"')
  .action(async (kind?: string, name?: string) => {
    let normalizedKind: 'screen' | 'widget' | 'script' | 'translation' | undefined;
    if (kind) {
      const k = kind.toLowerCase();
      if (k === 'screen' || k === 'widget' || k === 'script' || k === 'translation') {
        normalizedKind = k;
      } else {
        throw new Error(
          `Unknown artifact type "${kind}". Expected one of: screen, widget, script, translation.`,
        );
      }
    }
    await addCommand(normalizedKind, name);
  });

program
  .command('update')
  .description('Update the Ensemble CLI to the latest version.')
  .action(async () => {
    await updateCommand();
  });

function checkForUpdates(): void {
  // Use the user's existing npm + auth config to query GitHub Packages.
  exec(
    'npm view @ensembleui/cli version --registry=https://npm.pkg.github.com',
    (error, stdout) => {
      if (error) {
        return;
      }
      const latest = stdout.trim();
      if (!latest || latest === LOCAL_VERSION) return;

      // eslint-disable-next-line no-console
      console.warn(
        `A new version of @ensembleui/cli is available (${LOCAL_VERSION} → ${latest}).\n` +
          `Run "ensemble update" to upgrade.`,
      );
    },
  );
}

checkForUpdates();

program.parseAsync(process.argv).catch((err) => {
  const globalOptions = program.opts<{ debug?: boolean }>();
  const debugEnabled = resolveDebugFlag(globalOptions.debug);
  printCliError(err, { debug: debugEnabled });
  process.exitCode = 1;
});
