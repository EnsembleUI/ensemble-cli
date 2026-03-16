export function safeFileName(name: string, ext: string): string {
  // Keep user-provided names as-is as much as possible, but guard against path separators.
  const base = name.replace(/[\\/]/g, '_');
  return `${base}${ext}`;
}
