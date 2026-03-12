import { describe, it, expect } from 'vitest';

import {
  ArtifactProps,
  ARTIFACT_CONFIGS,
  ARTIFACT_FS_CONFIG,
  getArtifactConfig,
} from '../../src/core/artifacts.js';

describe('artifact registry', () => {
  it('includes all expected artifact props', () => {
    expect(ArtifactProps).toEqual([
      'screens',
      'widgets',
      'scripts',
      'actions',
      'translations',
      'theme',
    ]);
  });

  it('exposes filesystem config for YAML artifacts and theme', () => {
    const propsFromFsConfig = ARTIFACT_FS_CONFIG.map((c) => c.prop);
    expect(propsFromFsConfig).toContain('screens');
    expect(propsFromFsConfig).toContain('widgets');
    expect(propsFromFsConfig).toContain('scripts');
    expect(propsFromFsConfig).toContain('actions');
    expect(propsFromFsConfig).toContain('translations');
    expect(propsFromFsConfig).toContain('theme');

    const screens = ARTIFACT_FS_CONFIG.find((c) => c.prop === 'screens');
    expect(screens?.ext).toBe('.yaml');
    expect(screens?.isTheme).toBeFalsy();

    const theme = ARTIFACT_FS_CONFIG.find((c) => c.prop === 'theme');
    expect(theme?.isTheme).toBe(true);
  });

  it('configures actions as internal artifacts with correct Firestore type', () => {
    const cfg = getArtifactConfig('actions');
    expect(cfg.firestoreCollection).toBe('internal_artifacts');
    expect(cfg.firestoreType).toBe('internal_action');
    expect(cfg.fsDir).toBe('actions');
    expect(cfg.fileExtension).toBe('.yaml');
  });

  it('has matching fsDir entries for all non-theme YAML artifacts', () => {
    const yamlNonTheme = ARTIFACT_CONFIGS.filter(
      (c) => !c.isTheme && c.fileExtension && c.fileExtension.endsWith('.yaml'),
    );
    for (const cfg of yamlNonTheme) {
      expect(cfg.fsDir, `fsDir must be set for ${cfg.prop}`).toBeDefined();
    }
  });
});
