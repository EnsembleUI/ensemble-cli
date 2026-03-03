#!/usr/bin/env node
import { Command } from 'commander';

import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { initCommand } from './commands/init.js';
import { pushCommand } from './commands/push.js';

const program = new Command();

program
  .name('ensemble')
  .description('Ensemble CLI for logging in and configuring Ensemble apps.')
  .version('0.1.0');

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
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options: { verbose?: boolean; app?: string; yes?: boolean }) => {
    await pushCommand({ verbose: options.verbose, appKey: options.app, yes: options.yes });
  });

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
