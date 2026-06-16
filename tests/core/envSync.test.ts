import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { writeEnvFile, type EnvEntry } from '../../src/core/envConfig.js';
import {
  applyCloudEnvToFs,
  applyReleaseConfigToFs,
  buildEnvPushDiff,
  buildPushConfigDto,
  computeEnvPullChanges,
  pruneStaleAssetEnvEntries,
  prepareEnvPushState,
  warnIfMissingEnvFilesForPush,
  type CloudEnvState,
  type LocalEnvFiles,
} from '../../src/core/envSync.js';

function localEnvFromParts(
  configEntries: EnvEntry[],
  assetEntries: EnvEntry[] = []
): LocalEnvFiles {
  return {
    envConfig: [...configEntries, ...assetEntries],
    envSecrets: [],
    envConfigPresent: true,
    envSecretsPresent: false,
  };
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
    cloudAssets?: Array<{ fileName?: string; copyText?: string }>;
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
      name: 'shows full push config vs cloud including asset keys',
      local: {
        envConfig: [
          { key: 'E1', value: 'EV11' },
          { key: 'assets', value: 'https://cdn.example.com/' },
          { key: 'logo_png', value: 'logo.png?local=abc' },
        ],
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
      local: {
        envConfig: [{ key: 'E1', value: 'EV1' }],
        envSecrets: [],
        envConfigPresent: true,
        envSecretsPresent: true,
      },
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
      cloudConfig,
      localConfig,
    }) => {
      const diff = buildEnvPushDiff(local, cloud, assets, cloudAssets);
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

  it('prepareEnvPushState prunes stale asset env keys only after confirm', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.env.config'),
      'assets=https://cdn.example.com/\nimg1_png=img1.png?token=abc\ndel_png=del.png?token=def\nE1=EV11\n',
      'utf8'
    );

    const state = await prepareEnvPushState({
      projectRoot: tmpDir,
      cloudEnv: { config: { envVariables: { E1: 'EV1' } } },
      assetFileNames: ['img1.png'],
      warn: () => {},
    });

    const envConfigBeforeConfirm = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    expect(envConfigBeforeConfirm).toContain('del_png=');
    expect(state.pendingLocalEnvConfigWrite?.some((entry) => entry.key === 'del_png')).toBe(false);

    await writeEnvFile(tmpDir, '.env.config', state.pendingLocalEnvConfigWrite!);

    const envConfig = await fs.readFile(path.join(tmpDir, '.env.config'), 'utf8');
    expect(envConfig).toContain('img1_png=img1.png?token=abc');
    expect(envConfig).not.toContain('del_png=');
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
