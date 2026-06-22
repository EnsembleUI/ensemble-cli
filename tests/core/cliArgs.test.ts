import { describe, expect, it } from 'vitest';

import { getTopLevelCommand, isUpdateCommand } from '../../src/core/cliArgs.js';

describe('cliArgs', () => {
  describe('getTopLevelCommand', () => {
    it.each([
      [['node', 'ensemble', 'update'], 'update'],
      [['node', 'ensemble', '--debug', 'update'], 'update'],
      [['node', 'ensemble', 'push'], 'push'],
      [['node', 'ensemble', '--debug', 'push', '--app', 'uat'], 'push'],
      [['node', 'ensemble'], undefined],
    ])('parses %j', (argv, expected) => {
      expect(getTopLevelCommand(argv)).toBe(expected);
    });
  });

  describe('isUpdateCommand', () => {
    it.each([
      [['node', 'ensemble', 'update'], true],
      [['node', 'ensemble', '--debug', 'update'], true],
      [['node', 'ensemble', 'push'], false],
      [['node', 'ensemble', 'release', 'create'], false],
    ])('detects update command in %j', (argv, expected) => {
      expect(isUpdateCommand(argv)).toBe(expected);
    });
  });
});
