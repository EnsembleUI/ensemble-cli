/**
 * Asset filenames that should never be treated as real app assets.
 * These are commonly created by OS tooling and can accidentally appear in `assets/`.
 */
export function isIgnoredAssetFileName(fileName: string): boolean {
  const name = fileName.trim();
  if (name === '') return true;

  // macOS Finder metadata
  if (name === '.DS_Store') return true;

  // AppleDouble sidecar files (e.g. when copying to non-HFS filesystems)
  if (name.startsWith('._')) return true;

  // Windows metadata
  if (name === 'Thumbs.db') return true;
  if (name === 'desktop.ini') return true;

  return false;
}
