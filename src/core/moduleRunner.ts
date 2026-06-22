import path from 'path';
import { spawn } from 'node:child_process';

import {
  argsForScript,
  normalizeArgsForDart,
  type EnableParameter,
  type EnableScript,
} from './enableRuntime.js';
import { assertDartAvailable, resolveDartInvocation } from './dartToolchain.js';

function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else process.exit(1);
    });
  });
}

export async function runStarterScriptsSequentially(options: {
  cacheDir: string;
  projectRoot: string;
  scripts: EnableScript[];
  argsArray: string[];
  commonParameters: EnableParameter[];
  verbose?: boolean;
}): Promise<void> {
  const dart = await resolveDartInvocation(options.projectRoot);
  await assertDartAvailable(dart);

  for (const script of options.scripts) {
    const commandArgs = [
      ...dart.prefixArgs,
      'run',
      path.join(options.cacheDir, script.path),
      ...argsForScript(script, normalizeArgsForDart(options.argsArray), options.commonParameters),
    ];

    if (options.verbose) {
      // eslint-disable-next-line no-console
      console.log(`Executing: ${dart.command} ${commandArgs.join(' ')}`);
    }

    await runProcess(dart.command, commandArgs, options.projectRoot);
  }
}
