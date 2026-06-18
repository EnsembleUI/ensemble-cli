import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  argsForScript,
  normalizeArgsForDart,
  type EnableParameter,
  type EnableScript,
} from './enableRuntime.js';
import {
  assertDartAvailable,
  resolveDartInvocation,
  type DartInvocation,
} from './dartToolchain.js';

const execFileAsync = promisify(execFile);

function readExecOutput(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const execErr = err as { stderr?: string; stdout?: string; message?: string };
  return [execErr.stderr, execErr.stdout, execErr.message].filter(Boolean).join('\n').trim();
}

function throwModuleError(scriptName: string, err: unknown): never {
  const output = readExecOutput(err);
  const detail = output || `Failed to run ${scriptName}`;
  if (/Pattern not found/i.test(output)) {
    throw new Error(
      `${detail}\n\nThis starter project may not include placeholders for that module in lib/generated/ensemble_modules.dart. Try enabling modules individually, or update ensemble_modules.dart from the latest Ensemble starter.`
    );
  }
  throw new Error(detail);
}

async function runStarterScript(options: {
  cacheDir: string;
  projectRoot: string;
  script: EnableScript;
  argsArray: string[];
  commonParameters: EnableParameter[];
  dart: DartInvocation;
  verbose?: boolean;
}): Promise<void> {
  const commandArgs = [
    ...options.dart.prefixArgs,
    'run',
    path.join(options.cacheDir, options.script.path),
    ...argsForScript(
      options.script,
      normalizeArgsForDart(options.argsArray),
      options.commonParameters
    ),
  ];

  if (options.verbose) {
    // eslint-disable-next-line no-console
    console.log(`Executing: ${options.dart.command} ${commandArgs.join(' ')}`);
  }

  try {
    const { stdout, stderr } = await execFileAsync(options.dart.command, commandArgs, {
      cwd: options.projectRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (err) {
    throwModuleError(options.script.name, err);
  }
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
    await runStarterScript({ ...options, script, dart });
  }
}
