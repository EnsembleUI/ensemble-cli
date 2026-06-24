import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { writeEnvFile, type EnvEntry } from '../../src/core/envConfig.js';
import {
  applyCloudEnvToFs,
  applyReleaseEnvToFs,
  buildEnvPushDiff,
  buildPushConfigDto,
  computeEnvPullChanges,
  pruneStaleAssetEnvEntries,
  prepareEnvPushState,
  readProjectEnvFiles,
  type CloudEnvState,
  type LocalEnvFiles,
} from '../../src/core/envSync.js';
import { envConfigScopedFile, envSecretsScopedFile } from '../../src/core/envConfig.js';

function localEnv(
  overrides: Partial<LocalEnvFiles> & Pick<LocalEnvFiles, 'envConfig'>
): LocalEnvFiles {
  const baseConfig = overrides.baseConfig ?? overrides.envConfig;
  return {
    appKey: 'default',
    useScoped: false,
    configWriteFile: '.env.config',
    secretsWriteFile: '.env.secrets',
    envSecrets: [],
    baseConfig,
    scopedConfig: [],
    baseSecrets: [],
    scopedSecrets: [],
    envConfigPresent: true,
    envSecretsPresent: false,
    baseConfigPresent: true,
    scopedConfigPresent: false,
    baseSecretsPresent: false,
    scopedSecretsPresent: false,
    ...overrides,
    envConfig: overrides.envConfig,
  };
}

function localEnvFromParts(
  configEntries: EnvEntry[],
  assetEntries: EnvEntry[] = []
): LocalEnvFiles {
  const envConfig = [...configEntries, ...assetEntries];
  return localEnv({ envConfig, baseConfig: envConfig });
}

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
      ['logo.png'],
      'default'
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
    cloudAssets?: Array<{ fileName?: string; copyText?: string }>;
    configChanged: boolean;
    secretsChanged: boolean;
    wouldClearConfig?: boolean;
    wouldClearSecrets?: boolean;
    cloudConfig?: Record<string, string>;
    localConfig?: Record<string, string>;
  }>([
    {
      name: 'detects config and secrets changes',
      local: localEnv({
        envConfig: [{ key: 'E1', value: 'local' }],
        envSecrets: [{ key: 'S1', value: 'local' }],
        envSecretsPresent: true,
      }),
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
      local: localEnv({
        envConfig: [{ key: 'E1', value: 'EV1' }],
        envSecrets: [{ key: 'S1', value: 'SK1' }],
        envSecretsPresent: true,
      }),
      cloud: {
        config: { envVariables: { E1: 'EV1' } },
        secrets: { secrets: { S1: 'SK1' } },
      },
      assets: [],
      configChanged: false,
      secretsChanged: false,
    },
    {
      name: 'skips env push when env files are missing but cloud has values',
      local: localEnv({
        envConfig: [],
        baseConfig: [],
        envConfigPresent: false,
        envSecretsPresent: false,
        baseConfigPresent: false,
      }),
      cloud: {
        config: { envVariables: { E1: 'EV1' } },
        secrets: { secrets: { S1: 'SK1' } },
      },
      assets: [],
      configChanged: false,
      secretsChanged: false,
      wouldClearConfig: false,
      wouldClearSecrets: false,
    },
    {
      name: 'wipes cloud when env files are present but empty',
      local: localEnv({
        envConfig: [],
        baseConfig: [],
        envSecrets: [],
        envConfigPresent: true,
        envSecretsPresent: true,
      }),
      cloud: {
        config: { envVariables: { E1: 'EV1' } },
        secrets: { secrets: { S1: 'SK1' } },
      },
      assets: [],
      configChanged: true,
      secretsChanged: true,
      wouldClearConfig: true,
      wouldClearSecrets: true,
    },
    {
      name: 'shows full push config vs cloud including asset keys',
      local: localEnv({
        envConfig: [
          { key: 'E1', value: 'EV11' },
          { key: 'assets', value: 'https://cdn.example.com/' },
          { key: 'logo_png', value: 'logo.png?local=abc' },
        ],
      }),
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
      cloudConfig: {
        assets: 'https://cdn.example.com/',
        logo_png: 'logo.png',
        E1: 'EV1',
        E2: 'EV2',
      },
      localConfig: {
        assets: 'https://cdn.example.com/',
        logo_png: 'logo.png?local=abc',
        E1: 'EV11',
      },
    },
    {
      name: 'flags configChanged when only stale asset env keys differ from cloud',
      local: localEnv({
        envConfig: [{ key: 'E1', value: 'EV1' }],
      }),
      cloud: {
        config: {
          envVariables: {
            assets: 'https://cdn.example.com/',
            DSA_Viva_rtf: 'DSA%20Viva.rtf?token=abc',
            github_html: 'first%20token%20github.html?token=def',
            E1: 'EV1',
          },
        },
      },
      assets: [],
      cloudAssets: [
        { fileName: 'DSA Viva.rtf' },
        { fileName: 'first token github.html', copyText: '${env.github_html}' },
      ],
      configChanged: true,
      secretsChanged: false,
      localConfig: { E1: 'EV1' },
      cloudConfig: {
        assets: 'https://cdn.example.com/',
        DSA_Viva_rtf: 'DSA%20Viva.rtf?token=abc',
        github_html: 'first%20token%20github.html?token=def',
        E1: 'EV1',
      },
    },
  ])(
    '$name',
    ({
      local,
      cloud,
      assets,
      cloudAssets,
      configChanged,
      secretsChanged,
      wouldClearConfig = false,
      wouldClearSecrets = false,
      cloudConfig,
      localConfig,
    }) => {
      const diff = buildEnvPushDiff(local, cloud, assets, cloudAssets);
      expect(diff.configChanged).toBe(configChanged);
      expect(diff.secretsChanged).toBe(secretsChanged);
      expect(diff.wouldClearConfig).toBe(wouldClearConfig);
      expect(diff.wouldClearSecrets).toBe(wouldClearSecrets);
      if (!configChanged && !secretsChanged) {
        expect(diff.local).toEqual({});
        expect(diff.cloud).toEqual({});
        return;
      }
      if (cloudConfig) expect(diff.cloud.config?.envVariables).toEqual(cloudConfig);
      if (localConfig) expect(diff.local.config?.envVariables).toEqual(localConfig);
    }
  );

  it('buildPushConfigDto keeps local assets and drops deleted cloud asset keys', () => {
    expect(
      buildPushConfigDto(
        localEnvFromParts(
          [
            { key: 'E1', value: 'EV11' },
            { key: 'E2', value: 'EV2' },
          ],
          [
            { key: 'assets', value: 'https://cdn.example.com/' },
            { key: 'logo_png', value: 'logo.png?local=abc' },
          ]
        ),
        {
          envVariables: {
            assets: 'https://cdn.example.com/',
            logo_png: 'logo.png?token=abc',
            E1: 'EV1',
          },
        },
        ['logo.png']
      ).envVariables
    ).toEqual({
      assets: 'https://cdn.example.com/',
      logo_png: 'logo.png?local=abc',
      E1: 'EV11',
      E2: 'EV2',
    });

    expect(
      buildPushConfigDto(
        localEnvFromParts(
          [{ key: 'E1', value: 'EV11' }],
          [
            { key: 'assets', value: 'https://cdn.example.com/' },
            { key: 'report_html', value: 'report.html?local=abc' },
          ]
        ),
        {
          envVariables: {
            assets: 'https://cdn.example.com/',
            report_html: 'report.html?token=abc',
            sheet_xlsx: 'sheet.xlsx?token=def',
            E1: 'EV1',
          },
        },
        ['report.html'],
        [
          { fileName: 'report.html', copyText: '${env.report_html}' },
          { fileName: 'sheet.xlsx', copyText: '${env.sheet_xlsx}' },
        ]
      ).envVariables
    ).toEqual({
      assets: 'https://cdn.example.com/',
      report_html: 'report.html?local=abc',
      E1: 'EV11',
    });

    expect(
      buildPushConfigDto(
        localEnvFromParts([{ key: 'E1', value: 'EV11' }]),
        {
          envVariables: {
            assets: 'https://cdn.example.com/',
            logo_png: 'logo.png?token=abc',
            E1: 'EV1',
            E2: 'EV2',
          },
        },
        []
      ).envVariables
    ).toEqual({ E1: 'EV11' });
  });

  it.each<{
    name: string;
    entries: Array<{ key: string; value: string }>;
    assetFileNames: string[];
    cloudAssets?: Array<{ fileName?: string; copyText?: string }>;
    expected: Array<{ key: string; value: string }>;
  }>([
    {
      name: 'removes copyText and derived keys for deleted assets',
      entries: [
        { key: 'assets', value: 'https://cdn.example.com/' },
        { key: 'report_html', value: 'report.html?token=abc' },
        { key: 'sheet_xlsx', value: 'sheet.xlsx?token=def' },
        { key: 'MIH_4735_pdf', value: 'MIH-4735.pdf?token=xyz' },
        { key: 'E1', value: 'EV1' },
      ],
      assetFileNames: [],
      cloudAssets: [
        { fileName: 'report.html', copyText: '${env.report_html}' },
        { fileName: 'sheet.xlsx', copyText: '${env.sheet_xlsx}' },
      ],
      expected: [{ key: 'E1', value: 'EV1' }],
    },
    {
      name: 'keeps local assets and user config',
      entries: [
        { key: 'assets', value: 'https://cdn.example.com/' },
        { key: 'img1_png', value: 'img1.png?token=abc' },
        { key: 'deleted_png', value: 'deleted.png?token=def' },
        { key: 'E1', value: 'EV1' },
      ],
      assetFileNames: ['img1.png'],
      expected: [
        { key: 'assets', value: 'https://cdn.example.com/' },
        { key: 'img1_png', value: 'img1.png?token=abc' },
        { key: 'E1', value: 'EV1' },
      ],
    },
    {
      name: 'keeps non-asset keys whose value looks like a file URL',
      entries: [{ key: 'download_url', value: 'https://cdn.example.com/guide.pdf?token=abc' }],
      assetFileNames: [],
      expected: [{ key: 'download_url', value: 'https://cdn.example.com/guide.pdf?token=abc' }],
    },
  ])('$name', ({ entries, assetFileNames, cloudAssets, expected }) => {
    expect(pruneStaleAssetEnvEntries(entries, assetFileNames, cloudAssets)).toEqual(expected);
  });

  it('computeEnvPullChanges flags config mismatch including missing asset env keys', () => {
    const result = computeEnvPullChanges(
      localEnv({
        envConfig: [
          { key: 'assets', value: 'https://cdn.example.com/' },
          { key: 'E1', value: 'EV111' },
        ],
        envSecrets: [{ key: 'S1', value: 'SK1' }],
        envSecretsPresent: true,
      }),
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

  it('computeEnvPullChanges flags missing asset keys in scoped alias config files', () => {
    const result = computeEnvPullChanges(
      localEnv({
        useScoped: true,
        configWriteFile: '.env.config.uat',
        envConfig: [{ key: 'E2', value: 'EK2' }],
        envConfigPresent: true,
      }),
      {
        envVariables: {
          assets: 'https://cdn.example.com/',
          logo_png: 'logo.png?token=abc',
          E2: 'EK2',
        },
      },
      undefined,
      ['logo.png'],
      [{ fileName: 'logo.png' }]
    );

    expect(result.configMatch).toBe(false);
    expect(result.filesToUpdate).toEqual(['.env.config.uat']);
  });

  it('prepareEnvPushState omits cloud asset keys when no local asset files exist', async () => {
    await fs.writeFile(path.join(tmpDir, '.env.config'), 'E1=EV11\n', 'utf8');

    const state = await prepareEnvPushState({
      projectRoot: tmpDir,
      appKey: 'default',
      defaultAppKey: 'default',
      cloudEnv: {
        config: { envVariables: { assets: 'https://cdn.example.com/', E1: 'EV1' } },
      },
      assetFileNames: [],
    });

    expect(state.diff.configChanged).toBe(true);
    expect(state.pushConfigDto?.envVariables).toEqual({ E1: 'EV11' });
  });

  it('prepareEnvPushState prunes stale asset env keys only after confirm', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.env.config'),
      'assets=https://cdn.example.com/\nimg1_png=img1.png?token=abc\ndel_png=del.png?token=def\nE1=EV11\n',
      'utf8'
    );

    const state = await prepareEnvPushState({
      projectRoot: tmpDir,
      appKey: 'default',
      defaultAppKey: 'default',
      cloudEnv: { config: { envVariables: { E1: 'EV1' } } },
      assetFileNames: ['img1.png'],
    });

    const envConfigBeforeConfirm = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    expect(envConfigBeforeConfirm).toContain('del_png=');
    expect(state.pendingLocalEnvConfigWrite?.some((entry) => entry.key === 'del_png')).toBe(false);

    await writeEnvFile(tmpDir, '.env.config', state.pendingLocalEnvConfigWrite!);

    const envConfig = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    expect(envConfig).toContain('img1_png=img1.png?token=abc');
    expect(envConfig).not.toContain('del_png=');
  });

  it('applyReleaseEnvToFs restores full snapshot config', async () => {
    await applyReleaseEnvToFs(
      tmpDir,
      {
        envVariables: {
          assets: 'https://cdn.example.com/',
          logo_png: 'logo.png',
          E1: 'EV1',
        },
      },
      undefined,
      'default',
      'default'
    );

    const envConfig = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    expect(envConfig).toContain('assets=https://cdn.example.com/');
    expect(envConfig).toContain('logo_png=logo.png');
    expect(envConfig).toContain('E1=EV1');
  });

  it('applyReleaseEnvToFs preserves env file key order', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.env.config'),
      'assets=https://old/\nkwnd_png=old.png\nE1=old\n',
      'utf8'
    );

    await applyReleaseEnvToFs(
      tmpDir,
      {
        envVariables: {
          E1: 'EV1',
          assets: 'https://new/',
          kwnd_png: 'new.png',
        },
      },
      undefined,
      'default',
      'default'
    );

    const lines = (await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8')).trim().split('\n');
    expect(lines[0]).toMatch(/^assets=https:\/\/new\//);
    expect(lines[1]).toMatch(/^kwnd_png=new\.png$/);
    expect(lines[2]).toMatch(/^E1=EV1$/);
  });

  it('readProjectEnvFiles uses scoped pair when both alias files exist', async () => {
    await fs.writeFile(path.join(tmpDir, '.env.config'), 'E1=base\nE2=shared\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.env.secrets'), 'S1=base\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, envConfigScopedFile('uat')), 'E1=uat\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, envSecretsScopedFile('uat')), 'S1=uat\n', 'utf8');

    const env = await readProjectEnvFiles(tmpDir, 'uat', 'dev');
    expect(env.useScoped).toBe(true);
    expect(env.configWriteFile).toBe('.env.config.uat');
    expect(env.secretsWriteFile).toBe('.env.secrets.uat');
    expect(env.envConfig).toEqual([{ key: 'E1', value: 'uat' }]);
    expect(env.envSecrets).toEqual([{ key: 'S1', value: 'uat' }]);
  });

  it('readProjectEnvFiles uses base for default alias when only base files exist', async () => {
    await fs.writeFile(path.join(tmpDir, '.env.config'), 'E1=base\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.env.secrets'), 'S1=base\n', 'utf8');

    const env = await readProjectEnvFiles(tmpDir, 'dev', 'dev');
    expect(env.useScoped).toBe(false);
    expect(env.configWriteFile).toBe('.env.config');
    expect(env.envConfig).toEqual([{ key: 'E1', value: 'base' }]);
    expect(env.envSecrets).toEqual([{ key: 'S1', value: 'base' }]);
  });

  it('readProjectEnvFiles targets scoped paths for non-default alias even before files exist', async () => {
    await fs.writeFile(path.join(tmpDir, '.env.config'), 'E1=base\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.env.secrets'), 'S1=base\n', 'utf8');

    const env = await readProjectEnvFiles(tmpDir, 'uat', 'dev');
    expect(env.useScoped).toBe(true);
    expect(env.configWriteFile).toBe('.env.config.uat');
    expect(env.secretsWriteFile).toBe('.env.secrets.uat');
    expect(env.envConfig).toEqual([]);
    expect(env.envSecrets).toEqual([]);
    expect(env.envConfigPresent).toBe(false);
    expect(env.envSecretsPresent).toBe(false);
  });

  it('applyCloudEnvToFs creates scoped files for non-default alias without touching base', async () => {
    await fs.writeFile(path.join(tmpDir, '.env.config'), 'E1=base\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.env.secrets'), 'S1=base\n', 'utf8');
    await applyCloudEnvToFs(
      tmpDir,
      {
        config: {
          envVariables: {
            assets: 'https://cdn.example.com/',
            logo_png: 'logo.png',
            E1: 'uat',
            E2: 'new',
          },
        },
        secrets: { secrets: { S1: 'sk' } },
      },
      ['logo.png'],
      'uat',
      'dev'
    );

    const baseConfig = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    const baseSecrets = await fs.readFile(path.join(tmpDir, '.env.secrets'), 'utf8');
    const scoped = await fs.readFile(path.join(tmpDir, envConfigScopedFile('uat')), 'utf8');
    const secrets = await fs.readFile(path.join(tmpDir, envSecretsScopedFile('uat')), 'utf8');
    expect(baseConfig).toContain('E1=base');
    expect(baseSecrets).toContain('S1=base');
    expect(scoped).toContain('E1=uat');
    expect(scoped).toContain('E2=new');
    expect(scoped).toContain('assets=https://cdn.example.com/');
    expect(scoped).toContain('logo_png=logo.png');
    expect(secrets).toContain('S1=sk');
  });
});
