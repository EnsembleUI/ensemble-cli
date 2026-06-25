import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'node:child_process';

import { type DartInvocation } from './dartToolchain.js';
import { ui } from './ui.js';

const ENSEMBLE_GIT_URL = 'https://github.com/EnsembleUI/ensemble.git';
const ENSEMBLE_TEST_RUNNER_REF = 'support-test-cases';
const ENSEMBLE_TEST_RUNNER_PATH = 'packages/ensemble_test_runner';

const TEST_RUNNER_DEV_DEP_BLOCK = `  ensemble_test_runner:
    git:
      url: ${ENSEMBLE_GIT_URL}
      ref: ${ENSEMBLE_TEST_RUNNER_REF}
      path: ${ENSEMBLE_TEST_RUNNER_PATH}
`;

function hasEnsembleTestRunnerDep(pubspecContent: string): boolean {
  return /^\s*ensemble_test_runner\s*:/m.test(pubspecContent);
}

export function spliceTestRunnerDevDependency(pubspecContent: string): string {
  if (hasEnsembleTestRunnerDep(pubspecContent)) return pubspecContent;

  const match = pubspecContent.match(/^dev_dependencies:\s*$/m);
  if (!match || match.index === undefined) {
    throw new Error('pubspec.yaml has no dev_dependencies section.');
  }

  const insertAt = match.index + match[0].length;
  return `${pubspecContent.slice(0, insertAt)}\n${TEST_RUNNER_DEV_DEP_BLOCK}${pubspecContent.slice(insertAt)}`;
}

export async function runDartWithExitCode(
  dart: DartInvocation,
  args: string[],
  cwd: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(dart.command, [...dart.prefixArgs, ...args], { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function withTemporaryTestRunnerDep<T>(
  projectRoot: string,
  fn: () => Promise<T>
): Promise<T> {
  const pubspecPath = path.join(projectRoot, 'pubspec.yaml');
  const original = await fs.readFile(pubspecPath, 'utf8');
  let modified = false;

  try {
    if (!hasEnsembleTestRunnerDep(original)) {
      await fs.writeFile(pubspecPath, spliceTestRunnerDevDependency(original), 'utf8');
      modified = true;
    }

    return await fn();
  } finally {
    if (modified) {
      try {
        await fs.writeFile(pubspecPath, original, 'utf8');
      } catch (error) {
        ui.warn(
          `Failed to restore pubspec.yaml after tests: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
