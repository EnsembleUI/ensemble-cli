import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  applyCloudEnvToFs,
  applyReleaseConfigToFs,
  buildEnvPushDiff,
  computeEnvPullChanges,
  mergeConfigDtoForPush,
  prepareEnvPushState,
  warnIfMissingEnvFilesForPush,
  type CloudEnvState,
  type LocalEnvFiles,
} from '../../src/core/envSync.js';

describe('envSync', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-envSync-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('applyCloudEnvToFs syncs cloud env, preserves asset keys, and drops removed keys', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.env.config'),
      'assets=https://cdn.example.com/\nlogo_png=logo.png\nE1=EV1\nE2=EV2\n',
      'utf8'
    );

    await applyCloudEnvToFs(
      tmpDir,
      {
        config: { envVariables: { API_URL: 'https://api.example.com', E1: 'EV1' } },
        secrets: { secrets: { S1: 'secret-value' } },
      },
      ['logo.png']
    );

    const envConfig = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    const envSecrets = await fs.readFile(path.join(tmpDir, '.env.secrets'), 'utf8');
    expect(envConfig).toContain('assets=https://cdn.example.com/');
    expect(envConfig).toContain('logo_png=logo.png');
    expect(envConfig).toContain('API_URL=https://api.example.com');
    expect(envConfig).toContain('E1=EV1');
    expect(envConfig).not.toContain('E2=');
    expect(envSecrets).toContain('S1=secret-value');
  });

  it.each<{
    name: string;
    local: LocalEnvFiles;
    cloud: CloudEnvState;
    assets: string[];
    configChanged: boolean;
    secretsChanged: boolean;
    cloudConfig?: Record<string, string>;
    localConfig?: Record<string, string>;
  }>([
    {
      name: 'detects config and secrets changes',
      local: {
        envConfig: [{ key: 'E1', value: 'local' }],
        envSecrets: [{ key: 'S1', value: 'local' }],
        envConfigPresent: true,
        envSecretsPresent: true,
      },
      cloud: {
        config: { envVariables: { E1: 'cloud' } },
        secrets: { secrets: { S1: 'cloud' } },
      },
      assets: [],
      configChanged: true,
      secretsChanged: true,
    },
    {
      name: 'omits snapshots when in sync',
      local: {
        envConfig: [{ key: 'E1', value: 'EV1' }],
        envSecrets: [{ key: 'S1', value: 'SK1' }],
        envConfigPresent: true,
        envSecretsPresent: true,
      },
      cloud: {
        config: { envVariables: { E1: 'EV1' } },
        secrets: { secrets: { S1: 'SK1' } },
      },
      assets: [],
      configChanged: false,
      secretsChanged: false,
    },
    {
      name: 'skips push when env files are missing',
      local: {
        envConfig: [],
        envSecrets: [],
        envConfigPresent: false,
        envSecretsPresent: false,
      },
      cloud: {
        config: { envVariables: { E1: 'EV1' } },
        secrets: { secrets: { S1: 'SK1' } },
      },
      assets: [],
      configChanged: false,
      secretsChanged: false,
    },
    {
      name: 'strips asset keys from cloud diff',
      local: {
        envConfig: [{ key: 'E1', value: 'EV11' }],
        envSecrets: [],
        envConfigPresent: true,
        envSecretsPresent: true,
      },
      cloud: {
        config: {
          envVariables: {
            assets: 'https://cdn.example.com/',
            logo_png: 'logo.png',
            E1: 'EV1',
            E2: 'EV2',
          },
        },
      },
      assets: ['logo.png'],
      configChanged: true,
      secretsChanged: false,
      cloudConfig: { E1: 'EV1', E2: 'EV2' },
      localConfig: { E1: 'EV11' },
    },
  ])(
    '$name',
    ({ local, cloud, assets, configChanged, secretsChanged, cloudConfig, localConfig }) => {
      const diff = buildEnvPushDiff(local, cloud, assets);
      expect(diff.configChanged).toBe(configChanged);
      expect(diff.secretsChanged).toBe(secretsChanged);
      if (!configChanged && !secretsChanged) {
        expect(diff.local).toEqual({});
        expect(diff.cloud).toEqual({});
        return;
      }
      if (cloudConfig) expect(diff.cloud.config?.envVariables).toEqual(cloudConfig);
      if (localConfig) expect(diff.local.config?.envVariables).toEqual(localConfig);
    }
  );

  it('mergeConfigDtoForPush uses local asset keys only and drops removed non-asset keys', () => {
    expect(
      mergeConfigDtoForPush(
        { envVariables: { E1: 'EV11', E2: 'EV2' } },
        {
          envVariables: {
            assets: 'https://cdn.example.com/',
            logo_png: 'logo.png?token=abc',
            E1: 'EV1',
          },
        },
        ['logo.png'],
        {
          envVariables: {
            assets: 'https://cdn.example.com/',
            logo_png: 'logo.png?local=abc',
          },
        }
      ).envVariables
    ).toEqual({
      assets: 'https://cdn.example.com/',
      logo_png: 'logo.png?local=abc',
      E1: 'EV11',
      E2: 'EV2',
    });

    expect(
      mergeConfigDtoForPush(
        { envVariables: { E1: 'EV11' } },
        {
          envVariables: {
            assets: 'https://cdn.example.com/',
            logo_png: 'logo.png?token=abc',
            E1: 'EV1',
            E2: 'EV2',
          },
        },
        [],
        undefined
      ).envVariables
    ).toEqual({ E1: 'EV11' });
  });

  it('computeEnvPullChanges flags config mismatch including missing asset env keys', () => {
    const result = computeEnvPullChanges(
      {
        envConfig: [
          { key: 'assets', value: 'https://cdn.example.com/' },
          { key: 'E1', value: 'EV111' },
        ],
        envSecrets: [{ key: 'S1', value: 'SK1' }],
        envConfigPresent: true,
        envSecretsPresent: true,
      },
      {
        envVariables: {
          assets: 'https://cdn.example.com/',
          Case1_Working_png: 'Case1_Working.png?alt=media&token=abc',
          E1: 'EV111',
        },
      },
      { secrets: { S1: 'SK1' } },
      ['Case1_Working.png'],
      [{ fileName: 'Case1_Working.png' }]
    );

    expect(result.configMatch).toBe(false);
    expect(result.secretsMatch).toBe(true);
    expect(result.filesToUpdate).toEqual(['.env.config']);
  });

  it('prepareEnvPushState omits cloud asset keys when no local asset files exist', async () => {
    await fs.writeFile(path.join(tmpDir, '.env.config'), 'E1=EV11\n', 'utf8');

    const state = await prepareEnvPushState({
      projectRoot: tmpDir,
      cloudEnv: {
        config: { envVariables: { assets: 'https://cdn.example.com/', E1: 'EV1' } },
      },
      assetFileNames: [],
      warn: () => {},
    });

    expect(state.diff.configChanged).toBe(true);
    expect(state.pushConfigDto?.envVariables).toEqual({ E1: 'EV11' });
  });

  it('applyReleaseConfigToFs restores full snapshot config', async () => {
    await applyReleaseConfigToFs(tmpDir, {
      envVariables: {
        assets: 'https://cdn.example.com/',
        logo_png: 'logo.png',
        E1: 'EV1',
      },
    });

    const envConfig = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    expect(envConfig).toContain('assets=https://cdn.example.com/');
    expect(envConfig).toContain('logo_png=logo.png');
    expect(envConfig).toContain('E1=EV1');
  });

  it('warnIfMissingEnvFilesForPush warns when cloud has values but local files are missing', () => {
    const warnings: string[] = [];
    warnIfMissingEnvFilesForPush(
      {
        envConfig: [],
        envSecrets: [],
        envConfigPresent: false,
        envSecretsPresent: false,
      },
      {
        config: { envVariables: { E1: 'EV1' } },
        secrets: { secrets: { S1: 'SK1' } },
      },
      [],
      (message) => warnings.push(message)
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('.env.config is missing');
    expect(warnings[1]).toContain('.env.secrets is missing');
  });
});
