import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  getGlobalConfigPath,
  readGlobalConfig,
  writeGlobalConfig,
  clearUserAuth,
} from '../../src/config/globalConfig.js';

describe('globalConfig', () => {
  let tmpDir: string;
  let originalHomedir: typeof os.homedir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-globalConfig-'));
    originalHomedir = os.homedir;
    (os.homedir as () => string) = () => tmpDir;
  });

  afterEach(async () => {
    (os.homedir as () => string) = originalHomedir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getGlobalConfigPath', () => {
    it('returns path under .ensemble', () => {
      const configPath = getGlobalConfigPath();
      expect(configPath).toContain('.ensemble');
      expect(configPath).toContain('cli-config.json');
      expect(configPath).toContain(tmpDir);
    });
  });

  describe('readGlobalConfig', () => {
    it('returns null when file does not exist', async () => {
      const result = await readGlobalConfig();
      expect(result).toBeNull();
    });

    it('returns parsed config when file exists', async () => {
      const configDir = path.join(tmpDir, '.ensemble');
      await fs.mkdir(configDir, { recursive: true });
      const config = {
        user: {
          uid: 'u1',
          email: 'test@example.com',
          idToken: 'token',
        },
      };
      await fs.writeFile(path.join(configDir, 'cli-config.json'), JSON.stringify(config));

      const result = await readGlobalConfig();

      expect(result).not.toBeNull();
      expect(result!.user?.uid).toBe('u1');
      expect(result!.user?.email).toBe('test@example.com');
    });
  });

  describe('writeGlobalConfig', () => {
    it('creates directory and writes config', async () => {
      const config = {
        user: {
          uid: 'u1',
          idToken: 't',
        },
      };

      await writeGlobalConfig(config);

      const raw = await fs.readFile(getGlobalConfigPath(), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.user.uid).toBe('u1');
    });
  });

  describe('clearUserAuth', () => {
    it('removes user from config', async () => {
      const configDir = path.join(tmpDir, '.ensemble');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'cli-config.json'),
        JSON.stringify({
          user: { uid: 'u1', idToken: 't' },
        })
      );

      await clearUserAuth();

      const result = await readGlobalConfig();
      expect(result?.user).toBeUndefined();
    });

    it('preserves other config when clearing user', async () => {
      const configDir = path.join(tmpDir, '.ensemble');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'cli-config.json'),
        JSON.stringify({
          user: { uid: 'u1', idToken: 't' },
          other: 'value',
        })
      );

      await clearUserAuth();

      const result = await readGlobalConfig();
      expect(result?.user).toBeUndefined();
      expect(result?.other).toBe('value');
    });
  });
});
