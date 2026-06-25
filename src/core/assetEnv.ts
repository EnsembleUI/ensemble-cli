import { toWords } from 'number-to-words';

import type { EnvEntry } from './envConfig.js';

/** mirrors studio_service/studio/src/addAssetsArtifact.ts convertNumbersInFilename */
export function convertNumbersInFilename(filename: string): string {
  // First, replace any non-alphanumeric characters with underscores
  let envFileName = filename.replace(/[^A-Za-z0-9_]/g, '_');
  // Convert all numbers to words without spaces or commas
  envFileName = envFileName.replace(/^\d+/, (match) =>
    toWords(parseInt(match, 10))
      .replace(/[,-\s]/g, '')
      .toLowerCase()
  );
  return envFileName;
}

export function buildLocalAssetUsageKey(fileName: string): string {
  return `\${env.assets}\${env.${convertNumbersInFilename(fileName)}}`;
}

export function buildLocalAssetEnvEntries(fileName: string, existingBaseUrl?: string): EnvEntry[] {
  const entries: EnvEntry[] = [{ key: convertNumbersInFilename(fileName), value: fileName }];
  if (existingBaseUrl) {
    return [{ key: 'assets', value: existingBaseUrl, overwrite: false }, ...entries];
  }
  return entries;
}
