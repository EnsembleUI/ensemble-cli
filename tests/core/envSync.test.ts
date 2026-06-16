import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  applyCloudEnvToFs,
  applyReleaseConfigToFs,
  buildConfigDtoForReleaseSnapshot,
  buildConfigDtoFromEnvConfigFile,
  buildEnvPushDiff,
  buildSecretsDtoFromEnvSecretsFile,
  configDtoToEnvEntries,
  envConfigEntriesMatchCloud,
  envSecretsEntriesMatchCloud,
  mergeConfigDtoForPush,
  readProjectEnvFiles,
  secretsDtoToEnvEntries,
  warnIfMissingEnvFilesForPush,
} from '../../src/core/envSync.js';
import type { ConfigDTO, SecretDTO } from '../../src/core/dto.js';

describe('envSync', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-envSync-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('maps cloud config envVariables to .env.config entries', () => {
    const config: ConfigDTO = { envVariables: { API_URL: 'https://api.example.com' } };
    expect(configDtoToEnvEntries(config)).toEqual([
      { key: 'API_URL', value: 'https://api.example.com' },
    ]);
  });

  it('maps cloud secrets to .env.secrets entries', () => {
    const secrets: SecretDTO = { secrets: { S1: 'secret-value' } };
    expect(secretsDtoToEnvEntries(secrets)).toEqual([{ key: 'S1', value: 'secret-value' }]);
  });

  it('writes cloud env vars and secrets to local env files on pull', async () => {
    await applyCloudEnvToFs(tmpDir, {
      config: { envVariables: { API_URL: 'https://api.example.com' } },
      secrets: { secrets: { S1: 'secret-value' } },
    });

    const envConfig = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    const envSecrets = await fs.readFile(path.join(tmpDir, '.env.secrets'), 'utf8');
    expect(envConfig).toContain('API_URL=https://api.example.com');
    expect(envSecrets).toContain('S1=secret-value');
  });

  it('preserves asset keys in .env.config when applying cloud config env vars', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.env.config'),
      'assets=https://cdn.example.com/\nlogo_png=logo.png\n',
      'utf8'
    );

    await applyCloudEnvToFs(
      tmpDir,
      {
        config: { envVariables: { API_URL: 'https://api.example.com' } },
      },
      ['logo.png']
    );

    const envConfig = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    expect(envConfig).toContain('assets=https://cdn.example.com/');
    expect(envConfig).toContain('logo_png=logo.png');
    expect(envConfig).toContain('API_URL=https://api.example.com');
  });

  it('reads local env files excluding asset keys from config payload', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.env.config'),
      [
        'assets=https://cdn.example.com/',
        'logo_png=logo.png',
        'API_URL=https://local.example.com',
      ].join('\n') + '\n',
      'utf8'
    );
    await fs.writeFile(path.join(tmpDir, '.env.secrets'), 'S1=local-secret\n', 'utf8');

    const local = await readProjectEnvFiles(tmpDir);
    expect(buildConfigDtoFromEnvConfigFile(local.envConfig, ['logo.png'])).toEqual({
      envVariables: { API_URL: 'https://local.example.com' },
    });
    expect(buildSecretsDtoFromEnvSecretsFile(local.envSecrets)).toEqual({
      secrets: { S1: 'local-secret' },
    });
  });

  it('detects when local env files differ from cloud', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.env.config'),
      'API_URL=https://local.example.com\n',
      'utf8'
    );
    await fs.writeFile(path.join(tmpDir, '.env.secrets'), 'S1=local-secret\n', 'utf8');

    const local = await readProjectEnvFiles(tmpDir);
    expect(
      envConfigEntriesMatchCloud(local.envConfig, {
        envVariables: { API_URL: 'https://cloud.example.com' },
      })
    ).toBe(false);
    expect(envSecretsEntriesMatchCloud(local.envSecrets, { secrets: { S1: 'cloud-secret' } })).toBe(
      false
    );
  });

  it('builds env push diff with local and cloud values', async () => {
    const local = {
      envConfig: [{ key: 'API_URL', value: 'https://local.example.com' }],
      envSecrets: [{ key: 'S1', value: 'local-secret' }],
    };
    const diff = buildEnvPushDiff(
      local,
      {
        config: { envVariables: { API_URL: 'https://cloud.example.com' } },
        secrets: { secrets: { S1: 'cloud-secret' } },
      },
      []
    );
    expect(diff.configChanged).toBe(true);
    expect(diff.secretsChanged).toBe(true);
    expect(diff.local.config?.envVariables?.API_URL).toBe('https://local.example.com');
    expect(diff.cloud.config?.envVariables?.API_URL).toBe('https://cloud.example.com');
  });

  it('compares asset env key values when cloud config includes them', () => {
    const local = {
      envConfig: [
        { key: 'assets', value: 'https://cdn.example.com/' },
        { key: 'logo_png', value: 'logo.png' },
        { key: 'E1', value: 'EV1' },
        { key: 'E2', value: 'EV2' },
      ],
      envSecrets: [],
    };
    const cloudConfig: ConfigDTO = {
      envVariables: {
        assets: 'https://cdn.example.com/',
        logo_png: 'logo.png?token=abc',
        E1: 'EV1',
        E2: 'EV2',
      },
    };
    expect(envConfigEntriesMatchCloud(local.envConfig, cloudConfig, ['logo.png'])).toBe(false);

    const matchingLocal = {
      envConfig: [
        { key: 'assets', value: 'https://cdn.example.com/' },
        { key: 'logo_png', value: 'logo.png?token=abc' },
        { key: 'E1', value: 'EV1' },
        { key: 'E2', value: 'EV2' },
      ],
      envSecrets: [],
    };
    expect(envConfigEntriesMatchCloud(matchingLocal.envConfig, cloudConfig, ['logo.png'])).toBe(
      true
    );
  });

  it('strips asset keys from cloud side of env push diff', () => {
    const diff = buildEnvPushDiff(
      {
        envConfig: [{ key: 'E1', value: 'EV11' }],
        envSecrets: [],
      },
      {
        config: {
          envVariables: {
            assets: 'https://cdn.example.com/',
            logo_png: 'logo.png',
            E1: 'EV1',
            E2: 'EV2',
          },
        },
      },
      ['logo.png']
    );
    expect(diff.configChanged).toBe(true);
    expect(diff.cloud.config?.envVariables).toEqual({ E1: 'EV1', E2: 'EV2' });
    expect(diff.local.config?.envVariables).toEqual({ E1: 'EV11' });
  });

  it('removes deleted non-asset keys from .env.config when cloud no longer has them', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.env.config'),
      'assets=https://cdn.example.com/\nlogo_png=logo.png\nE1=EV1\nE2=EV2\n',
      'utf8'
    );

    await applyCloudEnvToFs(tmpDir, { config: { envVariables: { E1: 'EV1' } } }, ['logo.png']);

    const envConfig = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    expect(envConfig).toContain('E1=EV1');
    expect(envConfig).not.toContain('E2=');
    expect(envConfig).toContain('assets=https://cdn.example.com/');
    expect(envConfig).toContain('logo_png=logo.png');
  });

  it('merges local env vars with cloud asset keys for push payload', () => {
    const merged = mergeConfigDtoForPush(
      { envVariables: { E1: 'EV11', E2: 'EV2' } },
      {
        envVariables: {
          assets: 'https://cdn.example.com/',
          logo_png: 'logo.png?token=abc',
          E1: 'EV1',
        },
      },
      ['logo.png']
    );
    expect(merged.envVariables).toEqual({
      assets: 'https://cdn.example.com/',
      logo_png: 'logo.png?token=abc',
      E1: 'EV11',
      E2: 'EV2',
    });
  });

  it('drops removed non-asset keys from push payload', () => {
    const merged = mergeConfigDtoForPush(
      { envVariables: { E1: 'EV11' } },
      {
        envVariables: {
          assets: 'https://cdn.example.com/',
          E1: 'EV1',
          E2: 'EV2',
        },
      },
      ['logo.png']
    );
    expect(merged.envVariables).toEqual({
      assets: 'https://cdn.example.com/',
      E1: 'EV11',
    });
  });

  it('buildConfigDtoForReleaseSnapshot includes asset keys from .env.config', () => {
    const dto = buildConfigDtoForReleaseSnapshot([
      { key: 'assets', value: 'https://cdn.example.com/' },
      { key: 'logo_png', value: 'logo.png?token=abc' },
      { key: 'E1', value: 'EV1' },
    ]);
    expect(dto?.envVariables).toEqual({
      assets: 'https://cdn.example.com/',
      logo_png: 'logo.png?token=abc',
      E1: 'EV1',
    });
  });

  it('applyReleaseConfigToFs restores .env.config from snapshot config only', async () => {
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

  it('detects missing asset env keys in .env.config when comparing pull state', () => {
    expect(
      envConfigEntriesMatchCloud(
        [
          { key: 'assets', value: 'https://cdn.example.com/' },
          { key: 'E1', value: 'EV111' },
        ],
        {
          envVariables: {
            assets: 'https://cdn.example.com/',
            Case1_Working_png: 'Case1_Working.png?alt=media&token=abc',
            E1: 'EV111',
          },
        },
        ['Case1_Working.png']
      )
    ).toBe(false);
  });

  it('warns when env files are missing locally but cloud has values', () => {
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

  it('does not treat missing env files as empty local deletes on push', () => {
    const diff = buildEnvPushDiff(
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
      []
    );
    expect(diff.configChanged).toBe(false);
    expect(diff.secretsChanged).toBe(false);
    expect(diff.local).toEqual({});
    expect(diff.cloud).toEqual({});
  });

  it('omits local and cloud env snapshots when already in sync', () => {
    const diff = buildEnvPushDiff(
      {
        envConfig: [{ key: 'E1', value: 'EV1' }],
        envSecrets: [{ key: 'S1', value: 'SK1' }],
        envConfigPresent: true,
        envSecretsPresent: true,
      },
      {
        config: { envVariables: { E1: 'EV1' } },
        secrets: { secrets: { S1: 'SK1' } },
      },
      []
    );
    expect(diff.configChanged).toBe(false);
    expect(diff.secretsChanged).toBe(false);
    expect(diff.local).toEqual({});
    expect(diff.cloud).toEqual({});
  });
});
