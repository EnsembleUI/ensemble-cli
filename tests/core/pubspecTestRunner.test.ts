import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withTemporaryTestRunnerDep } from '../../src/core/pubspecTestRunner.js';

const BASE_PUBSPEC = `name: demo
dependencies:
  ensemble:
    git:
      url: https://github.com/EnsembleUI/ensemble.git
      ref: ensemble-v1.2.47
dev_dependencies:
  flutter_test:
    sdk: flutter
`;

describe('withTemporaryTestRunnerDep', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-pubspec-test-runner-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writePubspec(content: string): Promise<void> {
    await fs.writeFile(path.join(tmpDir, 'pubspec.yaml'), content, 'utf8');
  }

  it('splices test runner at the app ensemble ref and restores pubspec', async () => {
    await writePubspec(BASE_PUBSPEC);

    await withTemporaryTestRunnerDep(tmpDir, async () => {
      const during = await fs.readFile(path.join(tmpDir, 'pubspec.yaml'), 'utf8');
      expect(during).toContain('ensemble_test_runner:');
      expect(during).toContain('ref: ensemble-v1.2.47');
    });

    expect(await fs.readFile(path.join(tmpDir, 'pubspec.yaml'), 'utf8')).toBe(BASE_PUBSPEC);
  });

  it('rejects ensemble refs below v1.2.47', async () => {
    await writePubspec(BASE_PUBSPEC.replace('ensemble-v1.2.47', 'ensemble-v1.2.46'));

    await expect(withTemporaryTestRunnerDep(tmpDir, async () => undefined)).rejects.toThrow(
      /needs ensemble-v1\.2\.47/i
    );
    await expect(withTemporaryTestRunnerDep(tmpDir, async () => undefined)).rejects.toThrow(
      /pins ensemble to: ensemble-v1\.2\.46/
    );
  });

  it('restores pubspec when callback throws', async () => {
    await writePubspec(BASE_PUBSPEC);

    await expect(
      withTemporaryTestRunnerDep(tmpDir, async () => {
        throw new Error('test failed');
      })
    ).rejects.toThrow(/test failed/i);

    expect(await fs.readFile(path.join(tmpDir, 'pubspec.yaml'), 'utf8')).toBe(BASE_PUBSPEC);
  });

  it('skips splice when ensemble_test_runner is already present', async () => {
    const pubspec = `${BASE_PUBSPEC}  ensemble_test_runner:
    git:
      url: https://github.com/EnsembleUI/ensemble.git
      ref: ensemble-v1.2.47
      path: packages/ensemble_test_runner
`;
    await writePubspec(pubspec);

    await withTemporaryTestRunnerDep(tmpDir, async () => undefined);

    expect(await fs.readFile(path.join(tmpDir, 'pubspec.yaml'), 'utf8')).toBe(pubspec);
  });
});
