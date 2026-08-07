import { describe, it, expect, afterEach } from 'vitest';

import {
  downloadReleaseSnapshotJson,
  objectPathForRelease,
  uploadReleaseSnapshot,
} from '../../src/cloud/storageClient.js';

describe('storageClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('objectPathForRelease uses encrypted .enc.json suffix', () => {
    expect(objectPathForRelease('app1', 'ver-123')).toBe('releases/app1/ver-123.enc.json');
  });

  it('uploadReleaseSnapshot posts envelope json to encrypted releases path', async () => {
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

    const envelope = '{"v":1,"alg":"AES-256-GCM","comp":"br","iv":"a","tag":"b","ciphertext":"c"}';
    const result = await uploadReleaseSnapshot('app1', 'id-token', 'ver-123', envelope);

    expect(result.objectPath).toBe('releases/app1/ver-123.enc.json');
    expect(captured!.method).toBe('POST');
    const headers = new Headers(captured!.headers);
    expect(headers.get('Authorization')).toBe('Firebase id-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(captured!.body).toBe(envelope);
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
      return new Response('{"v":1}', { status: 200 });
    }) as unknown as typeof fetch;

    const json = await downloadReleaseSnapshotJson('id-token', 'releases/app1/ver-123.enc.json');

    expect(json).toBe('{"v":1}');
    expect(captured!.url).toContain(
      encodeURIComponent('releases/app1/ver-123.enc.json') + '?alt=media'
    );
    const headers = new Headers(captured!.headers);
    expect(headers.get('Authorization')).toBe('Firebase id-token');
  });
});
