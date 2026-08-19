import { afterEach, describe, expect, it } from 'vitest';

import { createAppManifest, CdnClientError } from '../../src/cloud/cdnClient.js';

describe('cdnClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts expected payload and accepts direct success response', async () => {
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
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await createAppManifest('app-1', 'id-token');

    expect(captured).not.toBeNull();
    expect(captured!.url).toContain('createAppManifest');
    expect(captured!.method).toBe('POST');
    const headers = new Headers(captured!.headers);
    expect(headers.get('Authorization')).toBe('Bearer id-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(captured!.body).toBe(JSON.stringify({ data: { appId: 'app-1' } }));
  });

  it('parses callable-style result wrapper', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ result: { success: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(createAppManifest('app-1', 'id-token')).resolves.toBeUndefined();
  });

  it('accepts empty 200 response body', async () => {
    globalThis.fetch = (async () => {
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(createAppManifest('app-1', 'id-token')).resolves.toBeUndefined();
  });

  it('throws when success is false', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ success: false }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(createAppManifest('app-1', 'id-token')).rejects.toThrow(CdnClientError);
  });

  it('throws on non-2xx with auth hint for 403', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }) as unknown as typeof fetch;

    await expect(createAppManifest('app-1', 'id-token')).rejects.toMatchObject({
      message: 'CDN sync failed (403).',
      status: 403,
      hint: expect.stringContaining('ensemble login'),
    });
  });
});
