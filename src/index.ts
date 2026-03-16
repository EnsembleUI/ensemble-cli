#!/usr/bin/env node
import { Command } from 'commander';
import { exec } from 'node:child_process';
import prompts from 'prompts';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string };
const LOCAL_VERSION = pkg.version;

import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { tokenCommand } from './commands/token.js';
import { initCommand } from './commands/init.js';
import { pushCommand } from './commands/push.js';
import { addCommand } from './commands/add.js';
import { pullCommand } from './commands/pull.js';
import { releaseCreateCommand, releaseListCommand, releaseUseCommand } from './commands/release.js';
import { updateCommand } from './commands/update.js';
import { printCliError, resolveDebugFlag } from './core/cliError.js';
import { ui } from './core/ui.js';

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
  .command('token')
  .description('Print refresh token for CI (use as ENSEMBLE_TOKEN). Run "ensemble login" first.')
  .option('--quiet', 'Print only the token (no extra text)', false)
  .option('--json', 'Print the token as JSON (for scripts)', false)
  .action(async (options: { quiet?: boolean; json?: boolean }) => {
    await tokenCommand({ quiet: options.quiet, json: options.json });
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

const releaseCmd = program
  .command('release')
  .description('Manage releases (snapshots) of your app.')
  .option('--app <alias>', 'App alias to use (defaults to "default")');

releaseCmd
  .command('create')
  .description('Create a release (snapshot) from the current cloud state (no push required).')
  .option('--app <alias>', 'App alias to use (defaults to "default")')
  .option('-m, --message <msg>', 'Release message (skips prompt)')
  .option('-y, --yes', 'Skip message prompt (use empty message)')
  .action(async (options: { app?: string; message?: string; yes?: boolean }) => {
    await releaseCreateCommand({
      appKey: options.app,
      message: options.message,
      yes: options.yes,
    });
  });

releaseCmd
  .command('list')
  .description('List releases for an app.')
  .option('--app <alias>', 'App alias to use (defaults to "default")')
  .option('--limit <n>', 'Maximum number of releases to show (default: 20)', (v) => Number(v), 20)
  .option('--json', 'Print releases as JSON (for scripts)', false)
  .action(async (options: { app?: string; limit?: number; json?: boolean }) => {
    await releaseListCommand({
      appKey: options.app,
      limit: options.limit,
      json: options.json,
    });
  });

releaseCmd
  .command('use')
  .description(
    'Use a release (snapshot) to update local files (run "ensemble push" to sync cloud).'
  )
  .option('--app <alias>', 'App alias to use (defaults to "default")')
  .option('--hash <hash>', 'Release hash to use (non-interactive).')
  .action(async (options: { app?: string; hash?: string }) => {
    await releaseUseCommand({ appKey: options.app, hash: options.hash });
  });

// If user runs just `ensemble release`, offer an interactive menu.
releaseCmd.action(async (options: { app?: string }) => {
  const isInteractive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (!isInteractive) {
    ui.error(
      'Subcommand required for non-interactive use. Try "ensemble release create|list|use".'
    );
    process.exitCode = 1;
    return;
  }

  const { action } = await prompts({
    type: 'select',
    name: 'action',
    message: 'What do you want to do?',
    choices: [
      { title: 'Create release (snapshot) from local state', value: 'create' },
      { title: 'List releases', value: 'list' },
      { title: 'Use release (update local files)', value: 'use' },
    ],
    initial: 0,
  });

  if (!action) {
    ui.warn('Release command cancelled.');
    process.exitCode = 130;
    return;
  }

  if (action === 'create') {
    await releaseCreateCommand({ appKey: options.app });
  } else if (action === 'list') {
    await releaseListCommand({ appKey: options.app });
  } else if (action === 'use') {
    await releaseUseCommand({ appKey: options.app });
  }
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
          `Unknown artifact type "${kind}". Expected one of: screen, widget, script, translation.`
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
  // Skip update checks in CI or when explicitly disabled.
  const ci = process.env.CI;
  const noCheck = process.env.ENSEMBLE_NO_UPDATE_CHECK;
  if (ci || (noCheck && noCheck.trim() !== '' && noCheck.toLowerCase() !== '0')) {
    return;
  }

  // Use the user's existing npm + auth config to query GitHub Packages.
  // IMPORTANT: This command string must remain a static literal and MUST NOT
  // interpolate user-controlled input to avoid shell injection risks.
  exec(
    'npm view @ensembleui/cli version --registry=https://npm.pkg.github.com',
    (error, stdout) => {
      if (error) {
        return;
      }
      const latest = stdout.trim();
      if (!latest || latest === LOCAL_VERSION) return;

      ui.warn(`A new version of @ensembleui/cli is available (${LOCAL_VERSION} → ${latest}).`);
      ui.note('Run "ensemble update" to upgrade.');
    }
  );
}

checkForUpdates();

program.parseAsync(process.argv).catch((err) => {
  const globalOptions = program.opts<{ debug?: boolean }>();
  const debugEnabled = resolveDebugFlag(globalOptions.debug);
  printCliError(err, { debug: debugEnabled });
  process.exitCode = 1;
});
