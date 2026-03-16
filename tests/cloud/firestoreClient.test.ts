import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkAppAccess,
  fetchCloudApp,
  fetchRootScreenName,
  submitCliPush,
  listVersions,
  createVersion,
  getVersion,
  FirestoreClientError,
  type FirestoreDebugEvent,
} from '../../src/cloud/firestoreClient.js';

describe('checkAppAccess', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns ok when user has write access', async () => {
    const firestoreDoc = {
      fields: {
        name: { stringValue: 'My App' },
        description: { stringValue: 'Test app' },
        collaborators: {
          mapValue: {
            fields: {
              users_user123: { stringValue: 'write' },
            },
          },
        },
      },
    };

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes('/documents/apps/')) {
        return new Response(JSON.stringify(firestoreDoc), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await checkAppAccess('app-1', 'token', 'user123');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.app.name).toBe('My App');
      expect(result.app.description).toBe('Test app');
    }
  });

  it('returns ok when user has owner access', async () => {
    const firestoreDoc = {
      fields: {
        name: { stringValue: 'App' },
        collaborators: {
          mapValue: {
            fields: {
              users_owner1: { stringValue: 'owner' },
            },
          },
        },
      },
    };

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes('/documents/apps/')) {
        return new Response(JSON.stringify(firestoreDoc), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await checkAppAccess('app-1', 'token', 'owner1');

    expect(result.ok).toBe(true);
  });

  it('returns no_access when user has read role', async () => {
    const firestoreDoc = {
      fields: {
        name: { stringValue: 'App' },
        collaborators: {
          mapValue: {
            fields: {
              users_reader1: { stringValue: 'read' },
            },
          },
        },
      },
    };

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes('/documents/apps/')) {
        return new Response(JSON.stringify(firestoreDoc), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await checkAppAccess('app-1', 'token', 'reader1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_access');
    }
  });

  it('returns not_found for 404', async () => {
    globalThis.fetch = async () => new Response('', { status: 404 });

    const result = await checkAppAccess('nonexistent', 'token', 'user1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.message).toContain('does not exist');
    }
  });

  it('returns not_logged_in for 401', async () => {
    globalThis.fetch = async () => new Response('', { status: 401 });

    const result = await checkAppAccess('app-1', 'invalid-token', 'user1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_logged_in');
    }
  });

  it('returns network_error on fetch failure', async () => {
    globalThis.fetch = async () => {
      throw new Error('Network error');
    };

    const result = await checkAppAccess('app-1', 'token', 'user1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('network_error');
    }
  });
});

describe('fetchCloudApp', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches and transforms app with screens and widgets', async () => {
    const appDoc = {
      name: 'projects/p/databases/(default)/documents/apps/app-1',
      createTime: '2025-01-01T00:00:00Z',
      updateTime: '2025-01-02T00:00:00Z',
      fields: {
        name: { stringValue: 'My App' },
      },
    };

    const internalArtifacts = [
      {
        name: 'projects/p/databases/(default)/documents/apps/app-1/internal_artifacts/w1',
        fields: {
          type: { stringValue: 'internal_widget' },
          name: { stringValue: 'Button' },
          content: { stringValue: 'widget content' },
        },
      },
      {
        name: 'projects/p/databases/(default)/documents/apps/app-1/internal_artifacts/s1',
        fields: {
          type: { stringValue: 'internal_script' },
          name: { stringValue: 'utils' },
          content: { stringValue: 'script content' },
        },
      },
    ];

    const artifacts = [
      {
        name: 'projects/p/databases/(default)/documents/apps/app-1/artifacts/screen1',
        fields: {
          type: { stringValue: 'screen' },
          name: { stringValue: 'Home' },
          content: { stringValue: 'screen content' },
        },
      },
    ];

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (
        urlStr.includes('/documents/apps/app-1') &&
        !urlStr.includes('/internal_artifacts') &&
        !urlStr.includes('/artifacts')
      ) {
        return new Response(JSON.stringify(appDoc), { status: 200 });
      }
      if (urlStr.includes('internal_artifacts')) {
        return new Response(JSON.stringify({ documents: internalArtifacts }), { status: 200 });
      }
      if (urlStr.includes('/artifacts')) {
        return new Response(JSON.stringify({ documents: artifacts }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await fetchCloudApp('app-1', 'token');

    expect(result.id).toBe('app-1');
    expect(result.name).toBe('My App');
    expect(result.widgets).toHaveLength(1);
    expect(result.widgets![0].name).toBe('Button');
    expect(result.widgets![0].content).toBe('widget content');
    expect(result.scripts).toHaveLength(1);
    expect(result.scripts![0].name).toBe('utils');
    expect(result.screens).toHaveLength(1);
    expect(result.screens![0].name).toBe('Home');
    expect(result.screens![0].content).toBe('screen content');
  });

  it('prefers theme doc with id "theme" when multiple themes exist', async () => {
    const appDoc = {
      name: 'projects/p/databases/(default)/documents/apps/app-1',
    };

    const artifacts = [
      {
        name: 'projects/p/databases/(default)/documents/apps/app-1/artifacts/randomThemeId',
        fields: {
          type: { stringValue: 'theme' },
          name: { stringValue: 'theme' },
          content: { stringValue: 'random theme' },
        },
      },
      {
        name: 'projects/p/databases/(default)/documents/apps/app-1/artifacts/theme',
        fields: {
          type: { stringValue: 'theme' },
          name: { stringValue: 'theme' },
          content: { stringValue: 'canonical theme' },
        },
      },
    ];

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes('/documents/apps/app-1') && !urlStr.includes('/artifacts')) {
        return new Response(JSON.stringify(appDoc), { status: 200 });
      }
      if (urlStr.includes('/artifacts')) {
        return new Response(JSON.stringify({ documents: artifacts }), { status: 200 });
      }
      if (urlStr.includes('internal_artifacts')) {
        return new Response(JSON.stringify({ documents: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await fetchCloudApp('app-1', 'token');
    expect(result.theme).toBeDefined();
    expect(result.theme?.id).toBe('theme');
    expect(result.theme?.content).toBe('canonical theme');
  });

  it('handles single random-id theme gracefully', async () => {
    const appDoc = {
      name: 'projects/p/databases/(default)/documents/apps/app-1',
    };
    const artifacts = [
      {
        name: 'projects/p/databases/(default)/documents/apps/app-1/artifacts/randomThemeId',
        fields: {
          type: { stringValue: 'theme' },
          name: { stringValue: 'theme' },
          content: { stringValue: 'random theme' },
        },
      },
    ];

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes('/documents/apps/app-1') && !urlStr.includes('/artifacts')) {
        return new Response(JSON.stringify(appDoc), { status: 200 });
      }
      if (urlStr.includes('/artifacts')) {
        return new Response(JSON.stringify({ documents: artifacts }), { status: 200 });
      }
      if (urlStr.includes('internal_artifacts')) {
        return new Response(JSON.stringify({ documents: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await fetchCloudApp('app-1', 'token');
    expect(result.theme).toBeDefined();
    expect(result.theme?.content).toBe('random theme');
  });
});

describe('fetchRootScreenName', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('submitCliPush', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = originalFetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('creates translation with correct id, defaultLocale and user references', async () => {
      type CapturedBody = {
        fields: {
          defaultLocale?: { booleanValue: boolean };
          updatedBy?: { referenceValue: string };
          createdBy?: { referenceValue: string };
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };

      const calls: { url: string; body: CapturedBody }[] = [];

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (init?.method === 'POST' && urlStr.includes('/artifacts')) {
          const parsedBody = init.body
            ? (JSON.parse(String(init.body)) as CapturedBody)
            : ({} as CapturedBody);
          calls.push({
            url: urlStr,
            body: parsedBody,
          });
          return new Response(JSON.stringify({}), { status: 200 });
        }
        // For other calls (screens/widgets/scripts/theme) that won't be used in this test.
        return new Response(JSON.stringify({}), { status: 200 });
      }) as unknown as typeof fetch;

      const payload = {
        id: 'app1',
        name: 'App',
        updatedAt: new Date().toISOString(),
        translations: [
          {
            operation: 'create' as const,
            document: {
              id: 'i18n_en',
              name: 'en',
              content: 'en: content',
              type: 'i18n',
              defaultLocale: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              updatedBy: { name: 'User', email: 'u@test.com', id: 'uid1' },
              createdBy: { name: 'User', email: 'u@test.com', id: 'uid1' },
            },
          },
        ],
      };

      await submitCliPush('app1', 'token', payload);

      expect(calls.length).toBe(1);
      const { url, body } = calls[0]!;
      expect(url).toContain('/apps/app1/artifacts');
      expect(url).toContain('documentId=i18n_en');
      expect(body).toHaveProperty('fields');
      expect(body.fields.defaultLocale).toEqual({ booleanValue: true });
      expect(body.fields.updatedBy).toBeDefined();
      expect(body.fields.createdBy).toBeDefined();

      const updatedByRef = body.fields.updatedBy!.referenceValue as string;
      const createdByRef = body.fields.createdBy!.referenceValue as string;
      expect(updatedByRef).toContain('/users/uid1');
      expect(createdByRef).toContain('/users/uid1');
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns name of screen with isRoot true', async () => {
    const runQueryResponse = [
      {
        document: {
          name: 'projects/p/databases/(default)/documents/apps/app-1/artifacts/s1',
          fields: {
            type: { stringValue: 'screen' },
            name: { stringValue: 'Home' },
            isRoot: { booleanValue: true },
          },
        },
      },
    ];

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes(':runQuery')) {
        return new Response(JSON.stringify(runQueryResponse), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await fetchRootScreenName('app-1', 'token');
    expect(result).toBe('Home');
  });

  it('returns undefined when no root screen', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes(':runQuery')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await fetchRootScreenName('app-1', 'token');
    expect(result).toBeUndefined();
  });

  it('returns undefined on fetch failure', async () => {
    globalThis.fetch = async () => new Response('', { status: 500 });

    const result = await fetchRootScreenName('app-1', 'token');
    expect(result).toBeUndefined();
  });
});

describe('Firestore client structured errors and debug logging', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('submitCliPush throws FirestoreClientError with mapped code on HTTP error', async () => {
    globalThis.fetch = async () =>
      new Response('unauthorized', {
        status: 401,
        statusText: 'Unauthorized',
      });

    const payload = {
      id: 'app1',
      name: 'App',
      updatedAt: new Date().toISOString(),
      translations: [
        {
          operation: 'create' as const,
          document: {
            id: 'i18n_en',
            name: 'en',
            content: 'en: content',
            type: 'i18n',
            defaultLocale: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            updatedBy: { name: 'User', email: 'u@test.com', id: 'uid1' },
            createdBy: { name: 'User', email: 'u@test.com', id: 'uid1' },
          },
        },
      ],
    };

    await expect(submitCliPush('app1', 'token', payload)).rejects.toBeInstanceOf(
      FirestoreClientError
    );
  });

  it('submitCliPush invokes debug logger when provided', async () => {
    const events: FirestoreDebugEvent[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === 'POST' && urlStr.includes('/artifacts')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const payload = {
      id: 'app1',
      name: 'App',
      updatedAt: new Date().toISOString(),
      translations: [
        {
          operation: 'create' as const,
          document: {
            id: 'i18n_en',
            name: 'en',
            content: 'en: content',
            type: 'i18n',
            defaultLocale: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            updatedBy: { name: 'User', email: 'u@test.com', id: 'uid1' },
            createdBy: { name: 'User', email: 'u@test.com', id: 'uid1' },
          },
        },
      ],
    };

    await submitCliPush('app1', 'token', payload, {
      debug: (event) => {
        events.push(event);
      },
    });

    expect(events.length).toBeGreaterThan(0);
  });
});

describe('listVersions', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends runQuery with parent in URL and only structuredQuery in body', async () => {
    let capturedRequest: { url: string; body: string } | null = null;
    const runQueryResponse = [
      {
        document: {
          name: 'projects/p/databases/(default)/documents/apps/app1/versions/v1',
          fields: {
            message: { stringValue: 'First version' },
            createdAt: { timestampValue: '2025-01-15T12:00:00Z' },
            expiresAt: { timestampValue: '2025-02-15T12:00:00Z' },
            createdBy: { referenceValue: 'projects/p/databases/(default)/documents/users/uid1' },
            snapshot: { stringValue: '{"id":"app1","name":"App","screens":[]}' },
          },
        },
      },
    ];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (urlStr.includes(':runQuery')) {
        capturedRequest = { url: urlStr, body: (init?.body as string) ?? '' };
        return new Response(JSON.stringify(runQueryResponse), { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    const result = await listVersions('app1', 'token', { limit: 5 });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.url).toContain('/documents/apps/app1:runQuery');
    const body = JSON.parse(capturedRequest!.body);
    expect(body).toHaveProperty('structuredQuery');
    expect(body.structuredQuery.from).toEqual([{ collectionId: 'versions' }]);
    expect(body.structuredQuery.orderBy).toEqual([
      { field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' },
    ]);
    expect(body.structuredQuery.limit).toBe(5);
    expect(body).not.toHaveProperty('parent');

    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]!.message).toBe('First version');
    expect(result.versions[0]!.createdAt).toBe('2025-01-15T12:00:00Z');
    expect(result.versions[0]!.snapshot).toEqual({ id: 'app1', name: 'App', screens: [] });
    expect(result.nextStartAfter).toBeUndefined();
  });

  it('returns nextStartAfter when limit results returned', async () => {
    const ts = '2025-01-15T12:00:00Z';
    const runQueryResponse = Array.from({ length: 5 }, (_, i) => ({
      document: {
        name: `projects/p/databases/(default)/documents/apps/app1/versions/v${i}`,
        fields: {
          message: { stringValue: `Version ${i}` },
          createdAt: { timestampValue: ts },
          expiresAt: { timestampValue: '2025-02-15T12:00:00Z' },
          snapshot: { stringValue: '{}' },
        },
      },
    }));

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (urlStr.includes(':runQuery')) {
        return new Response(JSON.stringify(runQueryResponse), { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    const result = await listVersions('app1', 'token', { limit: 5 });
    expect(result.versions).toHaveLength(5);
    expect(result.nextStartAfter).toBe(ts);
  });

  it('includes startAt in body when startAfter is provided', async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response(JSON.stringify([]), { status: 200 });
    };

    await listVersions('app1', 'token', { limit: 5, startAfter: '2025-01-10T00:00:00Z' });

    const body = JSON.parse(capturedBody!);
    expect(body.structuredQuery.startAt).toEqual({
      values: [{ timestampValue: '2025-01-10T00:00:00Z' }],
      before: false,
    });
  });

  it('returns no nextStartAfter when fewer than limit returned', async () => {
    const runQueryResponse = [
      {
        document: {
          name: 'projects/p/databases/(default)/documents/apps/app1/versions/v1',
          fields: {
            message: { stringValue: 'Only one' },
            createdAt: { timestampValue: '2025-01-15T12:00:00Z' },
            expiresAt: { timestampValue: '2025-02-15T12:00:00Z' },
            snapshot: { stringValue: '{}' },
          },
        },
      },
    ];

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (urlStr.includes(':runQuery')) {
        return new Response(JSON.stringify(runQueryResponse), { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    const result = await listVersions('app1', 'token', { limit: 5 });
    expect(result.versions).toHaveLength(1);
    expect(result.nextStartAfter).toBeUndefined();
  });

  it('throws FirestoreClientError on 403', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (urlStr.includes(':runQuery')) {
        return new Response(
          JSON.stringify({ error: { code: 403, message: 'Permission denied' } }),
          { status: 403 }
        );
      }
      return new Response('', { status: 404 });
    };

    await expect(listVersions('app1', 'token', { limit: 5 })).rejects.toThrow(FirestoreClientError);
  });
});

describe('createVersion', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to app versions collection and returns id', async () => {
    let capturedUrl: string | null = null;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (urlStr.includes('/versions') && init?.method === 'POST') {
        capturedUrl = urlStr;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    const result = await createVersion('app1', 'token', {
      message: 'Release 1',
      createdAt: '2025-01-15T12:00:00Z',
      expiresAt: '2025-02-15T12:00:00Z',
      createdBy: { name: 'User', id: 'uid1' },
      snapshot: { id: 'app1', name: 'App', screens: [] },
    });

    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(capturedUrl).toContain('/documents/apps/app1/versions');
    expect(capturedUrl).toContain('documentId=');
  });

  it('throws FirestoreClientError on 403', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (urlStr.includes('/versions')) {
        return new Response(JSON.stringify({ error: { code: 403 } }), { status: 403 });
      }
      return new Response('', { status: 404 });
    };

    await expect(
      createVersion('app1', 'token', {
        message: 'v1',
        createdAt: '2025-01-15T12:00:00Z',
        expiresAt: '2025-02-15T12:00:00Z',
        createdBy: { name: 'User', id: 'uid1' },
        snapshot: { id: 'app1', name: 'App' },
      })
    ).rejects.toThrow(FirestoreClientError);
  });
});

describe('getVersion', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns version doc with snapshot', async () => {
    const versionDoc = {
      name: 'projects/p/databases/(default)/documents/apps/app1/versions/ver-123',
      fields: {
        message: { stringValue: 'Saved state' },
        createdAt: { timestampValue: '2025-01-15T12:00:00Z' },
        expiresAt: { timestampValue: '2025-02-15T12:00:00Z' },
        createdBy: { referenceValue: 'projects/p/databases/(default)/documents/users/uid1' },
        snapshot: { stringValue: '{"id":"app1","name":"My App","screens":[]}' },
      },
    };

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (urlStr.includes('/versions/ver-123')) {
        return new Response(JSON.stringify(versionDoc), { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    const result = await getVersion('app1', 'token', 'ver-123');
    expect(result.id).toBe('ver-123');
    expect(result.message).toBe('Saved state');
    expect(result.createdAt).toBe('2025-01-15T12:00:00Z');
    expect(result.snapshot).toEqual({ id: 'app1', name: 'My App', screens: [] });
  });

  it('throws FirestoreClientError with NOT_FOUND on 404', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 404 });

    let thrown: FirestoreClientError | undefined;
    try {
      await getVersion('app1', 'token', 'missing-id');
    } catch (err) {
      thrown = err as FirestoreClientError;
    }
    expect(thrown).toBeInstanceOf(FirestoreClientError);
    expect(thrown!.code).toBe('NOT_FOUND');
    expect(thrown!.message).toContain('missing-id');
  });

  it('throws FirestoreClientError when snapshot JSON is invalid', async () => {
    const versionDoc = {
      name: 'projects/p/databases/(default)/documents/apps/app1/versions/ver-123',
      fields: {
        message: { stringValue: 'v1' },
        createdAt: { timestampValue: '2025-01-15T12:00:00Z' },
        expiresAt: { timestampValue: '2025-02-15T12:00:00Z' },
        snapshot: { stringValue: 'not valid json {{' },
      },
    };

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (urlStr.includes('/versions/ver-123')) {
        return new Response(JSON.stringify(versionDoc), { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    let thrown: FirestoreClientError | undefined;
    try {
      await getVersion('app1', 'token', 'ver-123');
    } catch (err) {
      thrown = err as FirestoreClientError;
    }
    expect(thrown).toBeInstanceOf(FirestoreClientError);
    expect(thrown!.message).toContain('snapshot data is invalid');
  });
});
