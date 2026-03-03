import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  loadProjectConfig,
  resolveAppContext,
  writeProjectConfigIfMissing,
  upsertAppAlias,
} from '../../src/config/projectConfig.js';

const CONFIG_FILENAME = 'ensemble.config.json';

describe('projectConfig', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-projectConfig-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('loadProjectConfig', () => {
    it('loads valid config', async () => {
      const config = {
        default: 'dev',
        apps: {
          dev: { appId: 'app-123', name: 'My App' },
        },
      };
      await fs.writeFile(path.join(tmpDir, CONFIG_FILENAME), JSON.stringify(config));

      const result = await loadProjectConfig();

      const realRoot = await fs.realpath(result.projectRoot);
      const realTmp = await fs.realpath(tmpDir);
      expect(realRoot).toBe(realTmp);
      expect(result.config.default).toBe('dev');
      expect(result.config.apps.dev.appId).toBe('app-123');
    });

    it('throws when config not found', async () => {
      await expect(loadProjectConfig()).rejects.toThrow(/Could not find/);
    });

    it('throws when default or apps missing', async () => {
      await fs.writeFile(path.join(tmpDir, CONFIG_FILENAME), JSON.stringify({}));

      await expect(loadProjectConfig()).rejects.toThrow(/invalid/);
    });

    it('throws when default app has no appId', async () => {
      await fs.writeFile(
        path.join(tmpDir, CONFIG_FILENAME),
        JSON.stringify({ default: 'dev', apps: { dev: {} } }),
      );

      await expect(loadProjectConfig()).rejects.toThrow(/appId/);
    });
  });

  describe('resolveAppContext', () => {
    it('returns context for default app', async () => {
      const config = {
        default: 'dev',
        apps: { dev: { appId: 'app-456' } },
      };
      await fs.writeFile(path.join(tmpDir, CONFIG_FILENAME), JSON.stringify(config));

      const ctx = await resolveAppContext();

      const realRoot = await fs.realpath(ctx.projectRoot);
      const realTmp = await fs.realpath(tmpDir);
      expect(realRoot).toBe(realTmp);
      expect(ctx.appKey).toBe('dev');
      expect(ctx.appId).toBe('app-456');
    });

    it('returns context for requested app', async () => {
      const config = {
        default: 'dev',
        apps: {
          dev: { appId: 'app-1' },
          prod: { appId: 'app-2' },
        },
      };
      await fs.writeFile(path.join(tmpDir, CONFIG_FILENAME), JSON.stringify(config));

      const ctx = await resolveAppContext('prod');

      expect(ctx.appKey).toBe('prod');
      expect(ctx.appId).toBe('app-2');
    });

    it('throws when app key not found', async () => {
      const config = {
        default: 'dev',
        apps: { dev: { appId: 'app-1' } },
      };
      await fs.writeFile(path.join(tmpDir, CONFIG_FILENAME), JSON.stringify(config));

      await expect(resolveAppContext('staging')).rejects.toThrow(/No app id configured/);
    });
  });

  describe('writeProjectConfigIfMissing', () => {
    it('creates config when missing', async () => {
      const config = {
        default: 'dev',
        apps: { dev: { appId: 'app-1' } },
      };

      await writeProjectConfigIfMissing(config);

      const raw = await fs.readFile(path.join(tmpDir, CONFIG_FILENAME), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.default).toBe('dev');
      expect(parsed.apps.dev.appId).toBe('app-1');
    });

    it('does not overwrite existing config', async () => {
      const existing = { default: 'x', apps: { x: { appId: 'original' } } };
      await fs.writeFile(path.join(tmpDir, CONFIG_FILENAME), JSON.stringify(existing));

      await writeProjectConfigIfMissing({
        default: 'dev',
        apps: { dev: { appId: 'new' } },
      });

      const raw = await fs.readFile(path.join(tmpDir, CONFIG_FILENAME), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.apps.x.appId).toBe('original');
    });
  });

  describe('upsertAppAlias', () => {
    it('updates existing config with new alias', async () => {
      const config = {
        default: 'dev',
        apps: { dev: { appId: 'app-1' } },
      };
      await fs.writeFile(path.join(tmpDir, CONFIG_FILENAME), JSON.stringify(config));

      await upsertAppAlias('prod', 'app-2', { name: 'Prod App' });

      const raw = await fs.readFile(path.join(tmpDir, CONFIG_FILENAME), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.apps.dev.appId).toBe('app-1');
      expect(parsed.apps.prod.appId).toBe('app-2');
      expect(parsed.apps.prod.name).toBe('Prod App');
    });

    it('updates existing alias', async () => {
      const config = {
        default: 'dev',
        apps: { dev: { appId: 'app-old' } },
      };
      await fs.writeFile(path.join(tmpDir, CONFIG_FILENAME), JSON.stringify(config));

      await upsertAppAlias('dev', 'app-new');

      const raw = await fs.readFile(path.join(tmpDir, CONFIG_FILENAME), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.apps.dev.appId).toBe('app-new');
    });

    it('saves appHome when provided', async () => {
      const config = {
        default: 'dev',
        apps: { dev: { appId: 'app-1' } },
      };
      await fs.writeFile(path.join(tmpDir, CONFIG_FILENAME), JSON.stringify(config));

      await upsertAppAlias('prod', 'app-2', { appHome: 'Home' });

      const raw = await fs.readFile(path.join(tmpDir, CONFIG_FILENAME), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.apps.prod.appHome).toBe('Home');
    });
  });
});
