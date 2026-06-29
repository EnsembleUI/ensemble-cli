import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export const ENSEMBLE_REPO = 'EnsembleUI/ensemble';

const FETCH_TIMEOUT_MS = 15_000;

export function getModulesCacheRoot(): string {
  return path.join(os.homedir(), '.ensemble', 'cache', 'modules_dir');
}

export function getStableReleaseTag(release: {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
}): string | null {
  if (release.prerelease || release.draft) return null;
  const tag = release.tag_name.trim();
  return tag || null;
}

export async function readCachedEnsembleReleaseRef(): Promise<string | null> {
  try {
    const ref = (await fs.readFile(path.join(getModulesCacheRoot(), '.ref'), 'utf8')).trim();
    return ref || null;
  } catch {
    return null;
  }
}

export async function fetchLatestStableEnsembleReleaseRef(): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${ENSEMBLE_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching latest ensemble release`);
  }
  const tag = getStableReleaseTag(
    (await response.json()) as Parameters<typeof getStableReleaseTag>[0]
  );
  if (!tag) throw new Error('Latest GitHub release is not a stable release');
  return tag;
}
