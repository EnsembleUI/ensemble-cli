import fs from 'fs/promises';
import path from 'path';
import { fileExists } from './fs.js';

async function pubspecReferencesEnsemble(pubspecPath: string): Promise<boolean> {
  try {
    return /\bensemble\b/.test(await fs.readFile(pubspecPath, 'utf8'));
  } catch {
    return false;
  }
}

async function isStarterProjectRoot(dir: string): Promise<boolean> {
  const root = path.resolve(dir);
  const pubspecPath = path.join(root, 'pubspec.yaml');
  return (
    (await fileExists(pubspecPath)) &&
    (await pubspecReferencesEnsemble(pubspecPath)) &&
    (await fileExists(path.join(root, 'ensemble/ensemble.properties'))) &&
    (await fileExists(path.join(root, 'lib/generated/ensemble_modules.dart')))
  );
}

async function findStarterProjectRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  for (;;) {
    if (await isStarterProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const NOT_FOUND_HINT = `Could not find an Ensemble starter project.

Run this command from your starter project root, or pass:

  ensemble enable camera --project ./path-to-starter`;

const INVALID_HINT = `This does not look like an Ensemble starter project.

Expected:
  - pubspec.yaml (with ensemble dependency)
  - ensemble/ensemble.properties
  - lib/generated/ensemble_modules.dart`;

export async function resolveStarterProjectRoot(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!(await isStarterProjectRoot(resolved))) throw new Error(INVALID_HINT);
    return resolved;
  }

  const root = await findStarterProjectRoot(process.cwd());
  if (!root) throw new Error(NOT_FOUND_HINT);
  return root;
}
