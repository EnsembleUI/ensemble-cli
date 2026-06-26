import { describe, it, expect } from 'vitest';
import {
  buildManifestObject,
  mergeManifestFromSnapshot,
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

  it('mergeManifestFromSnapshot syncs lists from snapshot but keeps other manifest keys', () => {
    const existing: RootManifest = {
      screens: [{ name: 'Home' }],
      studioVersion: 3,
      widgets: [{ name: 'Wid1', customId: 'keep-me' } as unknown as { name: string }],
      languages: ['ar', 'en'],
      defaultLanguage: 'ar',
    };
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

    const merged = mergeManifestFromSnapshot(existing, cloud);

    expect(merged.screens).toEqual([{ name: 'Home' }]);
    expect(merged.studioVersion).toBe(3);
    expect(merged.widgets).toEqual([{ name: 'Wid2' }, { name: 'Wid1', customId: 'keep-me' }]);
    expect(merged.languages).toEqual(['en', 'ar']);
    expect(merged.defaultLanguage).toBe('en');
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

  it('mergeManifestFromSnapshot keeps empty list keys that already exist', () => {
    const existing: RootManifest = {
      actions: [],
      defaultLanguage: 'nl',
      languages: ['nl', 'en'],
    };
    const cloud: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [],
      translations: [
        {
          id: 't-nl',
          name: 'nl',
          content: '',
          type: EnsembleDocumentType.I18n,
          defaultLocale: true,
        },
        {
          id: 't-en',
          name: 'en',
          content: '',
          type: EnsembleDocumentType.I18n,
        },
      ],
    };

    const merged = mergeManifestFromSnapshot(existing, cloud);

    expect(merged.actions).toEqual([]);
    expect(merged.defaultLanguage).toBe('nl');
  });
});
