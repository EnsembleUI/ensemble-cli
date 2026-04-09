import fs from 'fs/promises';
import path from 'path';

import type { AssetDTO } from './dto.js';

export class AssetPullError extends Error {
  constructor(
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = 'AssetPullError';
  }
}

function sanitizeAssetFileName(fileName: string): string {
  // Prevent path traversal; assets are stored as basenames under assets/
  const base = path.basename(fileName);
  if (base !== fileName) {
    throw new AssetPullError(`Invalid asset fileName "${fileName}".`);
  }
  if (base.trim() === '') {
    throw new AssetPullError('Invalid asset fileName (empty).');
  }
  return base;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new AssetPullError(`Failed to download asset (${res.status}) from ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filePath, buf);
}

export interface PullAssetChange {
  kind: 'asset';
  operation: 'create' | 'delete';
  file: string;
}

/**
 * Sync local `assets/` directory to match active cloud assets.
 * - Downloads assets that are present in cloud but missing locally.
 * - Deletes local files that are not present in cloud.
 *
 * Note: We intentionally do not attempt to detect "modified" assets because the cloud payload
 * does not include a stable content hash/etag in this CLI, and public URLs may be versioned.
 */
export async function applyCloudAssetsToFs(params: {
  projectRoot: string;
  cloudAssets: AssetDTO[] | undefined;
}): Promise<{ created: number; deleted: number; skipped: number; changes: PullAssetChange[] }> {
  const { projectRoot, cloudAssets } = params;
  const assetsDir = path.join(projectRoot, 'assets');
  await ensureDir(assetsDir);

  const cloudActive = (cloudAssets ?? []).filter((a) => a.isArchived !== true);
  const expectedFiles = new Set<string>();
  const byFile = new Map<string, AssetDTO>();
  for (const a of cloudActive) {
    const file = sanitizeAssetFileName(a.fileName);
    expectedFiles.add(file);
    byFile.set(file, a);
  }

  let localFiles: string[] = [];
  try {
    const entries = await fs.readdir(assetsDir, { withFileTypes: true });
    localFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    localFiles = [];
  }
  const actualFiles = new Set(localFiles);

  const toDownload = [...expectedFiles].filter((f) => !actualFiles.has(f)).sort();
  const toDelete = [...actualFiles].filter((f) => !expectedFiles.has(f)).sort();

  const changes: PullAssetChange[] = [];

  for (const fileName of toDownload) {
    const asset = byFile.get(fileName);
    const url = asset?.publicUrl;
    if (!url || typeof url !== 'string') {
      // If we can't download, we still leave local state untouched and count as skipped.
      continue;
    }
    const filePath = path.join(assetsDir, fileName);
    await downloadToFile(url, filePath);
    changes.push({ kind: 'asset', operation: 'create', file: `assets/${fileName}` });
  }

  for (const fileName of toDelete) {
    const filePath = path.join(assetsDir, fileName);
    await fs.rm(filePath, { force: true });
    changes.push({ kind: 'asset', operation: 'delete', file: `assets/${fileName}` });
  }

  const created = changes.filter((c) => c.operation === 'create').length;
  const deleted = changes.filter((c) => c.operation === 'delete').length;
  const skipped = toDownload.length - created;
  return { created, deleted, skipped, changes };
}
