import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  argsForScript,
  assertRequiredParamsPresent,
  argsForScript,
  formatModuleLabel,
  loadEnableRuntime,
  normalizeArgsForDart,
  parseEnableTokens,
  resolveScript,
} from '../../src/core/enableRuntime.js';

const FIXTURE_CACHE = path.join(__dirname, '../fixtures/starter-cache');

describe('enableRuntime', () => {
  it('parses tokens like cached dart_runner (equals = param, else script name)', () => {
    expect(parseEnableTokens(['camera', 'platform=ios', 'ensemble_version=1.2.40'])).toEqual({
      scriptNames: ['camera'],
      argsArray: ['platform=ios', 'ensemble_version=1.2.40'],
    });
  });

  it('formats labels for display', () => {
    expect(formatModuleLabel('google_maps')).toBe('Google Maps');
  });

  it('loads registry and runtime helpers from cached fixture', async () => {
    const runtime = await loadEnableRuntime(FIXTURE_CACHE);
    expect(runtime.modules.some((module) => module.name === 'camera')).toBe(true);
    expect(runtime.commonParameters.map((param) => param.key)).toEqual([
      'platform',
      'ensemble_version',
    ]);
    expect(resolveScript('camera', runtime).path).toBe('scripts/modules/enable_camera.dart');
    expect(resolveScript('generate_keystore', runtime).name).toBe('generateKeystore');
  });

  it('throws for unknown scripts', async () => {
    const runtime = await loadEnableRuntime(FIXTURE_CACHE);
    expect(() => resolveScript('not_a_real_module', runtime)).toThrow(/not found/i);
  });

  it('filters args using commonParameters from cache', async () => {
    const runtime = await loadEnableRuntime(FIXTURE_CACHE);
    const camera = resolveScript('camera', runtime);
    const filtered = argsForScript(
      camera,
      [
        'platform=ios',
        'ensemble_version=1.2.40',
        'cameraDescription=hello',
        'webFirebaseApiKey=ignored',
      ],
      runtime.commonParameters
    );
    expect(filtered).toEqual([
      'platform=ios',
      'ensemble_version=1.2.40',
      'cameraDescription=hello',
    ]);
  });

  it('requires missing params in non-interactive mode using cached definitions', async () => {
    const runtime = await loadEnableRuntime(FIXTURE_CACHE);
    const camera = resolveScript('camera', runtime);
    expect(() =>
      assertRequiredParamsPresent([camera], runtime.commonParameters, ['platform=ios'])
    ).toThrow(/Missing required parameter/i);
  });

  it('strips quotes from args before dart (platform="ios" breaks getPlatforms)', () => {
    expect(normalizeArgsForDart(['platform="ios"', 'cameraDescription=hello'])).toEqual([
      'platform=ios',
      'cameraDescription=hello',
    ]);
  });
});
