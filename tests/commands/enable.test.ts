import { describe, expect, it } from 'vitest';

import { parseEnableTokens } from '../../src/commands/enable.js';

describe('parseEnableTokens', () => {
  it('splits module names from key=value parameters', () => {
    const { moduleNames, inlineArgs } = parseEnableTokens([
      'google_maps',
      'googleMapsApiKey=abc',
      'ensemble_version=1.2.40',
    ]);

    expect(moduleNames).toEqual(['google_maps']);
    expect(inlineArgs).toEqual({
      googleMapsApiKey: 'abc',
      ensemble_version: '1.2.40',
    });
  });

  it('supports multiple modules and ignores non-module tokens', () => {
    const { moduleNames, inlineArgs } = parseEnableTokens([
      'camera',
      'location',
      'cameraDescription=Hello',
      '__googleMapsApiKey',
      'not-a-module',
    ]);

    expect(moduleNames).toEqual(['camera', 'location']);
    expect(inlineArgs).toEqual({ cameraDescription: 'Hello' });
  });
});
