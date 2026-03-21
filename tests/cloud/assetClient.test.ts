import { afterEach, describe, expect, it } from 'vitest';

import { uploadAssetToStudio } from '../../src/cloud/assetClient.js';

describe('assetClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts expected payload and parses direct response', async () => {
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
      return new Response(
        JSON.stringify({
          success: true,
          assetBaseUrl: 'https://cdn.example.com/assets/',
          envVariable: { key: 'image_2_png', value: 'image-2.png?token=abc' },
          usageKey: '${env.assets}${env.image_2_png}',
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await uploadAssetToStudio('app-1', 'image-2.png', 'AQIDBA==', 'id-token');
    expect(result.success).toBe(true);
    expect(result.assetBaseUrl).toBe('https://cdn.example.com/assets/');
    expect(result.envVariable.key).toBe('image_2_png');
    expect(result.usageKey).toBe('${env.assets}${env.image_2_png}');

    expect(captured).not.toBeNull();
    expect(captured!.url).toContain('studio-uploadAsset');
    expect(captured!.method).toBe('POST');
    const headers = new Headers(captured!.headers);
    expect(headers.get('Authorization')).toBe('Bearer id-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(captured!.body).toBe(
      JSON.stringify({
        data: {
          appId: 'app-1',
          fileName: 'image-2.png',
          fileData: 'AQIDBA==',
        },
      })
    );
  });

  it('parses callable-style result wrapper', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          result: {
            success: true,
            assetBaseUrl: 'https://cdn.example.com/assets/',
            envVariable: { key: 'image_2_png', value: 'image-2.png?token=abc' },
            usageKey: '${env.assets}${env.image_2_png}',
          },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await uploadAssetToStudio('app-1', 'image-2.png', 'AQIDBA==', 'id-token');
    expect(result.envVariable.key).toBe('image_2_png');
  });
});
