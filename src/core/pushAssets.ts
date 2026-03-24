import fs from 'fs/promises';
import path from 'path';

import { uploadAssetToStudio } from '../cloud/assetClient.js';
import { upsertEnvConfig } from './envConfig.js';

/**
 * Upload local asset files via studio-uploadAsset and merge results into .env.config.
 * Used by {@link submitCliPush} so push stays one orchestration entry point.
 */
export async function uploadProjectAssetsForPush(
  appId: string,
  idToken: string,
  projectRoot: string,
  fileNames: string[]
): Promise<number> {
  if (fileNames.length === 0) return 0;

  const envEntries: Array<{ key: string; value: string; overwrite?: boolean }> = [];
  let hasAssetsKey = false;

  for (const fileName of fileNames) {
    const fullPath = path.join(projectRoot, 'assets', fileName);
    const content = await fs.readFile(fullPath);
    const base64 = content.toString('base64');
    const uploaded = await uploadAssetToStudio(appId, fileName, base64, idToken);
    if (!hasAssetsKey) {
      envEntries.push({ key: 'assets', value: uploaded.assetBaseUrl, overwrite: false });
      hasAssetsKey = true;
    }
    envEntries.push({
      key: uploaded.envVariable.key,
      value: uploaded.envVariable.value,
    });
  }

  await upsertEnvConfig(projectRoot, envEntries);
  return fileNames.length;
}
