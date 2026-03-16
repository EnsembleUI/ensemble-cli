import { describe, it, expect, afterEach } from 'vitest';

import {
  downloadReleaseSnapshotJson,
  uploadReleaseSnapshot,
} from '../../src/cloud/storageClient.js';

describe('storageClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uploadReleaseSnapshot posts to releases path with Firebase auth header', async () => {
    let captured: { url: string; method?: string; headers?: HeadersInit; body?: string } | null =
      null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      captured = {
        url: urlStr,
        method: init?.method,
        headers: init?.headers,
        body: init?.body as string | undefined,
      };
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await uploadReleaseSnapshot('app1', 'id-token', 'ver-123', '{"foo":"bar"}');

    // Bucket is derived from env/project; we assert the path and headers, not the exact bucket.
    expect(result.objectPath).toBe('releases/app1/ver-123.json');
    expect(captured).not.toBeNull();
    expect(captured!.url).toContain('https://firebasestorage.googleapis.com/v0/b/');
    expect(captured!.url).toContain('name=' + encodeURIComponent('releases/app1/ver-123.json'));
    expect(captured!.method).toBe('POST');
    const headers = new Headers(captured!.headers);
    expect(headers.get('Authorization')).toBe('Firebase id-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(captured!.body).toBe('{"foo":"bar"}');
  });

  it('uploadReleaseSnapshot throws StorageClientError on non-2xx', async () => {
    globalThis.fetch = (async () => {
      return new Response('forbidden', { status: 403 });
    }) as unknown as typeof fetch;

    await expect(
      uploadReleaseSnapshot('app1', 'id-token', 'ver-123', '{"foo":"bar"}')
    ).rejects.toThrow('Storage upload release snapshot failed (403)');
  });

  it('downloadReleaseSnapshotJson GETs from releases path with Firebase auth header', async () => {
    let captured: { url: string; headers?: HeadersInit } | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      captured = { url: urlStr, headers: init?.headers };
      return new Response('{"id":"app1"}', { status: 200 });
    }) as unknown as typeof fetch;

    const json = await downloadReleaseSnapshotJson('id-token', 'releases/app1/ver-123.json');

    expect(json).toBe('{"id":"app1"}');
    expect(captured).not.toBeNull();
    expect(captured!.url).toContain('https://firebasestorage.googleapis.com/v0/b/');
    expect(captured!.url).toContain(
      encodeURIComponent('releases/app1/ver-123.json') + '?alt=media'
    );
    const headers = new Headers(captured!.headers);
    expect(headers.get('Authorization')).toBe('Firebase id-token');
  });

  it('downloadReleaseSnapshotJson throws StorageClientError on non-2xx', async () => {
    globalThis.fetch = (async () => {
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      downloadReleaseSnapshotJson('id-token', 'releases/app1/ver-123.json')
    ).rejects.toThrow('Storage download release snapshot failed (404)');
  });
});
