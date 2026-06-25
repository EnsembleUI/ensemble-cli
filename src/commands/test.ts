import { assertDartAvailable, resolveDartInvocation } from '../core/dartToolchain.js';
import { runDartWithExitCode, withTemporaryTestRunnerDep } from '../core/pubspecTestRunner.js';
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

export async function testCommand(options: { project?: string } = {}): Promise<void> {
  const projectRoot = await resolveStarterProjectRootWithWalkUp(options.project);
  const dart = await resolveDartInvocation(projectRoot);
  await assertDartAvailable(dart);

  const dartArgs = ['run', 'ensemble_test_runner:ensemble_test', ...collectPassthroughArgs()];

  await withTemporaryTestRunnerDep(projectRoot, async () => {
    process.exitCode = await runDartWithExitCode(dart, dartArgs, projectRoot);
  });
}
