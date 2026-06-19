import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { resolveReleaseAppKey } from '../../src/commands/release.js';

function buildReleaseCli(onAppKey: (appKey: string | undefined) => void): Command {
  const program = new Command();
  const releaseCmd = program.command('release').option('--app <alias>', 'App alias');
  releaseCmd.command('create').action((_options, command) => {
    onAppKey(resolveReleaseAppKey(command));
  });
  releaseCmd.command('list').action((_options, command) => {
    onAppKey(resolveReleaseAppKey(command));
  });
  return program;
}

describe('release --app CLI parsing', () => {
  it.each([
    ['release create --app uat', 'uat'],
    ['release --app uat create', 'uat'],
    ['release list --app uat', 'uat'],
    ['release --app uat list', 'uat'],
    ['release create', undefined],
  ])('parses %s', (argv, expectedAppKey) => {
    let resolved: string | undefined;
    const program = buildReleaseCli((appKey) => {
      resolved = appKey;
    });
    program.parse(argv.split(' '), { from: 'user' });
    expect(resolved).toBe(expectedAppKey);
  });
});
