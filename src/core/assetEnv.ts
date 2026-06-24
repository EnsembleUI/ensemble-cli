import type { EnvEntry } from './envConfig.js';

export function deriveAssetEnvKey(fileName: string): string {
  return fileName.replace(/[^\w]+/g, '_');
}

export function buildLocalAssetUsageKey(fileName: string): string {
  return `\${env.assets}\${env.${deriveAssetEnvKey(fileName)}}`;
}

export function buildLocalAssetEnvEntries(fileName: string, existingBaseUrl?: string): EnvEntry[] {
  const entries: EnvEntry[] = [{ key: deriveAssetEnvKey(fileName), value: fileName }];
  if (existingBaseUrl) {
    return [{ key: 'assets', value: existingBaseUrl, overwrite: false }, ...entries];
  }
  return entries;
}
