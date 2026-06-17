import { describe, expect, it } from 'vitest';

import { formatArgsForScript, resolveScriptArguments } from '../../src/core/moduleParams.js';
import type { StarterScript } from '../../src/core/starterTypes.js';

const cameraScript: StarterScript = {
  name: 'camera',
  path: 'scripts/modules/enable_camera.dart',
  parameters: [
    {
      key: 'cameraDescription',
      question: 'Camera description',
      type: 'text',
      platform: ['ios'],
    },
  ],
};

describe('moduleParams', () => {
  it('maps googleMapsApiKey into per-platform keys', async () => {
    const args = await resolveScriptArguments({
      scripts: [
        {
          name: 'google_maps',
          path: 'scripts/modules/enable_google_maps.dart',
          parameters: [],
        },
      ],
      provided: {
        platform: 'web',
        ensemble_version: '1.2.40',
        googleMapsApiKey: 'abc123',
      },
      interactive: false,
    });

    expect(args).toEqual(
      expect.arrayContaining([
        'platform=web',
        'ensemble_version=1.2.40',
        'webGoogleMapsApiKey=abc123',
      ])
    );
    expect(args.some((arg) => arg.startsWith('googleMapsApiKey='))).toBe(false);
  });

  it('requires missing params in non-interactive mode', async () => {
    await expect(
      resolveScriptArguments({
        scripts: [cameraScript],
        provided: { platform: 'ios' },
        interactive: false,
      })
    ).rejects.toThrow(/Missing required parameter/i);
  });

  it('passes only args declared for the script', () => {
    const args = formatArgsForScript(cameraScript, [
      'platform=ios',
      'ensemble_version=1.2.40',
      'cameraDescription=hello',
      'webFirebaseApiKey=ignored',
    ]);

    expect(args).toEqual(['platform=ios', 'ensemble_version=1.2.40', 'cameraDescription=hello']);
  });
});
