/**
 * Collects app files from the filesystem into a structured representation.
 * Kept in core so buildDocuments can depend on it without importing from commands.
 */

import fs from 'fs/promises';
import path from 'path';

import type { ArtifactProp } from './dto.js';

export interface ParsedAppFiles {
  screens: Record<string, string>;
  scripts: Record<string, string>;
  widgets: Record<string, string>;
  translations: Record<string, string>;
  theme?: string;
}

export type CollectOptions = Partial<Record<ArtifactProp, boolean>>;

function shouldInclude(prop: ArtifactProp, options: CollectOptions): boolean {
  const v = options[prop];
  return v !== false;
}

async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

export async function collectAppFiles(
  rootDir: string,
  collectOptions: CollectOptions = {},
): Promise<ParsedAppFiles> {
  const include = (prop: ArtifactProp) => shouldInclude(prop, collectOptions);

  const result: ParsedAppFiles = {
    screens: {},
    scripts: {},
    widgets: {},
    translations: {},
  };

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, fullPath);

      if (entry.isDirectory()) {
        if (['.git', '.hg', '.svn', 'node_modules'].includes(entry.name)) {
          continue;
        }
        if (entry.name === 'screens' && !include('screens')) continue;
        if (entry.name === 'widgets' && !include('widgets')) continue;
        if (entry.name === 'scripts' && !include('scripts')) continue;
        if (entry.name === 'translations' && !include('translations')) continue;
        if (['config', 'assets', 'fonts'].includes(entry.name)) continue;
        await walk(fullPath);
        continue;
      }

      if (entry.name === 'ensemble.config.json') {
        continue;
      }

      const [top, ...restParts] = relPath.split(path.sep);
      const relativeWithinTop = restParts.join(path.sep) || entry.name;

      if (top === 'screens') {
        result.screens[relativeWithinTop] = await readTextFile(fullPath);
        continue;
      }

      if (top === 'scripts') {
        result.scripts[relativeWithinTop] = await readTextFile(fullPath);
        continue;
      }

      if (top === 'widgets') {
        result.widgets[relativeWithinTop] = await readTextFile(fullPath);
        continue;
      }

      if (top === 'translations') {
        result.translations[relativeWithinTop] = await readTextFile(fullPath);
        continue;
      }

      if (entry.name === 'theme.yaml' || entry.name === 'theme.yml') {
        if (!include('theme')) continue;
        result.theme = await readTextFile(fullPath);
        continue;
      }
    }
  }

  await walk(rootDir);
  return result;
}
