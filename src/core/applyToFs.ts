/**
 * Apply a cloud app state (or snapshot) to the local filesystem.
 * Used by pull and revert to overwrite local artifact files.
 */

import fs from 'fs/promises';
import path from 'path';

import type { CloudApp } from '../cloud/firestoreClient.js';
import type { ParsedAppFiles } from './appCollector.js';
import { ARTIFACT_FS_CONFIG } from './artifacts.js';
import type { ArtifactProp } from './artifacts.js';
import { processWithConcurrency } from './concurrency.js';
import { safeFileName } from './fileNames.js';
import {
  buildAndWriteManifest,
  type BuildManifestOptions,
} from './manifest.js';

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export interface ApplyCloudStateToFsOptions {
  /** When set, manifest is built and written after applying files. */
  manifestOptions?: BuildManifestOptions;
  /** Called every 25 completed tasks with (completed, total). */
  onProgress?: (completed: number, total: number) => void;
}

type WriteTask =
    | { op: 'write'; filePath: string; content: string }
    | { op: 'delete'; filePath: string };

/**
 * Write local artifact files to match the given cloud/snapshot state.
 * Deletes files that are not in the state. Optionally refreshes .manifest.json.
 */
export async function applyCloudStateToFs(
  projectRoot: string,
  cloudApp: CloudApp,
  localFiles: ParsedAppFiles,
  enabledByProp: Record<ArtifactProp, boolean>,
  options: ApplyCloudStateToFsOptions = {},
): Promise<void> {
  const { manifestOptions, onProgress } = options;

  const tasks: WriteTask[] = [];

  for (const cfg of ARTIFACT_FS_CONFIG) {
    const { prop, ext, isTheme } = cfg;
    if (!enabledByProp[prop]) continue;

    if (isTheme) {
      const themePath = path.join(projectRoot, 'theme.yaml');
      if (cloudApp.theme && cloudApp.theme.isArchived !== true) {
        tasks.push({
          op: 'write',
          filePath: themePath,
          content: cloudApp.theme.content ?? '',
        });
      } else {
        tasks.push({ op: 'delete', filePath: themePath });
      }
      continue;
    }

    const baseDir = path.join(projectRoot, prop);
    await ensureDir(baseDir);

    const cloudItems = (cloudApp as Record<string, unknown>)[prop] as
      | { name: string; content?: string; isArchived?: boolean }[]
      | undefined;

    const expected: Record<string, string> = {};
    for (const item of cloudItems ?? []) {
      if (item.isArchived === true) continue;
      expected[safeFileName(item.name, ext!)] = item.content ?? '';
    }

    const actual = (localFiles as unknown as Record<string, unknown>)[
      prop
    ] as Record<string, string> | undefined;
    const actualMap = actual ?? {};

    const expectedKeys = new Set(Object.keys(expected));
    const actualKeys = new Set(Object.keys(actualMap));

    for (const file of expectedKeys) {
      const content = expected[file] ?? '';
      const filePath = path.join(baseDir, file);
      if (!actualKeys.has(file) || actualMap[file] !== content) {
        tasks.push({ op: 'write', filePath, content });
      }
    }

    for (const file of actualKeys) {
      if (!expectedKeys.has(file)) {
        const filePath = path.join(baseDir, file);
        tasks.push({ op: 'delete', filePath });
      }
    }
  }

  let completed = 0;
  const total = tasks.length;

  await processWithConcurrency(tasks, async (task) => {
    if (task.op === 'write') {
      await fs.writeFile(task.filePath, task.content, 'utf8');
    } else {
      await fs.rm(task.filePath, { force: true });
    }
    completed += 1;
    if (total > 0 && completed % 25 === 0 && onProgress) {
      onProgress(completed, total);
    }
  });

  if (manifestOptions !== undefined) {
    await buildAndWriteManifest(projectRoot, cloudApp, manifestOptions);
  }
}
