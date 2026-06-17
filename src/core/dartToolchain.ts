import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { fileExists } from './fs.js';

const execFileAsync = promisify(execFile);

export interface DartInvocation {
  command: string;
  prefixArgs: string[];
}

export async function resolveDartInvocation(projectRoot: string): Promise<DartInvocation> {
  const hasFvm =
    (await fileExists(path.join(projectRoot, '.fvmrc'))) ||
    (await fileExists(path.join(projectRoot, '.fvm', 'fvm_config.json')));

  return hasFvm ? { command: 'fvm', prefixArgs: ['dart'] } : { command: 'dart', prefixArgs: [] };
}

export async function assertDartAvailable(invocation: DartInvocation): Promise<void> {
  try {
    await execFileAsync(invocation.command, [...invocation.prefixArgs, '--version'], {
      timeout: 15_000,
    });
  } catch {
    const via =
      invocation.prefixArgs.length > 0
        ? `${invocation.command} ${invocation.prefixArgs.join(' ')}`
        : 'dart';
    throw new Error(
      `Could not run ${via}. Install Dart/Flutter or configure FVM for this project.`
    );
  }
}
