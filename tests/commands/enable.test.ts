import { describe, expect, it } from 'vitest';

import { parseEnableTokens } from '../../src/commands/enable.js';

describe('parseEnableTokens', () => {
  it('splits script names from key=value parameters', () => {
    const { scriptNames, argsArray } = parseEnableTokens([
      'google_maps',
      'webGoogleMapsApiKey=abc',
      'ensemble_version=1.2.40',
    ]);

    expect(scriptNames).toEqual(['google_maps']);
    expect(argsArray).toEqual(['webGoogleMapsApiKey=abc', 'ensemble_version=1.2.40']);
  });

  it('treats every non key=value token as a script name', () => {
    const { scriptNames, argsArray } = parseEnableTokens([
      'camera',
      'location',
      'cameraDescription=Hello',
      'not-a-module',
    ]);

    expect(scriptNames).toEqual(['camera', 'location', 'not-a-module']);
    expect(argsArray).toEqual(['cameraDescription=Hello']);
  });
});
