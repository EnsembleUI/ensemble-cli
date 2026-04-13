import { describe, it, expect } from 'vitest';
import { buildManifestObject, type RootManifest } from '../../src/core/manifest.js';
import type { CloudApp } from '../../src/cloud/firestoreClient.js';
import { EnsembleDocumentType } from '../../src/core/dto.js';

describe('buildManifestObject manifest lists', () => {
  it('preserves existing scripts order and only adds new ones', () => {
    const existing: RootManifest = {
      widgets: [],
      scripts: [{ name: 'S1' }, { name: 'S2' }],
    };
    const cloud: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [],
      widgets: [],
      scripts: [
        { id: 's2', name: 'S2', content: '', type: EnsembleDocumentType.Script },
        { id: 's1', name: 'S1', content: '', type: EnsembleDocumentType.Script },
        { id: 's3', name: 'S3', content: '', type: EnsembleDocumentType.Script },
      ],
      translations: [],
    };

    const merged = buildManifestObject(existing, cloud);

    expect(merged.scripts?.map((s) => s.name)).toEqual(['S1', 'S2', 'S3']);
  });
});
