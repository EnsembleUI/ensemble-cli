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

function isEnsembleAppRoot(dir: string): boolean {
  const parent = path.dirname(path.resolve(dir));
  const grandparent = path.dirname(parent);
  return path.basename(parent) === 'apps' && path.basename(grandparent) === 'ensemble';
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

const TEST_CWD_HINT =
  'Run ensemble test from the starter root or an ensemble app directory (ensemble/apps/<app>). Or pass --project <path>.';

export async function resolveStarterProjectRootWithWalkUp(explicitPath?: string): Promise<string> {
  if (explicitPath) return resolveStarterProjectRoot(explicitPath);

  const cwd = path.resolve(process.cwd());
  if (await isStarterProjectRoot(cwd)) return cwd;

  if (!isEnsembleAppRoot(cwd)) throw new Error(TEST_CWD_HINT);

  const starterRoot = path.resolve(cwd, '..', '..', '..');
  if (await isStarterProjectRoot(starterRoot)) return starterRoot;

  throw new Error(TEST_CWD_HINT);
}
