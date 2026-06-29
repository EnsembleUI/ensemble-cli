import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';

import {
  ENSEMBLE_REPO,
  fetchLatestStableEnsembleReleaseRef,
  getModulesCacheRoot,
  readCachedEnsembleReleaseRef,
} from './ensembleRelease.js';
import { fileExists } from './fs.js';

export { ENSEMBLE_REPO as ENSEMBLE_MODULES_REPO } from './ensembleRelease.js';

const STARTER_PATHS = ['starter/src/', 'starter/scripts/'];
const FETCH_TIMEOUT_MS = 15_000;
const REGISTRY_REL = path.join('src', 'modules_scripts.ts');

function getModulesReleaseCacheDir(ref: string): string {
  return path.join(getModulesCacheRoot(), ref);
}

function getModulesToolingDownloadUrl(ref: string): string {
  return `https://codeload.github.com/${ENSEMBLE_REPO}/tar.gz/${encodeURIComponent(ref)}`;
}

export interface ModulesToolingResult {
  cacheDir: string;
  ref: string;
  usedCacheFallback: boolean;
}

function toolingResult(ref: string, usedCacheFallback: boolean): ModulesToolingResult {
  return { cacheDir: getModulesReleaseCacheDir(ref), ref, usedCacheFallback };
}

function unavailableError(detail: string): Error {
  return new Error(
    `Could not fetch module tooling and no cached version was found.\n\nPlease connect to the internet and retry:\n  ensemble enable\n\n${detail}`
  );
}

async function hasRegistry(ref: string): Promise<boolean> {
  return fileExists(path.join(getModulesReleaseCacheDir(ref), REGISTRY_REL));
}

async function cachedOrThrow(
  cachedRef: string | null,
  err: unknown
): Promise<ModulesToolingResult> {
  if (cachedRef && (await hasRegistry(cachedRef))) return toolingResult(cachedRef, true);
  throw unavailableError(err instanceof Error ? err.message : String(err));
}

async function downloadRelease(ref: string): Promise<void> {
  const root = getModulesCacheRoot();
  const dest = getModulesReleaseCacheDir(ref);
  const tarball = path.join(root, '.download.tar');

  try {
    await fs.mkdir(root, { recursive: true });
    const response = await fetch(getModulesToolingDownloadUrl(ref), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} while downloading module tooling`);
    if (!response.body) throw new Error('Empty response while downloading module tooling');

    await pipeline(
      Readable.fromWeb(response.body as import('stream/web').ReadableStream),
      createGunzip(),
      createWriteStream(tarball)
    );

    const tmp = path.join(dest, '.extract-tmp');
    await fs.mkdir(dest, { recursive: true });
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(tmp, { recursive: true });

    await tar.extract({
      file: tarball,
      cwd: tmp,
      strip: 1,
      filter: (entryPath) => {
        const relative = entryPath.replace(/\\/g, '/').split('/').slice(1).join('/');
        return STARTER_PATHS.some(
          (prefix) => relative === prefix.replace(/\/$/, '') || relative.startsWith(prefix)
        );
      },
    });

    const starter = path.join(tmp, 'starter');
    if (!(await fileExists(starter)))
      throw new Error('Downloaded archive did not contain starter/');

    for (const entry of await fs.readdir(starter)) {
      const target = path.join(dest, entry);
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(path.join(starter, entry), target);
    }
    await fs.rm(tmp, { recursive: true, force: true });

    if (!(await hasRegistry(ref))) {
      throw new Error('Downloaded module tooling is missing src/modules_scripts.ts');
    }
  } finally {
    await fs.rm(tarball, { force: true });
  }
}

export async function ensureModulesTooling(): Promise<ModulesToolingResult> {
  const cachedRef = await readCachedEnsembleReleaseRef();

  let latestRef: string;
  try {
    latestRef = await fetchLatestStableEnsembleReleaseRef();
  } catch (err) {
    return cachedOrThrow(cachedRef, err);
  }

  if (cachedRef === latestRef && (await hasRegistry(latestRef))) {
    return toolingResult(latestRef, false);
  }

  try {
    await downloadRelease(latestRef);
    await fs.writeFile(path.join(getModulesCacheRoot(), '.ref'), `${latestRef}\n`, 'utf8');
    if (cachedRef && cachedRef !== latestRef) {
      await fs.rm(getModulesReleaseCacheDir(cachedRef), { recursive: true, force: true });
    }
    return toolingResult(latestRef, false);
  } catch (err) {
    return cachedOrThrow(cachedRef, err);
  }
}
