import { describe, it, expect, vi, afterEach } from 'vitest';

import { createFirestoreDebugOptions } from '../../src/core/debugFiles.js';

describe('createFirestoreDebugOptions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs firestore debug events without api urls', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    const { debug } = createFirestoreDebugOptions();
    debug?.({
      kind: 'request',
      method: 'GET',
      url: 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/apps/app1/artifacts?pageToken=secret',
      context: 'listCollectionDocuments',
    });
    debug?.({
      kind: 'response',
      method: 'GET',
      url: 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/apps/app1/artifacts',
      status: 200,
      context: 'listCollectionDocuments',
    });
    debug?.({
      kind: 'list_documents',
      collection: 'artifacts',
      parentPath: 'apps/app1',
      count: 97,
    });

    const output = lines.join('\n');
    expect(output).toContain('listCollectionDocuments');
    expect(output).toContain('"count": 97');
    expect(output).not.toContain('firestore.googleapis.com');
    expect(output).not.toContain('pageToken');
  });
});
