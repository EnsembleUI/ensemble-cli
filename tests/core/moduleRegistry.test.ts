import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  findStarterScript,
  formatModuleLabel,
  loadStarterRegistry,
  normalizeModuleName,
} from '../../src/core/moduleRegistry.js';

const FIXTURE_STARTER = path.join(__dirname, '../fixtures/starter-cache');

describe('moduleRegistry', () => {
  it('normalizes module aliases', () => {
    expect(normalizeModuleName('generate_keystore')).toBe('generateKeystore');
    expect(normalizeModuleName('google-maps')).toBe('google_maps');
  });

  it('formats labels for display', () => {
    expect(formatModuleLabel('google_maps')).toBe('Google Maps');
    expect(formatModuleLabel('firebase_analytics')).toBe('Firebase Analytics');
  });

  it('loads registry from cached starter fixture', async () => {
    const registry = await loadStarterRegistry(FIXTURE_STARTER);
    expect(registry.modules.some((module) => module.name === 'camera')).toBe(true);
    expect(findStarterScript('camera', registry).path).toBe('scripts/modules/enable_camera.dart');
    expect(findStarterScript('generate_keystore', registry).name).toBe('generateKeystore');
  });

  it('throws for unknown modules', async () => {
    const registry = await loadStarterRegistry(FIXTURE_STARTER);
    expect(() => findStarterScript('not_a_real_module', registry)).toThrow(/not found/i);
  });
});
