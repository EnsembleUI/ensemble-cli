import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  spliceTestRunnerDevDependency,
  withTemporaryTestRunnerDep,
} from '../../src/core/pubspecTestRunner.js';

const SAMPLE_PUBSPEC = `name: demo
dev_dependencies:
  flutter_test:
    sdk: flutter
`;

describe('pubspecTestRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-pubspec-test-runner-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('splices test runner under dev_dependencies', () => {
    const updated = spliceTestRunnerDevDependency(SAMPLE_PUBSPEC);
    expect(updated).toContain('ensemble_test_runner:');
    expect(updated).toContain('ref: support-test-cases');
  });

  it('restores pubspec after callback', async () => {
    await fs.writeFile(path.join(tmpDir, 'pubspec.yaml'), SAMPLE_PUBSPEC, 'utf8');

    await withTemporaryTestRunnerDep(tmpDir, async () => undefined);

    expect(await fs.readFile(path.join(tmpDir, 'pubspec.yaml'), 'utf8')).toBe(SAMPLE_PUBSPEC);
  });

  it('restores pubspec when callback throws', async () => {
    await fs.writeFile(path.join(tmpDir, 'pubspec.yaml'), SAMPLE_PUBSPEC, 'utf8');

    await expect(
      withTemporaryTestRunnerDep(tmpDir, async () => {
        throw new Error('test failed');
      })
    ).rejects.toThrow(/test failed/i);

    expect(await fs.readFile(path.join(tmpDir, 'pubspec.yaml'), 'utf8')).toBe(SAMPLE_PUBSPEC);
  });

  it('skips splice when ensemble_test_runner is already in pubspec', async () => {
    const pubspec = `${SAMPLE_PUBSPEC}  ensemble_test_runner:
    git:
      url: https://github.com/EnsembleUI/ensemble.git
      ref: support-test-cases
      path: packages/ensemble_test_runner
`;
    await fs.writeFile(path.join(tmpDir, 'pubspec.yaml'), pubspec, 'utf8');

    await withTemporaryTestRunnerDep(tmpDir, async () => undefined);

    expect(await fs.readFile(path.join(tmpDir, 'pubspec.yaml'), 'utf8')).toBe(pubspec);
  });
});
