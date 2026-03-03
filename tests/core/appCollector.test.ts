import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { collectAppFiles } from '../../src/core/appCollector.js';

describe('collectAppFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-appCollector-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('collects screens, widgets, scripts', async () => {
    await fs.mkdir(path.join(tmpDir, 'screens'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'widgets'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'screens', 'Home.yaml'), 'screen content');
    await fs.writeFile(path.join(tmpDir, 'widgets', 'Button.yaml'), 'widget content');
    await fs.writeFile(path.join(tmpDir, 'scripts', 'utils.js'), 'script content');

    const result = await collectAppFiles(tmpDir);

    expect(result.screens['Home.yaml']).toBe('screen content');
    expect(result.widgets['Button.yaml']).toBe('widget content');
    expect(result.scripts['utils.js']).toBe('script content');
  });

  it('collects theme.yaml', async () => {
    await fs.writeFile(path.join(tmpDir, 'theme.yaml'), 'colors:\n  primary: blue');

    const result = await collectAppFiles(tmpDir);

    expect(result.theme).toBe('colors:\n  primary: blue');
  });

  it('collects theme.yml', async () => {
    await fs.writeFile(path.join(tmpDir, 'theme.yml'), 'theme: dark');

    const result = await collectAppFiles(tmpDir);

    expect(result.theme).toBe('theme: dark');
  });

  it('collects translations', async () => {
    await fs.mkdir(path.join(tmpDir, 'translations'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'translations', 'en.json'), '{"hello":"Hello"}');

    const result = await collectAppFiles(tmpDir);

    expect(result.translations['en.json']).toBe('{"hello":"Hello"}');
  });

  it('skips ensemble.config.json', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'ensemble.config.json'),
      JSON.stringify({ default: 'dev', apps: {} }),
    );
    await fs.mkdir(path.join(tmpDir, 'screens'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'screens', 'Home.yaml'), 'screen');

    const result = await collectAppFiles(tmpDir);

    expect(result.screens['Home.yaml']).toBe('screen');
  });

  it('skips .git, node_modules', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'screens'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'screens', 'Home.yaml'), 'screen');

    const result = await collectAppFiles(tmpDir);

    expect(result.screens['Home.yaml']).toBe('screen');
  });

  it('respects collectOptions to exclude screens', async () => {
    await fs.mkdir(path.join(tmpDir, 'screens'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'screens', 'Home.yaml'), 'screen');

    const result = await collectAppFiles(tmpDir, { screens: false });

    expect(result.screens).toEqual({});
  });

  it('respects collectOptions to exclude theme', async () => {
    await fs.writeFile(path.join(tmpDir, 'theme.yaml'), 'colors: blue');

    const result = await collectAppFiles(tmpDir, { theme: false });

    expect(result.theme).toBeUndefined();
  });
});
