import { describe, it, expect } from 'vitest';
import {
  buildManifestObject,
  manifestFromSnapshot,
  orderByManifestNames,
  type RootManifest,
} from '../../src/core/manifest.js';
import type { CloudApp } from '../../src/cloud/firestoreClient.js';
import { EnsembleDocumentType } from '../../src/core/dto.js';

describe('manifest', () => {
  it('orderByManifestNames sorts items to match manifest list order', () => {
    const items = [
      { name: 'Wid2', content: '' },
      { name: 'Wid1', content: '' },
    ];

    const ordered = orderByManifestNames(items, ['Wid1', 'Wid2']);

    expect(ordered.map((item) => item.name)).toEqual(['Wid1', 'Wid2']);
  });

  it('manifestFromSnapshot uses snapshot list order and defaultLocale', () => {
    const cloud: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [],
      widgets: [
        { id: 'w2', name: 'Wid2', content: '', type: EnsembleDocumentType.Widget },
        { id: 'w1', name: 'Wid1', content: '', type: EnsembleDocumentType.Widget },
      ],
      scripts: [],
      translations: [
        {
          id: 't-en',
          name: 'en',
          content: '',
          type: EnsembleDocumentType.I18n,
        },
        {
          id: 't-de',
          name: 'de',
          content: '',
          type: EnsembleDocumentType.I18n,
        },
        {
          id: 't-ar',
          name: 'ar',
          content: '',
          type: EnsembleDocumentType.I18n,
          defaultLocale: true,
        },
      ],
    };

    const manifest = manifestFromSnapshot(cloud);

    expect(manifest.widgets?.map((w) => w.name)).toEqual(['Wid2', 'Wid1']);
    expect(manifest.languages).toEqual(['en', 'de', 'ar']);
    expect(manifest.defaultLanguage).toBe('ar');
  });

  it('buildManifestObject preserves existing list order on pull', () => {
    const existing: RootManifest = {
      widgets: [],
      scripts: [{ name: 'S1' }, { name: 'S2' }],
      languages: ['ar', 'en', 'bn'],
      defaultLanguage: 'ar',
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
      translations: [
        {
          id: 't-en',
          name: 'en',
          content: '',
          type: EnsembleDocumentType.I18n,
          defaultLocale: true,
        },
        {
          id: 't-ar',
          name: 'ar',
          content: '',
          type: EnsembleDocumentType.I18n,
        },
      ],
    };

    const merged = buildManifestObject(existing, cloud);

    expect(merged.scripts?.map((s) => s.name)).toEqual(['S1', 'S2', 'S3']);
    expect(merged.languages).toEqual(['ar', 'en']);
    expect(merged.defaultLanguage).toBe('en');
  });
});
