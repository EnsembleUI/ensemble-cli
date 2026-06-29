import { spawn } from 'node:child_process';

import { assertDartAvailable, resolveDartInvocation } from '../core/dartToolchain.js';
import { withTemporaryTestRunnerDep } from '../core/pubspecTestRunner.js';
import { resolveStarterProjectRootWithWalkUp } from '../core/starterProject.js';

function collectPassthroughArgs(argv: readonly string[] = process.argv): string[] {
  const testIndex = argv.indexOf('test');
  if (testIndex === -1) return [];

  const passthrough: string[] = [];
  for (let i = testIndex + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project') {
      i += 1;
      continue;
    }
    if (!arg.startsWith('--project=')) passthrough.push(arg);
  }
  return passthrough;
}

function runDart(
  command: string,
  prefixArgs: string[],
  args: string[],
  cwd: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefixArgs, ...args], { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function testCommand(options: { project?: string } = {}): Promise<void> {
  const projectRoot = await resolveStarterProjectRootWithWalkUp(options.project);
  const dart = await resolveDartInvocation(projectRoot);
  await assertDartAvailable(dart);

  const args = ['run', 'ensemble_test_runner:ensemble_test', ...collectPassthroughArgs()];

  await withTemporaryTestRunnerDep(projectRoot, async () => {
    process.exitCode = await runDart(dart.command, dart.prefixArgs, args, projectRoot);
  });
}
