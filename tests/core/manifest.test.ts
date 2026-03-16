import { describe, it, expect } from 'vitest';
import {
  buildManifestObject,
  getCloudHomeScreenName,
  type RootManifest,
} from '../../src/core/manifest.js';
import type { CloudApp } from '../../src/cloud/firestoreClient.js';
import { EnsembleDocumentType } from '../../src/core/dto.js';

function cloudAppWithScreens(screens: { name: string; isRoot?: boolean }[]): CloudApp {
  return {
    id: 'app1',
    name: 'App',
    screens: screens.map((s) => ({
      id: `s-${s.name}`,
      name: s.name,
      content: '',
      type: EnsembleDocumentType.Screen as const,
      isRoot: s.isRoot,
    })),
    widgets: [],
    scripts: [],
    translations: [],
  };
}

describe('getCloudHomeScreenName', () => {
  it('returns screen with isRoot true', () => {
    const cloud = cloudAppWithScreens([
      { name: 'Home', isRoot: true },
      { name: 'About', isRoot: false },
    ]);
    expect(getCloudHomeScreenName(cloud)).toBe('Home');
  });

  it('returns first screen when no isRoot', () => {
    const cloud = cloudAppWithScreens([{ name: 'Dashboard' }, { name: 'Settings' }]);
    expect(getCloudHomeScreenName(cloud)).toBe('Dashboard');
  });

  it('returns undefined when no screens', () => {
    const cloud = cloudAppWithScreens([]);
    expect(getCloudHomeScreenName(cloud)).toBeUndefined();
  });
});

describe('buildManifestObject homeScreenName', () => {
  it('adds homeScreenName when manifest does not have it (from cloud)', () => {
    const existing: RootManifest = { widgets: [], scripts: [] };
    const cloud = cloudAppWithScreens([{ name: 'Home', isRoot: true }, { name: 'About' }]);
    const merged = buildManifestObject(existing, cloud);
    expect(merged.homeScreenName).toBe('Home');
  });

  it('adds homeScreenName when manifest does not have it (prefer appHomeFromConfig)', () => {
    const existing: RootManifest = { widgets: [], scripts: [] };
    const cloud = cloudAppWithScreens([{ name: 'Dashboard', isRoot: true }, { name: 'Home' }]);
    const merged = buildManifestObject(existing, cloud, {
      appHomeFromConfig: 'Home',
    });
    expect(merged.homeScreenName).toBe('Home');
  });

  it('preserves existing homeScreenName (does not overwrite from cloud)', () => {
    const existing: RootManifest = {
      widgets: [],
      scripts: [],
      homeScreenName: 'Dashboard',
    };
    const cloud = cloudAppWithScreens([{ name: 'Home', isRoot: true }, { name: 'Dashboard' }]);
    const merged = buildManifestObject(existing, cloud);
    expect(merged.homeScreenName).toBe('Dashboard');
  });

  it('uses homeScreenNameOverride when provided', () => {
    const existing: RootManifest = {
      widgets: [],
      scripts: [],
      homeScreenName: 'Dashboard',
    };
    const cloud = cloudAppWithScreens([{ name: 'Home', isRoot: true }, { name: 'Dashboard' }]);
    const merged = buildManifestObject(existing, cloud, {
      homeScreenNameOverride: 'Settings',
    });
    expect(merged.homeScreenName).toBe('Settings');
  });
});
