import fs from 'fs/promises';
import path from 'path';

import { ui } from './ui.js';

const ENSEMBLE_GIT_URL = 'https://github.com/EnsembleUI/ensemble.git';
const TEST_RUNNER_PATH = 'packages/ensemble_test_runner';
const MIN_ENSEMBLE_VERSION = [1, 2, 47] as const; // https://github.com/EnsembleUI/ensemble/releases/tag/ensemble-v1.2.47
const MIN_ENSEMBLE_REF = `ensemble-v${MIN_ENSEMBLE_VERSION.join('.')}`;

function hasTestRunnerDep(pubspec: string): boolean {
  return /^\s*ensemble_test_runner\s*:/m.test(pubspec);
}

function readEnsembleGitRef(pubspec: string): string {
  const ref = pubspec.match(/^\s*ensemble:\s*[\s\S]*?^\s+ref:\s*(\S+)/m)?.[1];
  if (!ref) {
    throw new Error(
      'Could not find an ensemble git dependency in pubspec.yaml.\n' +
        'Add an ensemble: block under dependencies with a git url and ref, then run ensemble test again.'
    );
  }
  return ref;
}

function assertSupportsTestRunner(ref: string): void {
  const match = ref.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return;

  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    if (version[i] < MIN_ENSEMBLE_VERSION[i]) {
      throw new Error(
        `ensemble test needs ${MIN_ENSEMBLE_REF} or newer — the test runner package was added in that release.\n\n` +
          `Your pubspec.yaml pins ensemble to: ${ref}\n\n` +
          `Update the ensemble ref in pubspec.yaml to ${MIN_ENSEMBLE_REF} (or a later tag), then run ensemble test again.`
      );
    }
    if (version[i] > MIN_ENSEMBLE_VERSION[i]) return;
  }
}

function spliceTestRunner(pubspec: string, ref: string): string {
  if (hasTestRunnerDep(pubspec)) return pubspec;

  const anchor = pubspec.match(/^dev_dependencies:\s*$/m);
  if (!anchor?.index) {
    throw new Error(
      'pubspec.yaml has no dev_dependencies section.\n' +
        'Add a dev_dependencies: block, then run ensemble test again.'
    );
  }

  const block = `  ensemble_test_runner:
    git:
      url: ${ENSEMBLE_GIT_URL}
      ref: ${ref}
      path: ${TEST_RUNNER_PATH}
`;
  const insertAt = anchor.index + anchor[0].length;
  return `${pubspec.slice(0, insertAt)}\n${block}${pubspec.slice(insertAt)}`;
}

export async function withTemporaryTestRunnerDep<T>(
  projectRoot: string,
  fn: () => Promise<T>
): Promise<T> {
  const pubspecPath = path.join(projectRoot, 'pubspec.yaml');
  const original = await fs.readFile(pubspecPath, 'utf8');
  let modified = false;

  try {
    if (!hasTestRunnerDep(original)) {
      const ref = readEnsembleGitRef(original);
      assertSupportsTestRunner(ref);
      await fs.writeFile(pubspecPath, spliceTestRunner(original, ref), 'utf8');
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
