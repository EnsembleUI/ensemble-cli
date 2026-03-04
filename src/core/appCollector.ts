/**
 * Collects app files from the filesystem into a structured representation.
 * Kept in core so buildDocuments can depend on it without importing from commands.
 */

import fs from 'fs/promises';
import path from 'path';

import type { ArtifactProp } from './dto.js';
import { processWithConcurrency } from './concurrency.js';

export interface ParsedAppFiles {
  screens: Record<string, string>;
  scripts: Record<string, string>;
  widgets: Record<string, string>;
  translations: Record<string, string>;
  theme?: string;
}

export type CollectOptions = Partial<Record<ArtifactProp, boolean>>;

type AppCollectorPhase = 'scanning' | 'reading' | 'completed';

export interface CollectAppFilesHooks {
  onStatus?: (phase: AppCollectorPhase, details?: Record<string, unknown>) => void;
}

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
  hooks: CollectAppFilesHooks = {},
): Promise<ParsedAppFiles> {
  const include = (prop: ArtifactProp) => shouldInclude(prop, collectOptions);
  const { onStatus } = hooks;
  const reportStatus = (phase: AppCollectorPhase, details?: Record<string, unknown>) => {
    onStatus?.(phase, details);
  };

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

  reportStatus('scanning', { rootDir });

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

  reportStatus('reading', {
    rootDir,
    taskCount: tasks.length,
  });

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

  reportStatus('completed', {
    rootDir,
    screenCount: Object.keys(result.screens).length,
    scriptCount: Object.keys(result.scripts).length,
    widgetCount: Object.keys(result.widgets).length,
    translationCount: Object.keys(result.translations).length,
    hasTheme: typeof result.theme === 'string',
  });

  return result;
}
