import path from 'node:path';

import type { ConfigDTO } from './dto.js';
import type { EnvEntry } from './envConfig.js';
import { deriveAssetEnvKey } from './assetEnv.js';
import { resolveAssetEnvKey } from './pullAssets.js';

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

const activeCloudAssetRefs = (cloudAssets?: CloudAssetEnvRef[]) =>
  (cloudAssets ?? []).filter(
    (a) => typeof a.fileName === 'string' && a.fileName !== '' && a.isArchived !== true
  );

export function assetFileNameFromEnvValue(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (!value) return undefined;
  const base = path.basename(value.split('?')[0] ?? value);
  return base.includes('.') ? base : undefined;
}

function inferAssetFileNamesFromEntries(entries: EnvEntry[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.key === 'assets') continue;
    const fileName = assetFileNameFromEnvValue(entry.value);
    if (fileName) names.add(fileName);
  }
  return [...names];
}

export function collectAssetEnvKeys(assetFileNames: string[] = []): Set<string> {
  return new Set(['assets', ...assetFileNames.map(deriveAssetEnvKey)]);
}

export function buildAssetKeyContext(
  localAssetFileNames: string[],
  cloudAssets?: CloudAssetEnvRef[]
): AssetKeyContext {
  const cloudByFile = new Map(
    activeCloudAssetRefs(cloudAssets).map((a) => [a.fileName as string, a])
  );
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

/** keys to strip from env compare/push when assets sync is off or for non-asset slices */
export function getAssetEnvKeysToExclude(
  entries: EnvEntry[],
  assetFileNames: string[],
  cloudAssets?: CloudAssetEnvRef[]
): Set<string> {
  const excludeKeys = new Set(
    cloudAssets
      ? buildAssetKeyContext(assetFileNames, cloudAssets).excludedKeys
      : collectAssetEnvKeys(assetFileNames)
  );
  for (const entry of entries) {
    if (entry.key === 'assets') {
      excludeKeys.add('assets');
      continue;
    }
    const fileName = assetFileNameFromEnvValue(entry.value);
    if (fileName && entry.key === deriveAssetEnvKey(fileName)) {
      excludeKeys.add(entry.key);
    }
  }
  return excludeKeys;
}

export function mergeAssetFileNamesForEnvCompare(
  localAssetFileNames: string[] = [],
  cloudAssets?: CloudAssetEnvRef[]
): string[] {
  const fromCloud = activeCloudAssetRefs(cloudAssets).map((a) => a.fileName as string);
  return [...new Set([...localAssetFileNames, ...fromCloud])];
}

export interface DisabledEnvSyncPlan {
  localAssetFileNames: string[];
  pushConfig: ConfigDTO;
  compareLocal: ConfigDTO;
  compareCloud: ConfigDTO | undefined;
}

/** single plan for assets:false compare + push */
export function planDisabledEnvSync(
  localEntries: EnvEntry[],
  cloudConfig: ConfigDTO | undefined,
  cloudAssets?: CloudAssetEnvRef[]
): DisabledEnvSyncPlan {
  const cloudEntries = entriesFromConfigDto(cloudConfig);
  const { local, cloud } = assetFileNamesForDisabledEnvSync(
    localEntries,
    cloudEntries,
    cloudAssets
  );
  return {
    localAssetFileNames: local,
    pushConfig: buildPushConfigWhenAssetsDisabled(
      localEntries,
      cloudEntries,
      cloudConfig,
      local,
      cloud,
      cloudAssets
    ),
    compareLocal: buildNonAssetConfigFromEntries(localEntries, local, cloudAssets),
    compareCloud: stripAssetKeysFromEntries(cloudEntries, cloud, cloudAssets),
  };
}

export function assetFileNamesForDisabledEnvSync(
  localEntries: EnvEntry[],
  cloudEntries: EnvEntry[],
  cloudAssets?: CloudAssetEnvRef[]
): { local: string[]; cloud: string[] } {
  const fromRefs = activeCloudAssetRefs(cloudAssets).map((a) => a.fileName as string);
  return {
    local: [...new Set(inferAssetFileNamesFromEntries(localEntries))],
    cloud: [...new Set([...fromRefs, ...inferAssetFileNamesFromEntries(cloudEntries)])],
  };
}

export function buildNonAssetConfigFromEntries(
  entries: EnvEntry[],
  assetFileNames: string[],
  cloudAssets?: CloudAssetEnvRef[]
): ConfigDTO {
  return entriesToConfigDto(
    entries,
    getAssetEnvKeysToExclude(entries, assetFileNames, cloudAssets)
  );
}

export function stripAssetKeysFromEntries(
  entries: EnvEntry[],
  assetFileNames: string[],
  cloudAssets?: CloudAssetEnvRef[]
): ConfigDTO | undefined {
  const config = entriesToConfigDto(
    entries,
    getAssetEnvKeysToExclude(entries, assetFileNames, cloudAssets)
  );
  return Object.keys(config.envVariables ?? {}).length > 0 ? config : undefined;
}

/** local non-asset vars + preserve cloud asset env keys (assets: false push) */
export function buildPushConfigWhenAssetsDisabled(
  localEntries: EnvEntry[],
  cloudEntries: EnvEntry[],
  cloudConfig: ConfigDTO | undefined,
  localFileNames: string[],
  cloudFileNames: string[],
  cloudAssets?: CloudAssetEnvRef[]
): ConfigDTO {
  const localExclude = getAssetEnvKeysToExclude(localEntries, localFileNames, cloudAssets);
  const cloudExclude = getAssetEnvKeysToExclude(cloudEntries, cloudFileNames, cloudAssets);
  const mergedByKey = new Map<string, string>();

  for (const entry of cloudEntries) {
    if (cloudExclude.has(entry.key)) mergedByKey.set(entry.key, entry.value);
  }
  for (const entry of localEntries) {
    if (!localExclude.has(entry.key)) mergedByKey.set(entry.key, entry.value);
  }

  return {
    envVariables: Object.fromEntries(mergedByKey),
    ...(cloudConfig?.baseUrl !== undefined && { baseUrl: cloudConfig.baseUrl }),
    ...(cloudConfig?.useBrowserUrl !== undefined && { useBrowserUrl: cloudConfig.useBrowserUrl }),
  };
}

function entriesToConfigDto(entries: EnvEntry[], excludeKeys: Set<string>): ConfigDTO {
  const envVariables: Record<string, string> = {};
  for (const entry of entries) {
    if (!excludeKeys.has(entry.key)) envVariables[entry.key] = entry.value;
  }
  return { envVariables };
}

function entriesFromConfigDto(config: ConfigDTO | undefined): EnvEntry[] {
  const record = config?.envVariables as Record<string, unknown> | undefined;
  if (!record) return [];
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: String(value) }));
}
