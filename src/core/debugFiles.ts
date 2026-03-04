import fs from 'fs/promises';
import path from 'path';

interface WriteVerboseJsonOptions {
  verbose: boolean;
  truncateLargeContent?: boolean;
  contentKey?: string;
  /** Maximum length for large content fields before truncation. */
  contentLimit?: number;
}

export async function writeVerboseJson(
  rootDir: string,
  fileName: string,
  payload: unknown,
  options: WriteVerboseJsonOptions,
): Promise<void> {
  const { verbose, truncateLargeContent = true, contentKey = 'content', contentLimit = 2000 } =
    options;

  if (!verbose) return;

  const filePath = path.join(rootDir, fileName);

  const replacer = (key: string, value: unknown) => {
    if (
      truncateLargeContent &&
      key === contentKey &&
      typeof value === 'string' &&
      value.length > contentLimit
    ) {
      return `${value.slice(0, contentLimit)}\n/* ... truncated ... */`;
    }
    return value;
  };

  await fs.writeFile(filePath, JSON.stringify(payload, replacer, 2), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Wrote ${filePath}`);
}

