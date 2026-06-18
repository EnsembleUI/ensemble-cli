import fs from 'fs/promises';
import path from 'path';
import { fileExists } from './fs.js';

async function isStarterProjectRoot(dir: string): Promise<boolean> {
  const root = path.resolve(dir);
  const pubspecPath = path.join(root, 'pubspec.yaml');
  if (!(await fileExists(pubspecPath))) return false;
  try {
    if (!/\bensemble\b/.test(await fs.readFile(pubspecPath, 'utf8'))) return false;
  } catch {
    return false;
  }
  return (
    (await fileExists(path.join(root, 'ensemble/ensemble.properties'))) &&
    (await fileExists(path.join(root, 'lib/generated/ensemble_modules.dart')))
  );
}

export async function resolveStarterProjectRoot(explicitPath?: string): Promise<string> {
  const root = path.resolve(explicitPath ?? process.cwd());

  if (!(await isStarterProjectRoot(root))) {
    throw new Error(
      'Not at starter project root. cd to the Flutter starter root or pass --project <path>.'
    );
  }

  return root;
}
