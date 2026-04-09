import fs from 'fs/promises';
import path from 'path';

import type { AssetDTO } from './dto.js';
import type { upsertEnvConfig } from './envConfig.js';

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

export interface PullAssetFailure {
  fileName: string;
  url?: string;
  message: string;
}

export interface PullAssetEnvConfigResult {
  entries: Array<Parameters<typeof upsertEnvConfig>[1][number]>;
  failures: PullAssetFailure[];
}

function extractEnvKeyFromCopyText(copyText: string | undefined): string | undefined {
  if (!copyText || typeof copyText !== 'string') return undefined;
  const keys: string[] = [];
  const re = /\$\{env\.([A-Za-z0-9_]+)\}/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(copyText)) !== null) {
    const k = m[1];
    if (k) keys.push(k);
  }
  const unique = [...new Set(keys)];
  const nonAssets = unique.filter((k) => k !== 'assets');
  // Prefer the single non-assets key if present; otherwise fall back to first key (if any).
  return nonAssets.length === 1 ? nonAssets[0] : (nonAssets[0] ?? unique[0]);
}

function deriveEnvKeyFromFileName(fileName: string): string {
  // Match the common behavior used in tests/mocks: replace non-word characters with underscores.
  return fileName.replace(/[^\w]+/g, '_');
}

function tryDeriveAssetBaseAndValue(
  publicUrl: string,
  fileName: string
): { baseUrl: string; valuePart: string } | undefined {
  try {
    const u = new URL(publicUrl);
    // Firebase Storage public URLs look like: .../o/<urlencoded object path>?alt=media&token=...
    const marker = '/o/';
    const idx = u.pathname.indexOf(marker);
    if (idx !== -1) {
      const encodedObjectPath = u.pathname.slice(idx + marker.length);
      const decoded = decodeURIComponent(encodedObjectPath);
      const slash = decoded.lastIndexOf('/');
      if (slash !== -1) {
        const baseObjectPath = decoded.slice(0, slash + 1);
        const baseUrl = `${u.origin}${u.pathname.slice(0, idx + marker.length)}${encodeURIComponent(
          baseObjectPath
        )}`;
        const valuePart = `${encodeURIComponent(fileName)}${u.search}`;
        return { baseUrl, valuePart };
      }
    }

    // Generic HTTP URL: treat base as directory, value as fileName + query
    const lastSlash = publicUrl.lastIndexOf('/');
    if (lastSlash !== -1) {
      const baseUrl = publicUrl.slice(0, lastSlash + 1);
      const valuePart = `${fileName}${u.search}`;
      return { baseUrl, valuePart };
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function buildEnvConfigForCloudAssets(
  cloudAssets: AssetDTO[] | undefined
): PullAssetEnvConfigResult {
  const active = (cloudAssets ?? []).filter((a) => a.isArchived !== true);
  const failures: PullAssetFailure[] = [];

  // Choose a stable base URL by taking the most common derived base among assets with publicUrl.
  const baseCounts = new Map<string, number>();
  const derivedByFile = new Map<
    string,
    { baseUrl: string; valuePart: string; envKey: string; fileName: string }
  >();

  for (const a of active) {
    const fileName = (() => {
      try {
        return sanitizeAssetFileName(a.fileName);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failures.push({ fileName: a.fileName, url: a.publicUrl, message });
        return undefined;
      }
    })();
    if (!fileName) continue;

    const url = a.publicUrl;
    if (!url || typeof url !== 'string') continue;

    const derived = tryDeriveAssetBaseAndValue(url, fileName);
    if (!derived) continue;

    const envKey = extractEnvKeyFromCopyText(a.copyText) ?? deriveEnvKeyFromFileName(fileName);
    derivedByFile.set(fileName, { ...derived, envKey, fileName });
    baseCounts.set(derived.baseUrl, (baseCounts.get(derived.baseUrl) ?? 0) + 1);
  }

  const preferredBase = [...baseCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? undefined;

  const entries: Array<Parameters<typeof upsertEnvConfig>[1][number]> = [];
  if (preferredBase) {
    entries.push({ key: 'assets', value: preferredBase });
  }

  // Add per-asset key=value, preferring the selected base if possible.
  const sorted = [...derivedByFile.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));
  for (const item of sorted) {
    const value =
      preferredBase && item.baseUrl === preferredBase
        ? item.valuePart
        : // If base doesn't match, fall back to full URL so the key still works.
          (active.find((a) => a.fileName === item.fileName)?.publicUrl ?? item.valuePart);
    entries.push({ key: item.envKey, value });
  }

  return { entries, failures };
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
}): Promise<{
  created: number;
  deleted: number;
  skipped: number;
  changes: PullAssetChange[];
  failures: PullAssetFailure[];
}> {
  const { projectRoot, cloudAssets } = params;
  const assetsDir = path.join(projectRoot, 'assets');
  await ensureDir(assetsDir);

  const cloudActive = (cloudAssets ?? []).filter((a) => a.isArchived !== true);
  const expectedFiles = new Set<string>();
  const byFile = new Map<string, AssetDTO>();
  const failures: PullAssetFailure[] = [];
  for (const a of cloudActive) {
    try {
      const file = sanitizeAssetFileName(a.fileName);
      expectedFiles.add(file);
      byFile.set(file, a);
    } catch (e) {
      // Bad filenames should not abort the pull; treat as a skipped asset with a warning.
      const message = e instanceof Error ? e.message : String(e);
      failures.push({ fileName: a.fileName, url: a.publicUrl, message });
    }
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
      failures.push({
        fileName,
        url: typeof url === 'string' ? url : undefined,
        message: `Missing publicUrl for asset "${fileName}".`,
      });
      continue;
    }
    const filePath = path.join(assetsDir, fileName);
    try {
      await downloadToFile(url, filePath);
      changes.push({ kind: 'asset', operation: 'create', file: `assets/${fileName}` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push({ fileName, url, message });
      // Best-effort: continue syncing remaining assets.
      continue;
    }
  }

  for (const fileName of toDelete) {
    const filePath = path.join(assetsDir, fileName);
    await fs.rm(filePath, { force: true });
    changes.push({ kind: 'asset', operation: 'delete', file: `assets/${fileName}` });
  }

  const created = changes.filter((c) => c.operation === 'create').length;
  const deleted = changes.filter((c) => c.operation === 'delete').length;
  const skipped = toDownload.length - created;
  return { created, deleted, skipped, changes, failures };
}
