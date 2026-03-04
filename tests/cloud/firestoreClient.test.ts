import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkAppAccess,
  fetchCloudApp,
  fetchRootScreenName,
  submitCliPush,
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
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes('/documents/apps/app-1') && !urlStr.includes('/internal_artifacts') && !urlStr.includes('/artifacts')) {
        return new Response(JSON.stringify(appDoc), { status: 200 });
      }
      if (urlStr.includes('internal_artifacts')) {
        return new Response(
          JSON.stringify({ documents: internalArtifacts }),
          { status: 200 },
        );
      }
      if (urlStr.includes('/artifacts')) {
        return new Response(
          JSON.stringify({ documents: artifacts }),
          { status: 200 },
        );
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
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
            : input.url;
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
      },
    ) as unknown as typeof fetch;

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
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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

    await expect(
      submitCliPush('app1', 'token', payload),
    ).rejects.toBeInstanceOf(FirestoreClientError);
  });

  it('submitCliPush invokes debug logger when provided', async () => {
    const events: FirestoreDebugEvent[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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
