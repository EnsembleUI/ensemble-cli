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

async function processWithConcurrency<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency = 16,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;
  const runners: Promise<void>[] = [];

  for (let i = 0; i < limit; i += 1) {
    runners.push(
      (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const currentIndex = index;
          if (currentIndex >= items.length) break;
          index = currentIndex + 1;
          // eslint-disable-next-line no-await-in-loop
          await worker(items[currentIndex]!);
        }
      })(),
    );
  }

  await Promise.all(runners);
}

async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

export async function collectAppFiles(
  rootDir: string,
  collectOptions: CollectOptions = {},
): Promise<ParsedAppFiles> {
  const include = (prop: ArtifactProp) => shouldInclude(prop, collectOptions);

  type FileTask =
    | {
        kind: 'screens' | 'scripts' | 'widgets' | 'translations';
        key: string;
        fullPath: string;
      }
    | {
        kind: 'theme';
        fullPath: string;
      };

  const result: ParsedAppFiles = {
    screens: {},
    scripts: {},
    widgets: {},
    translations: {},
    theme: undefined,
  };

  const tasks: FileTask[] = [];

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
        tasks.push({ kind: 'screens', key: relativeWithinTop, fullPath });
        continue;
      }

      if (top === 'scripts') {
        tasks.push({ kind: 'scripts', key: relativeWithinTop, fullPath });
        continue;
      }

      if (top === 'widgets') {
        tasks.push({ kind: 'widgets', key: relativeWithinTop, fullPath });
        continue;
      }

      if (top === 'translations') {
        tasks.push({ kind: 'translations', key: relativeWithinTop, fullPath });
        continue;
      }

      if (entry.name === 'theme.yaml' || entry.name === 'theme.yml') {
        if (!include('theme')) continue;
        tasks.push({ kind: 'theme', fullPath });
        continue;
      }
    }
  }

  await walk(rootDir);

  await processWithConcurrency(tasks, async (task) => {
    const content = await readTextFile(task.fullPath);
    if (task.kind === 'theme') {
      // Last theme file wins, matching previous behavior of walking order.
      result.theme = content;
      return;
    }
    switch (task.kind) {
      case 'screens':
        result.screens[task.key] = content;
        break;
      case 'scripts':
        result.scripts[task.key] = content;
        break;
      case 'widgets':
        result.widgets[task.key] = content;
        break;
      case 'translations':
        result.translations[task.key] = content;
        break;
    }
  });

  return result;
}
