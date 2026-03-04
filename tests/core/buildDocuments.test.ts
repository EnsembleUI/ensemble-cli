import { describe, it, expect } from 'vitest';
import {
  buildDocumentsFromParsed,
  buildMergedBundle,
} from '../../src/core/buildDocuments.js';
import { EnsembleDocumentType } from '../../src/core/dto.js';
import type { ApplicationDTO, ScreenDTO } from '../../src/core/dto.js';
import type { ParsedAppFiles } from '../../src/core/appCollector.js';
import type { CloudApp } from '../../src/cloud/firestoreClient.js';

describe('buildDocumentsFromParsed', () => {
  it('builds ApplicationDTO from parsed files', () => {
    const parsed: ParsedAppFiles = {
      screens: { 'Home.yaml': 'screen content' },
      scripts: { 'utils.js': 'script content' },
      widgets: { 'Button.yaml': 'widget content' },
      translations: {},
    };
    const app = buildDocumentsFromParsed(parsed, 'app-123', 'My App');
    expect(app.id).toBe('app-123');
    expect(app.name).toBe('My App');
    expect(app.screens).toHaveLength(1);
    expect(app.screens![0].id).toBe('screens/Home.yaml');
    expect(app.screens![0].name).toBe('Home');
    expect(app.screens![0].content).toBe('screen content');
    expect(app.screens![0].type).toBe(EnsembleDocumentType.Screen);
    expect(app.widgets).toHaveLength(1);
    expect(app.scripts).toHaveLength(1);
  });

  it('sets isRoot true for screen matching appHome', () => {
    const parsed: ParsedAppFiles = {
      screens: {
        'Home.yaml': 'screen content',
        'About.yaml': 'about content',
      },
      scripts: {},
      widgets: {},
      translations: {},
    };
    const app = buildDocumentsFromParsed(parsed, 'app1', 'App', 'Home');
    expect(app.screens).toHaveLength(2);
    const home = app.screens!.find((s) => s.name === 'Home');
    const about = app.screens!.find((s) => s.name === 'About');
    expect(home?.isRoot).toBe(true);
    expect(about?.isRoot).toBe(false);
  });

  it('leaves isRoot undefined when appHome not set', () => {
    const parsed: ParsedAppFiles = {
      screens: { 'Home.yaml': 'content' },
      scripts: {},
      widgets: {},
      translations: {},
    };
    const app = buildDocumentsFromParsed(parsed, 'app1', 'App');
    expect(app.screens![0].isRoot).toBeUndefined();
  });

  it('includes theme when present', () => {
    const parsed: ParsedAppFiles = {
      screens: {},
      scripts: {},
      widgets: {},
      translations: {},
      theme: 'colors:\n  primary: blue',
    };
    const app = buildDocumentsFromParsed(parsed, 'app1', 'App');
    expect(app.theme).toBeDefined();
    expect(app.theme?.content).toBe('colors:\n  primary: blue');
    expect(app.theme?.id).toBe('theme');
  });

  it('sets first translation as defaultLocale', () => {
    const parsed: ParsedAppFiles = {
      screens: {},
      scripts: {},
      widgets: {},
      translations: {
        'en.json': '{"hello":"Hello"}',
        'es.json': '{"hello":"Hola"}',
      },
    };
    const app = buildDocumentsFromParsed(parsed, 'app1', 'App');
    expect(app.translations).toHaveLength(2);
    expect(app.translations![0].defaultLocale).toBe(true);
    expect(app.translations![1].defaultLocale).toBe(false);
  });
});

describe('buildMergedBundle', () => {
  it('merges local content with cloud structure', () => {
    const screen: ScreenDTO = {
      id: 's1',
      name: 'Home',
      content: 'local content',
      type: EnsembleDocumentType.Screen,
    };
    const cloudScreen: ScreenDTO = {
      id: 'cloud-s1',
      name: 'Home',
      content: 'cloud content',
      type: EnsembleDocumentType.Screen,
    };
    const local: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [screen],
      widgets: [],
      scripts: [],
    };
    const cloud: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [cloudScreen],
      widgets: [],
      scripts: [],
    };
    const merged = buildMergedBundle(local, cloud, {
      name: 'CLI User',
      email: 'cli@test.com',
      id: 'user-1',
    });
    expect(merged.screens).toHaveLength(1);
    expect(merged.screens![0].content).toBe('local content');
    expect(merged.screens![0].id).toBe('cloud-s1');
  });

  it('adds new local items with preserved ids', () => {
    const homeScreen: ScreenDTO = {
      id: 's1',
      name: 'Home',
      content: 'home',
      type: EnsembleDocumentType.Screen,
    };
    const aboutScreen: ScreenDTO = {
      id: 's2',
      name: 'About',
      content: 'about',
      type: EnsembleDocumentType.Screen,
    };
    const cloudHome: ScreenDTO = {
      id: 'cloud-s1',
      name: 'Home',
      content: 'home',
      type: EnsembleDocumentType.Screen,
    };
    const local: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [homeScreen, aboutScreen],
      widgets: [],
      scripts: [],
    };
    const cloud: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [cloudHome],
      widgets: [],
      scripts: [],
    };
    const merged = buildMergedBundle(local, cloud, {
      name: 'CLI',
      id: 'u1',
    });
    expect(merged.screens).toHaveLength(2);
    const about = merged.screens!.find((s) => s.name === 'About');
    expect(about).toBeDefined();
    expect(about!.id).toBeDefined();
    expect(about!.id).toBe('s2');
  });

  it('archives cloud items deleted locally', () => {
    const cloudScreen: ScreenDTO = {
      id: 's1',
      name: 'Home',
      content: 'x',
      type: EnsembleDocumentType.Screen,
    };
    const local: ApplicationDTO = {
      id: 'app1',
      name: 'App',
      screens: [],
      widgets: [],
      scripts: [],
    };
    const cloud: CloudApp = {
      id: 'app1',
      name: 'App',
      screens: [cloudScreen],
      widgets: [],
      scripts: [],
    };
    const merged = buildMergedBundle(local, cloud, { name: 'CLI', id: 'u1' });
    expect(merged.screens).toHaveLength(1);
    expect(merged.screens![0].isArchived).toBe(true);
  });
});
