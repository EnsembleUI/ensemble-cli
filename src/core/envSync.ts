import type { ConfigDTO, SecretDTO } from './dto.js';
import { deriveAssetEnvKey } from './pullAssets.js';
import {
  envFileExists,
  readEnvFile,
  upsertEnvFile,
  writeEnvFile,
  type EnvEntry,
} from './envConfig.js';

export interface CloudEnvState {
  config?: ConfigDTO;
  secrets?: SecretDTO;
}

export interface LocalEnvFiles {
  envConfig: EnvEntry[];
  envSecrets: EnvEntry[];
  /** false when the file does not exist (distinct from an empty file). */
  envConfigPresent: boolean;
  envSecretsPresent: boolean;
}

export function configDtoToEnvEntries(config: ConfigDTO | undefined): EnvEntry[] {
  const vars = config?.envVariables;
  if (!vars || typeof vars !== 'object') return [];
  return Object.entries(vars)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: String(value) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function secretsDtoToEnvEntries(secrets: SecretDTO | undefined): EnvEntry[] {
  if (!secrets || typeof secrets !== 'object') return [];
  const nested =
    secrets.secrets && typeof secrets.secrets === 'object'
      ? (secrets.secrets as Record<string, unknown>)
      : (secrets as Record<string, unknown>);
  return Object.entries(nested)
    .filter(([key, value]) => key !== 'secrets' && value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: String(value) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function collectAssetEnvKeys(assetFileNames: string[] = []): Set<string> {
  return new Set(['assets', ...assetFileNames.map(deriveAssetEnvKey)]);
}

function partitionConfigEnvVariables(
  config: ConfigDTO | undefined,
  assetFileNames: string[] = []
): { asset: Record<string, string>; nonAsset: Record<string, string> } {
  const assetKeys = collectAssetEnvKeys(assetFileNames);
  const asset: Record<string, string> = {};
  const nonAsset: Record<string, string> = {};
  const vars = config?.envVariables;
  if (!vars || typeof vars !== 'object') return { asset, nonAsset };

  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined || value === null) continue;
    const normalized = String(value);
    if (assetKeys.has(key)) asset[key] = normalized;
    else nonAsset[key] = normalized;
  }
  return { asset, nonAsset };
}

function configDtoFromEnvVariables(envVariables: Record<string, string>): ConfigDTO | undefined {
  return Object.keys(envVariables).length > 0 ? { envVariables } : undefined;
}

function buildConfigDtoFromEntries(
  entries: EnvEntry[],
  options?: { excludeKeys?: Set<string> }
): ConfigDTO | undefined {
  const envVariables: Record<string, string> = {};
  for (const entry of entries) {
    if (options?.excludeKeys?.has(entry.key)) continue;
    envVariables[entry.key] = entry.value;
  }
  return Object.keys(envVariables).length > 0 ? { envVariables } : undefined;
}

export function stripAssetKeysFromConfigDto(
  config: ConfigDTO | undefined,
  assetFileNames: string[] = []
): ConfigDTO | undefined {
  const { nonAsset } = partitionConfigEnvVariables(config, assetFileNames);
  return configDtoFromEnvVariables(nonAsset);
}

export function buildConfigDtoFromEnvConfigFile(
  entries: EnvEntry[],
  assetFileNames: string[] = []
): ConfigDTO | undefined {
  return buildConfigDtoFromEntries(entries, {
    excludeKeys: collectAssetEnvKeys(assetFileNames),
  });
}

export function mergeConfigDtoForPush(
  localNonAssetConfig: ConfigDTO | undefined,
  cloudConfig: ConfigDTO | undefined,
  assetFileNames: string[] = []
): ConfigDTO {
  const { asset } = partitionConfigEnvVariables(cloudConfig, assetFileNames);
  return {
    envVariables: {
      ...asset,
      ...(localNonAssetConfig?.envVariables ?? {}),
    },
  };
}

export function buildSecretsDtoFromEnvSecretsFile(entries: EnvEntry[]): SecretDTO | undefined {
  if (entries.length === 0) return undefined;
  const secrets: Record<string, string> = {};
  for (const entry of entries) {
    secrets[entry.key] = entry.value;
  }
  return { secrets };
}

export function warnIfMissingEnvFilesForPush(
  localEnv: LocalEnvFiles,
  cloudEnv: CloudEnvState,
  assetFileNames: string[] = [],
  warn: (message: string) => void
): void {
  if (!localEnv.envConfigPresent && cloudHasNonAssetConfig(cloudEnv.config, assetFileNames)) {
    warn(
      '.env.config is missing locally. Run `ensemble pull` to restore env vars from cloud. Config env push skipped.'
    );
  }
  if (!localEnv.envSecretsPresent && cloudHasSecrets(cloudEnv.secrets)) {
    warn(
      '.env.secrets is missing locally. Run `ensemble pull` to restore secrets from cloud. Secrets env push skipped.'
    );
  }
}

export async function readProjectEnvFiles(projectRoot: string): Promise<LocalEnvFiles> {
  const [envConfigPresent, envSecretsPresent] = await Promise.all([
    envFileExists(projectRoot, '.env.config'),
    envFileExists(projectRoot, '.env.secrets'),
  ]);
  const envConfig = envConfigPresent ? await readEnvFile(projectRoot, '.env.config') : [];
  const envSecrets = envSecretsPresent ? await readEnvFile(projectRoot, '.env.secrets') : [];
  return { envConfig, envSecrets, envConfigPresent, envSecretsPresent };
}

export function cloudHasNonAssetConfig(
  cloudConfig: ConfigDTO | undefined,
  assetFileNames: string[] = []
): boolean {
  return configDtoToEnvEntries(stripAssetKeysFromConfigDto(cloudConfig, assetFileNames)).length > 0;
}

export function cloudHasSecrets(cloudSecrets: SecretDTO | undefined): boolean {
  return secretsDtoToEnvEntries(cloudSecrets).length > 0;
}

function entriesEqual(a: EnvEntry[], b: EnvEntry[]): boolean {
  const mapA = new Map(a.map((e) => [e.key, e.value]));
  const mapB = new Map(b.map((e) => [e.key, e.value]));
  if (mapA.size !== mapB.size) return false;
  for (const [key, value] of mapA) {
    if (mapB.get(key) !== value) return false;
  }
  return true;
}

export function mergeAssetFileNamesForEnvCompare(
  localAssetFileNames: string[] = [],
  cloudAssets: Array<{ fileName?: string; isArchived?: boolean }> | undefined = []
): string[] {
  const fromCloud = (cloudAssets ?? [])
    .filter((asset) => asset.isArchived !== true)
    .map((asset) => asset.fileName)
    .filter((fileName): fileName is string => typeof fileName === 'string' && fileName.length > 0);
  return [...new Set([...localAssetFileNames, ...fromCloud])];
}

function assetEnvEntriesMatchCloud(
  localEntries: EnvEntry[],
  cloudConfig: ConfigDTO | undefined,
  assetFileNames: string[] = []
): boolean {
  const assetKeys = collectAssetEnvKeys(assetFileNames);
  const localMap = new Map(localEntries.map((entry) => [entry.key, entry.value]));
  const { asset: cloudAssetVars } = partitionConfigEnvVariables(cloudConfig, assetFileNames);
  for (const key of assetKeys) {
    const cloudValue = cloudAssetVars[key];
    if (cloudValue === undefined) continue;
    if (localMap.get(key) !== cloudValue) return false;
  }
  return true;
}

export function envConfigEntriesMatchCloud(
  localEntries: EnvEntry[],
  cloudConfig: ConfigDTO | undefined,
  assetFileNames: string[] = []
): boolean {
  const localComparable = configDtoToEnvEntries(
    buildConfigDtoFromEnvConfigFile(localEntries, assetFileNames)
  );
  const cloudComparable = configDtoToEnvEntries(
    stripAssetKeysFromConfigDto(cloudConfig, assetFileNames)
  );
  return (
    entriesEqual(localComparable, cloudComparable) &&
    assetEnvEntriesMatchCloud(localEntries, cloudConfig, assetFileNames)
  );
}

export function envSecretsEntriesMatchCloud(
  localEntries: EnvEntry[],
  cloudSecrets: SecretDTO | undefined
): boolean {
  const localDto = buildSecretsDtoFromEnvSecretsFile(localEntries);
  const cloudEntries = secretsDtoToEnvEntries(cloudSecrets);
  const localComparable = secretsDtoToEnvEntries(localDto);
  return entriesEqual(localComparable, cloudEntries);
}

export interface EnvPushDiff {
  configChanged: boolean;
  secretsChanged: boolean;
  local: {
    config?: ConfigDTO;
    secrets?: SecretDTO;
  };
  cloud: {
    config?: ConfigDTO;
    secrets?: SecretDTO;
  };
}

export function buildEnvPushDiff(
  localEnv: LocalEnvFiles,
  cloudEnv: CloudEnvState,
  assetFileNames: string[] = []
): EnvPushDiff {
  const configFilePresent = localEnv.envConfigPresent ?? true;
  const secretsFilePresent = localEnv.envSecretsPresent ?? true;
  const configChanged =
    configFilePresent &&
    !envConfigEntriesMatchCloud(localEnv.envConfig, cloudEnv.config, assetFileNames);
  const secretsChanged =
    secretsFilePresent && !envSecretsEntriesMatchCloud(localEnv.envSecrets, cloudEnv.secrets);

  return {
    configChanged,
    secretsChanged,
    local: {
      ...(configChanged && {
        config: buildConfigDtoFromEnvConfigFile(localEnv.envConfig, assetFileNames) ?? {
          envVariables: {},
        },
      }),
      ...(secretsChanged && {
        secrets: buildSecretsDtoFromEnvSecretsFile(localEnv.envSecrets),
      }),
    },
    cloud: {
      ...(configChanged &&
        cloudEnv.config && {
          config: stripAssetKeysFromConfigDto(cloudEnv.config, assetFileNames) ?? {
            envVariables: {},
          },
        }),
      ...(secretsChanged && cloudEnv.secrets && { secrets: cloudEnv.secrets }),
    },
  };
}

export function buildConfigDtoForReleaseSnapshot(entries: EnvEntry[]): ConfigDTO | undefined {
  return buildConfigDtoFromEntries(entries);
}

export interface EnvPullChanges {
  assetFileNames: string[];
  configMatch: boolean;
  secretsMatch: boolean;
  match: boolean;
  filesToUpdate: Array<'.env.config' | '.env.secrets'>;
}

export function computeEnvPullChanges(
  localEnv: LocalEnvFiles | undefined,
  cloudConfig: ConfigDTO | undefined,
  cloudSecrets: SecretDTO | undefined,
  localAssetFileNames: string[] = [],
  cloudAssets: Array<{ fileName?: string; isArchived?: boolean }> | undefined = []
): EnvPullChanges {
  const assetFileNames = mergeAssetFileNamesForEnvCompare(localAssetFileNames, cloudAssets);
  const configMatch = envConfigEntriesMatchCloud(
    localEnv?.envConfig ?? [],
    cloudConfig,
    assetFileNames
  );
  const secretsMatch = envSecretsEntriesMatchCloud(localEnv?.envSecrets ?? [], cloudSecrets);
  const filesToUpdate: Array<'.env.config' | '.env.secrets'> = [];
  if (!configMatch) filesToUpdate.push('.env.config');
  if (!secretsMatch) filesToUpdate.push('.env.secrets');
  return {
    assetFileNames,
    configMatch,
    secretsMatch,
    match: configMatch && secretsMatch,
    filesToUpdate,
  };
}

export interface EnvPushState {
  localEnv: LocalEnvFiles;
  diff: EnvPushDiff;
  configChanged: boolean;
  secretsChanged: boolean;
  pushConfigDto?: ConfigDTO;
  pushSecretsDto?: SecretDTO;
}

export async function prepareEnvPushState(params: {
  projectRoot: string;
  cloudEnv: CloudEnvState;
  assetFileNames: string[];
  warn: (message: string) => void;
}): Promise<EnvPushState> {
  const localEnv = await readProjectEnvFiles(params.projectRoot);
  const diff = buildEnvPushDiff(localEnv, params.cloudEnv, params.assetFileNames);
  warnIfMissingEnvFilesForPush(localEnv, params.cloudEnv, params.assetFileNames, params.warn);

  const pushConfigDto =
    diff.configChanged && diff.local.config
      ? mergeConfigDtoForPush(diff.local.config, params.cloudEnv.config, params.assetFileNames)
      : diff.local.config;

  return {
    localEnv,
    diff,
    configChanged: diff.configChanged,
    secretsChanged: diff.secretsChanged,
    pushConfigDto,
    pushSecretsDto: diff.local.secrets,
  };
}

/** restores `.env.config` from a release snapshot; secrets are never included in releases */
export async function applyReleaseConfigToFs(
  projectRoot: string,
  config: ConfigDTO | undefined
): Promise<void> {
  const configEntries = configDtoToEnvEntries(config);
  if (configEntries.length > 0) {
    await writeEnvFile(projectRoot, '.env.config', configEntries);
  }
}

export async function applyCloudEnvToFs(
  projectRoot: string,
  cloudEnv: CloudEnvState,
  assetFileNames: string[] = []
): Promise<void> {
  await upsertCloudAssetConfigEntries(projectRoot, cloudEnv.config, assetFileNames);

  const configEntries = configDtoToEnvEntries(
    stripAssetKeysFromConfigDto(cloudEnv.config, assetFileNames)
  );
  await syncEnvConfigNonAssetEntries(projectRoot, configEntries, assetFileNames);

  const secretEntries = secretsDtoToEnvEntries(cloudEnv.secrets);
  await writeEnvFile(projectRoot, '.env.secrets', secretEntries);
}

async function upsertCloudAssetConfigEntries(
  projectRoot: string,
  cloudConfig: ConfigDTO | undefined,
  assetFileNames: string[] = []
): Promise<void> {
  const { asset } = partitionConfigEnvVariables(cloudConfig, assetFileNames);
  const entries = Object.entries(asset).map(([key, value]) => ({ key, value }));
  if (entries.length > 0) {
    await upsertEnvFile(projectRoot, '.env.config', entries);
  }
}

async function syncEnvConfigNonAssetEntries(
  projectRoot: string,
  nonAssetEntries: EnvEntry[],
  assetFileNames: string[] = []
): Promise<void> {
  const assetKeys = collectAssetEnvKeys(assetFileNames);
  const existing = await readEnvFile(projectRoot, '.env.config');
  const assetEntries = existing.filter((entry) => assetKeys.has(entry.key));
  await writeEnvFile(projectRoot, '.env.config', [...assetEntries, ...nonAssetEntries]);
}
