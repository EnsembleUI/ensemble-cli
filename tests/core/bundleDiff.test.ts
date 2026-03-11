import { describe, it, expect } from 'vitest';
import {
  computeBundleDiff,
  buildPushPayload,
  normalizeContentForCompare,
} from '../../src/core/bundleDiff.js';
import type { ApplicationDTO, ScreenDTO } from '../../src/core/dto.js';
import { EnsembleDocumentType } from '../../src/core/dto.js';

function screen(id: string, name: string, content: string, isArchived?: boolean) {
  return {
    id,
    name,
    content,
    type: EnsembleDocumentType.Screen as const,
    isArchived,
  };
}

function widget(id: string, name: string, content: string) {
  return {
    id,
    name,
    content,
    type: EnsembleDocumentType.Widget as const,
  };
}

describe('computeBundleDiff', () => {
  it('detects changed screens', () => {
    const cloud: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'old content')],
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'new content')],
    };
    const diff = computeBundleDiff(bundle, cloud);
    expect(diff.screens.changed).toHaveLength(1);
    expect(diff.screens.changed[0].content).toBe('new content');
    expect(diff.screens.new).toHaveLength(0);
  });

  it('detects new screens', () => {
    const cloud: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [],
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'content')],
    };
    const diff = computeBundleDiff(bundle, cloud);
    expect(diff.screens.changed).toHaveLength(0);
    expect(diff.screens.new).toHaveLength(1);
    expect(diff.screens.new[0].name).toBe('Home');
  });

  it('detects theme change', () => {
    const cloud: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      theme: {
        id: 'theme',
        name: 'theme',
        content: 'old theme',
        type: EnsembleDocumentType.Theme,
      },
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      theme: {
        id: 'theme',
        name: 'theme',
        content: 'new theme',
        type: EnsembleDocumentType.Theme,
      },
    };
    const diff = computeBundleDiff(bundle, cloud);
    expect(diff.themeChanged).toBe(true);
  });

  it('reports no change when content matches', () => {
    const cloud: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'same')],
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'same')],
    };
    const diff = computeBundleDiff(bundle, cloud);
    expect(diff.screens.changed).toHaveLength(0);
    expect(diff.screens.new).toHaveLength(0);
  });

  it('reports no change when content differs only by trailing newline', () => {
    const cloud: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'content')],
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'content\n')],
    };
    const diff = computeBundleDiff(bundle, cloud);
    expect(diff.screens.changed).toHaveLength(0);
  });

  it('reports no change when content differs only by line endings (CRLF vs LF)', () => {
    const cloud: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'line1\nline2\n')],
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'line1\r\nline2\r\n')],
    };
    const diff = computeBundleDiff(bundle, cloud);
    expect(diff.screens.changed).toHaveLength(0);
  });

  it('reports no change when content differs only by multiple trailing newlines', () => {
    const cloud: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'foo\n\n')],
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'foo\n')],
    };
    const diff = computeBundleDiff(bundle, cloud);
    expect(diff.screens.changed).toHaveLength(0);
  });
});

describe('normalizeContentForCompare', () => {
  it('normalizes CRLF to LF', () => {
    expect(normalizeContentForCompare('a\r\nb')).toBe('a\nb');
  });

  it('strips trailing newlines', () => {
    expect(normalizeContentForCompare('foo\n')).toBe('foo');
    expect(normalizeContentForCompare('foo\n\n')).toBe('foo');
  });

  it('treats semantically equal content as equal', () => {
    const a = 'View:\n  body: Text\n';
    const b = 'View:\n  body: Text';
    expect(normalizeContentForCompare(a)).toBe(normalizeContentForCompare(b));
  });
});

describe('buildPushPayload', () => {
  const updatedBy = { name: 'Test', email: 'test@test.com', id: 'uid1' };

  it('includes only changed and new artifacts with history + partial updates', () => {
    const cloudApp: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'old')],
      widgets: [widget('w1', 'Button', 'unchanged')],
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-02',
      screens: [
        screen('s1', 'Home', 'updated'),
        screen('s2', 'About', 'new'),
      ],
      widgets: [widget('w1', 'Button', 'unchanged')],
    };
    const diff = computeBundleDiff(bundle, cloudApp);
    const payload = buildPushPayload(bundle, diff, cloudApp, updatedBy);
    expect(payload.screens).toHaveLength(2);
    const updateItem = payload.screens!.find((s) => s.operation === 'update');
    const createItem = payload.screens!.find((s) => s.operation === 'create');
    expect(updateItem).toBeDefined();
    expect(updateItem?.operation).toBe('update');
    if (updateItem && updateItem.operation === 'update') {
      expect(updateItem.history.content).toBe('old');
      expect(updateItem.updates.content).toBe('updated');
    }
    expect(createItem).toBeDefined();
    expect(createItem?.operation).toBe('create');
    if (createItem && createItem.operation === 'create') {
      expect(createItem.document.content).toBe('new');
    }
    expect(payload.widgets).toBeUndefined();
  });

  it('includes theme when themeChanged with history for update', () => {
    const cloudApp: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      theme: {
        id: 'theme',
        name: 'theme',
        content: 'old',
        type: EnsembleDocumentType.Theme,
      },
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-02',
      theme: {
        id: 'theme',
        name: 'theme',
        content: 'new',
        type: EnsembleDocumentType.Theme,
      },
    };
    const diff = computeBundleDiff(bundle, cloudApp);
    const payload = buildPushPayload(bundle, diff, cloudApp, updatedBy);
    const theme = payload.theme;
    expect(theme).toBeDefined();
    if (theme && theme.operation === 'update') {
      expect(theme.history.content).toBe('old');
      expect(theme.updates.content).toBe('new');
    }
  });

  it('updates defaultLocale when translation default changes', () => {
    const cloudApp: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      translations: [
        {
          id: 'i18n_ar',
          name: 'ar',
          content: 'ar: content',
          type: EnsembleDocumentType.I18n,
          defaultLocale: false,
        },
        {
          id: 'i18n_en',
          name: 'en',
          content: 'en: content',
          type: EnsembleDocumentType.I18n,
          defaultLocale: false,
        },
      ],
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      translations: [
        {
          id: 'i18n_ar',
          name: 'ar',
          content: 'ar: content',
          type: EnsembleDocumentType.I18n,
          defaultLocale: true,
        },
        {
          id: 'i18n_en',
          name: 'en',
          content: 'en: content',
          type: EnsembleDocumentType.I18n,
          defaultLocale: false,
        },
      ],
    };

    const diff = computeBundleDiff(bundle, cloudApp);
    const payload = buildPushPayload(bundle, diff, cloudApp, updatedBy);
    expect(payload.translations).toBeDefined();
    const updateItem = payload.translations!.find((t) => t.operation === 'update');
    expect(updateItem).toBeDefined();
    if (updateItem && updateItem.operation === 'update') {
      expect(updateItem.id).toBe('i18n_ar');
      expect(updateItem.updates.defaultLocale).toBe(true);
    }
  });

  it('includes createdAt/createdBy/updatedBy for new artifacts', () => {
    const cloudApp: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [],
    };
    const bundle: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen('s1', 'Home', 'home')],
    };
    const diff = computeBundleDiff(bundle, cloudApp);
    const payload = buildPushPayload(bundle, diff, cloudApp, updatedBy);
    expect(payload.screens).toBeDefined();
    const createItem = payload.screens!.find((s) => s.operation === 'create');
    expect(createItem).toBeDefined();
    if (createItem && createItem.operation === 'create') {
      const doc = createItem.document as ScreenDTO & {
        createdBy?: { name: string; email?: string; id: string };
      };
      expect(doc.createdAt).toBeDefined();
      expect(doc.updatedAt).toBeDefined();
      expect(doc.updatedBy).toEqual(updatedBy);
      expect(doc.createdBy).toEqual(updatedBy);
    }
  });
});
