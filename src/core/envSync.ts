import path from 'node:path';

import type { ConfigDTO, SecretDTO } from './dto.js';
import { deriveAssetEnvKey, resolveAssetEnvKey } from './pullAssets.js';
import {
  ENV_CONFIG_BASE,
  ENV_SECRETS_BASE,
  envConfigScopedFile,
  envFileExists,
  envSecretsScopedFile,
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
  appKey: string;
  useScoped: boolean;
  configWriteFile: string;
  secretsWriteFile: string;
  envConfig: EnvEntry[];
  envSecrets: EnvEntry[];
  baseConfig: EnvEntry[];
  scopedConfig: EnvEntry[];
  baseSecrets: EnvEntry[];
  scopedSecrets: EnvEntry[];
  envConfigPresent: boolean;
  envSecretsPresent: boolean;
  baseConfigPresent: boolean;
  scopedConfigPresent: boolean;
  baseSecretsPresent: boolean;
  scopedSecretsPresent: boolean;
}

export type CloudAssetEnvRef = {
  fileName?: string;
  copyText?: string;
  isArchived?: boolean;
};

type AssetKeyContext = {
  localKeys: Set<string>;
  excludedKeys: Set<string>;
  staleKeys: Set<string>;
  cloudByFile: Map<string, CloudAssetEnvRef>;
};

const activeCloudAssets = (cloudAssets?: CloudAssetEnvRef[]) =>
  (cloudAssets ?? []).filter(
    (a) => typeof a.fileName === 'string' && a.fileName !== '' && a.isArchived !== true
  );

function buildAssetKeyContext(
  localAssetFileNames: string[],
  cloudAssets?: CloudAssetEnvRef[]
): AssetKeyContext {
  const cloudByFile = new Map(activeCloudAssets(cloudAssets).map((a) => [a.fileName as string, a]));
  const localFiles = new Set(localAssetFileNames);
  const localKeys = new Set<string>(['assets']);
  const staleKeys = new Set<string>();

  for (const fileName of localAssetFileNames) {
    const cloudAsset = cloudByFile.get(fileName);
    localKeys.add(resolveAssetEnvKey({ fileName, copyText: cloudAsset?.copyText }));
    localKeys.add(deriveAssetEnvKey(fileName));
  }
  for (const [fileName, asset] of cloudByFile) {
    if (!localFiles.has(fileName)) {
      staleKeys.add(resolveAssetEnvKey({ fileName, copyText: asset.copyText }));
    }
  }

  return {
    localKeys,
    staleKeys,
    excludedKeys: new Set([...localKeys, ...staleKeys]),
    cloudByFile,
  };
}

function entriesEqual(a: EnvEntry[], b: EnvEntry[]): boolean {
  const mapB = new Map(b.map((e) => [e.key, e.value]));
  return a.length === mapB.size && a.every((e) => mapB.get(e.key) === e.value);
}

function configEntriesEqual(a?: ConfigDTO, b?: ConfigDTO): boolean {
  return entriesEqual(configDtoToEnvEntries(a), configDtoToEnvEntries(b));
}

function entriesFromRecord(
  record: Record<string, unknown> | undefined,
  skip?: (key: string) => boolean
): EnvEntry[] {
  if (!record) return [];
  return Object.entries(record)
    .filter(([key, value]) => !skip?.(key) && value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: String(value) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function dtoFromEntries(entries: EnvEntry[], excludeKeys?: Set<string>): ConfigDTO | undefined {
  const envVariables: Record<string, string> = {};
  for (const entry of entries) {
    if (!excludeKeys?.has(entry.key)) envVariables[entry.key] = entry.value;
  }
  return Object.keys(envVariables).length > 0 ? { envVariables } : undefined;
}

function omitAssetKeys(
  entries: EnvEntry[],
  assetFileNames: string[],
  cloudAssets?: CloudAssetEnvRef[]
): ConfigDTO | undefined {
  const excludeKeys = cloudAssets
    ? buildAssetKeyContext(assetFileNames, cloudAssets).excludedKeys
    : collectAssetEnvKeys(assetFileNames);
  return dtoFromEntries(entries, excludeKeys);
}

function assetFileNameFromEnvValue(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (!value) return undefined;
  const base = path.basename(value.split('?')[0] ?? value);
  return base.includes('.') ? base : undefined;
}

export function configDtoToEnvEntries(config: ConfigDTO | undefined): EnvEntry[] {
  return entriesFromRecord(config?.envVariables as Record<string, unknown> | undefined);
}

export function secretsDtoToEnvEntries(secrets: SecretDTO | undefined): EnvEntry[] {
  if (!secrets || typeof secrets !== 'object') return [];
  const nested =
    secrets.secrets && typeof secrets.secrets === 'object'
      ? (secrets.secrets as Record<string, unknown>)
      : (secrets as Record<string, unknown>);
  return entriesFromRecord(nested, (key) => key === 'secrets');
}

export function collectAssetEnvKeys(assetFileNames: string[] = []): Set<string> {
  return new Set(['assets', ...assetFileNames.map(deriveAssetEnvKey)]);
}

export function stripAssetKeysFromConfigDto(
  config: ConfigDTO | undefined,
  assetFileNames: string[] = [],
  cloudAssets?: CloudAssetEnvRef[]
): ConfigDTO | undefined {
  return omitAssetKeys(configDtoToEnvEntries(config), assetFileNames, cloudAssets);
}

export function buildConfigDtoFromEnvConfigFile(
  entries: EnvEntry[],
  assetFileNames: string[] = [],
  cloudAssets?: CloudAssetEnvRef[]
): ConfigDTO | undefined {
  return omitAssetKeys(entries, assetFileNames, cloudAssets);
}

export const buildConfigDtoFromEnvEntries = dtoFromEntries;

export function buildSecretsDtoFromEnvSecretsFile(entries: EnvEntry[]): SecretDTO | undefined {
  return entries.length > 0
    ? { secrets: Object.fromEntries(entries.map((e) => [e.key, e.value])) }
    : undefined;
}

function localNonAssetConfigEntries(
  localEnv: LocalEnvFiles,
  assetFileNames: string[],
  cloudAssets?: CloudAssetEnvRef[]
): EnvEntry[] {
  if (!localEnv.envConfigPresent) return [];
  return configDtoToEnvEntries(
    buildConfigDtoFromEnvConfigFile(localEnv.envConfig, assetFileNames, cloudAssets)
  );
}

function wouldClearConfigOnPush(
  localEnv: LocalEnvFiles,
  cloudConfig: ConfigDTO | undefined,
  assetFileNames: string[],
  cloudAssets?: CloudAssetEnvRef[]
): boolean {
  if (!localEnv.envConfigPresent) return false;
  const cloudNonAsset = configDtoToEnvEntries(
    stripAssetKeysFromConfigDto(cloudConfig, assetFileNames, cloudAssets)
  );
  return (
    cloudNonAsset.length > 0 &&
    localNonAssetConfigEntries(localEnv, assetFileNames, cloudAssets).length === 0
  );
}

function wouldClearSecretsOnPush(localEnv: LocalEnvFiles, cloudSecrets?: SecretDTO): boolean {
  if (!localEnv.envSecretsPresent) return false;
  return secretsDtoToEnvEntries(cloudSecrets).length > 0 && localEnv.envSecrets.length === 0;
}

export function pruneStaleAssetEnvEntries(
  entries: EnvEntry[],
  assetFileNames: string[],
  cloudAssets?: CloudAssetEnvRef[]
): EnvEntry[] {
  const { staleKeys } = buildAssetKeyContext(assetFileNames, cloudAssets);
  const localFiles = new Set(assetFileNames);
  return entries.filter((entry) => {
    if (entry.key === 'assets') return assetFileNames.length > 0;
    if (staleKeys.has(entry.key)) return false;
    const fileName = assetFileNameFromEnvValue(entry.value);
    return !(fileName && !localFiles.has(fileName) && entry.key === deriveAssetEnvKey(fileName));
  });
}

export function buildPushConfigDto(
  localEnv: LocalEnvFiles,
  cloudConfig: ConfigDTO | undefined,
  assetFileNames: string[] = [],
  cloudAssets?: CloudAssetEnvRef[]
): ConfigDTO {
  const ctx = buildAssetKeyContext(assetFileNames, cloudAssets);
  const localAsset: Record<string, string> = {};
  for (const entry of localEnv.envConfig) {
    if (ctx.localKeys.has(entry.key)) localAsset[entry.key] = entry.value;
  }

  const envVariables: Record<string, string> = {
    ...((dtoFromEntries(localEnv.envConfig, ctx.excludedKeys)?.envVariables ?? {}) as Record<
      string,
      string
    >),
  };

  if (assetFileNames.length === 0) return { envVariables };

  const cloudAssetVars = cloudConfig?.envVariables ?? {};
  const assetsBase =
    (typeof localAsset.assets === 'string' ? localAsset.assets.trim() : '') ||
    (typeof cloudAssetVars.assets === 'string' ? cloudAssetVars.assets.trim() : '');
  if (assetsBase) envVariables.assets = assetsBase;

  for (const fileName of assetFileNames) {
    const envKey = resolveAssetEnvKey({
      fileName,
      copyText: ctx.cloudByFile.get(fileName)?.copyText,
    });
    const value = localAsset[envKey] ?? localAsset[deriveAssetEnvKey(fileName)];
    if (typeof value === 'string') envVariables[envKey] = value;
  }

  return { envVariables };
}

export async function readProjectEnvFiles(
  projectRoot: string,
  appKey: string,
  defaultAppKey: string
): Promise<LocalEnvFiles> {
  const scopedConfigFile = envConfigScopedFile(appKey);
  const scopedSecretsFile = envSecretsScopedFile(appKey);
  const [baseConfigPresent, scopedConfigPresent, baseSecretsPresent, scopedSecretsPresent] =
    await Promise.all([
      envFileExists(projectRoot, ENV_CONFIG_BASE),
      envFileExists(projectRoot, scopedConfigFile),
      envFileExists(projectRoot, ENV_SECRETS_BASE),
      envFileExists(projectRoot, scopedSecretsFile),
    ]);
  const scopedPairPresent = scopedConfigPresent && scopedSecretsPresent;
  const useScoped = scopedPairPresent || appKey !== defaultAppKey;
  const configWriteFile = useScoped ? scopedConfigFile : ENV_CONFIG_BASE;
  const secretsWriteFile = useScoped ? scopedSecretsFile : ENV_SECRETS_BASE;

  const baseConfig = baseConfigPresent ? await readEnvFile(projectRoot, ENV_CONFIG_BASE) : [];
  const scopedConfig = scopedConfigPresent ? await readEnvFile(projectRoot, scopedConfigFile) : [];
  const baseSecrets = baseSecretsPresent ? await readEnvFile(projectRoot, ENV_SECRETS_BASE) : [];
  const scopedSecrets = scopedSecretsPresent
    ? await readEnvFile(projectRoot, scopedSecretsFile)
    : [];

  return {
    appKey,
    useScoped,
    configWriteFile,
    secretsWriteFile,
    baseConfig,
    scopedConfig,
    baseSecrets,
    scopedSecrets,
    envConfig: useScoped ? scopedConfig : baseConfig,
    envSecrets: useScoped ? scopedSecrets : baseSecrets,
    baseConfigPresent,
    scopedConfigPresent,
    baseSecretsPresent,
    scopedSecretsPresent,
    envConfigPresent: useScoped ? scopedConfigPresent : baseConfigPresent,
    envSecretsPresent: useScoped ? scopedSecretsPresent : baseSecretsPresent,
  };
}

export function mergeAssetFileNamesForEnvCompare(
  localAssetFileNames: string[] = [],
  cloudAssets: Array<{ fileName?: string; isArchived?: boolean }> | undefined = []
): string[] {
  const fromCloud = (cloudAssets ?? [])
    .filter((a) => a.isArchived !== true && typeof a.fileName === 'string' && a.fileName !== '')
    .map((a) => a.fileName as string);
  return [...new Set([...localAssetFileNames, ...fromCloud])];
}

export function envConfigEntriesMatchCloud(
  localEntries: EnvEntry[],
  cloudConfig: ConfigDTO | undefined,
  assetFileNames: string[] = [],
  cloudAssets?: CloudAssetEnvRef[]
): boolean {
  if (
    !configEntriesEqual(
      buildConfigDtoFromEnvConfigFile(localEntries, assetFileNames, cloudAssets),
      stripAssetKeysFromConfigDto(cloudConfig, assetFileNames, cloudAssets)
    )
  ) {
    return false;
  }

  const assetKeys = collectAssetEnvKeys(assetFileNames);
  const localMap = new Map(localEntries.map((entry) => [entry.key, entry.value]));
  const cloudAssetVars = cloudConfig?.envVariables ?? {};
  for (const key of assetKeys) {
    const cloudValue = cloudAssetVars[key];
    if (cloudValue !== undefined && localMap.get(key) !== String(cloudValue)) return false;
  }
  return true;
}

export function envSecretsEntriesMatchCloud(
  localEntries: EnvEntry[],
  cloudSecrets: SecretDTO | undefined
): boolean {
  return entriesEqual(localEntries, secretsDtoToEnvEntries(cloudSecrets));
}

export interface EnvPushDiff {
  configChanged: boolean;
  secretsChanged: boolean;
  wouldClearConfig: boolean;
  wouldClearSecrets: boolean;
  local: { config?: ConfigDTO; secrets?: SecretDTO };
  cloud: { config?: ConfigDTO; secrets?: SecretDTO };
}

export function buildEnvPushDiff(
  localEnv: LocalEnvFiles,
  cloudEnv: CloudEnvState,
  assetFileNames: string[] = [],
  cloudAssets?: CloudAssetEnvRef[]
): EnvPushDiff {
  const pushConfig = buildPushConfigDto(localEnv, cloudEnv.config, assetFileNames, cloudAssets);
  const wouldClearConfig = wouldClearConfigOnPush(
    localEnv,
    cloudEnv.config,
    assetFileNames,
    cloudAssets
  );
  const wouldClearSecrets = wouldClearSecretsOnPush(localEnv, cloudEnv.secrets);
  const configChanged =
    wouldClearConfig ||
    (localEnv.envConfigPresent && !configEntriesEqual(pushConfig, cloudEnv.config));
  const secretsChanged =
    wouldClearSecrets ||
    (localEnv.envSecretsPresent &&
      !entriesEqual(localEnv.envSecrets, secretsDtoToEnvEntries(cloudEnv.secrets)));
  const pushSecrets: SecretDTO = {
    secrets: Object.fromEntries(localEnv.envSecrets.map((e) => [e.key, e.value])),
  };

  return {
    configChanged,
    secretsChanged,
    wouldClearConfig,
    wouldClearSecrets,
    local: {
      ...(configChanged && { config: pushConfig }),
      ...(secretsChanged && { secrets: pushSecrets }),
    },
    cloud: {
      ...(configChanged && cloudEnv.config && { config: cloudEnv.config }),
      ...(secretsChanged && cloudEnv.secrets && { secrets: cloudEnv.secrets }),
    },
  };
}

export interface EnvPullChanges {
  assetFileNames: string[];
  configMatch: boolean;
  secretsMatch: boolean;
  match: boolean;
  filesToUpdate: string[];
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
    assetFileNames,
    cloudAssets
  );
  const secretsMatch = envSecretsEntriesMatchCloud(localEnv?.envSecrets ?? [], cloudSecrets);
  const filesToUpdate: string[] = [];
  if (!configMatch) filesToUpdate.push(localEnv?.configWriteFile ?? ENV_CONFIG_BASE);
  if (!secretsMatch) filesToUpdate.push(localEnv?.secretsWriteFile ?? ENV_SECRETS_BASE);
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
  pushConfigDto?: ConfigDTO;
  pushSecretsDto?: SecretDTO;
  pendingLocalEnvConfigWrite?: EnvEntry[];
}

export async function prepareEnvPushState(params: {
  projectRoot: string;
  appKey: string;
  defaultAppKey: string;
  cloudEnv: CloudEnvState;
  assetFileNames: string[];
  cloudAssets?: CloudAssetEnvRef[];
}): Promise<EnvPushState> {
  const localEnvRaw = await readProjectEnvFiles(
    params.projectRoot,
    params.appKey,
    params.defaultAppKey
  );
  const prunedConfigSource = localEnvRaw.envConfigPresent
    ? pruneStaleAssetEnvEntries(localEnvRaw.envConfig, params.assetFileNames, params.cloudAssets)
    : localEnvRaw.envConfig;
  const localEnv: LocalEnvFiles = {
    ...localEnvRaw,
    envConfig: prunedConfigSource,
    ...(localEnvRaw.useScoped
      ? { scopedConfig: prunedConfigSource }
      : { baseConfig: prunedConfigSource }),
  };
  const diff = buildEnvPushDiff(
    localEnv,
    params.cloudEnv,
    params.assetFileNames,
    params.cloudAssets
  );

  return {
    localEnv,
    diff,
    pushConfigDto: diff.local.config,
    pushSecretsDto: diff.local.secrets,
    ...(localEnvRaw.envConfigPresent &&
      !entriesEqual(prunedConfigSource, localEnvRaw.envConfig) && {
        pendingLocalEnvConfigWrite: prunedConfigSource,
      }),
  };
}

export async function applyReleaseEnvToFs(
  projectRoot: string,
  config: ConfigDTO | undefined,
  secrets: SecretDTO | undefined,
  appKey: string,
  defaultAppKey: string
): Promise<void> {
  const layout = await readProjectEnvFiles(projectRoot, appKey, defaultAppKey);
  const configEntries = configDtoToEnvEntries(config);
  if (configEntries.length > 0) {
    await upsertEnvFile(projectRoot, layout.configWriteFile, configEntries);
  }
  const secretEntries = secretsDtoToEnvEntries(secrets);
  if (secretEntries.length > 0) {
    await upsertEnvFile(projectRoot, layout.secretsWriteFile, secretEntries);
  }
}

export async function applyCloudEnvToFs(
  projectRoot: string,
  cloudEnv: CloudEnvState,
  assetFileNames: string[] = [],
  appKey = 'default',
  defaultAppKey = appKey
): Promise<void> {
  const layout = await readProjectEnvFiles(projectRoot, appKey, defaultAppKey);
  const configWriteFile = layout.configWriteFile;
  const secretsWriteFile = layout.secretsWriteFile;

  const assetKeys = collectAssetEnvKeys(assetFileNames);
  const cloudVars = cloudEnv.config?.envVariables ?? {};
  const assetEntries = [...assetKeys]
    .map((key) => ({ key, value: cloudVars[key] }))
    .filter((entry): entry is EnvEntry => typeof entry.value === 'string');
  if (assetEntries.length > 0) {
    await upsertEnvFile(projectRoot, configWriteFile, assetEntries);
  }

  const existing = await readEnvFile(projectRoot, configWriteFile);
  const keptAssetEntries = existing.filter((entry) => assetKeys.has(entry.key));
  const nonAssetEntries = configDtoToEnvEntries(
    stripAssetKeysFromConfigDto(cloudEnv.config, assetFileNames)
  );
  await writeEnvFile(projectRoot, configWriteFile, [...keptAssetEntries, ...nonAssetEntries]);
  await writeEnvFile(projectRoot, secretsWriteFile, secretsDtoToEnvEntries(cloudEnv.secrets));
}
