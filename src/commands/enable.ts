import { ensureModulesTooling } from '../core/modulesCache.js';
import {
  assertRequiredParamsPresent,
  loadEnableRuntime,
  parseEnableTokens,
  resolveScript,
  type EnableScript,
} from '../core/enableRuntime.js';
import { runStarterScriptsSequentially } from '../core/moduleRunner.js';
import { resolveStarterProjectRoot } from '../core/starterProject.js';
import { ui } from '../core/ui.js';

export { parseEnableTokens } from '../core/enableRuntime.js';

export interface EnableCommandOptions {
  modules?: string[];
  project?: string;
  verbose?: boolean;
}

const NON_INTERACTIVE_HINT =
  'Module name required for non-interactive use.\n\nExample:\n  ensemble enable camera';

function isInteractiveTty(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function resolveScripts(
  scriptNames: string[],
  runtime: Awaited<ReturnType<typeof loadEnableRuntime>>,
  interactive: boolean
): Promise<EnableScript[]> {
  if (scriptNames.length > 0) {
    return scriptNames.map((name) => resolveScript(name, runtime));
  }
  if (!interactive) throw new Error(NON_INTERACTIVE_HINT);

  const selected = await runtime.selectModules();
  if (selected.length === 0) {
    ui.warn('Enable command cancelled.');
    process.exitCode = 130;
    return [];
  }
  return selected;
}

export async function enableCommand(options: EnableCommandOptions = {}): Promise<void> {
  const interactive = isInteractiveTty();
  const { scriptNames, argsArray: tokenArgs } = parseEnableTokens(options.modules ?? []);
  const projectRoot = await resolveStarterProjectRoot(options.project);
  const tooling = await ensureModulesTooling();

  if (tooling.usedCacheFallback) {
    ui.warn(
      `Could not fetch latest module tooling.\nUsing cached module tooling (${tooling.ref}).`
    );
  }

  const runtime = await loadEnableRuntime(tooling.cacheDir);
  const scripts = await resolveScripts(scriptNames, runtime, interactive);
  if (scripts.length === 0) return;

  const finalArgs = interactive
    ? await runtime.checkAndAskForMissingArgs(scripts, tokenArgs)
    : (assertRequiredParamsPresent(scripts, runtime.commonParameters, tokenArgs), tokenArgs);

  await runStarterScriptsSequentially({
    cacheDir: tooling.cacheDir,
    projectRoot,
    scripts,
    argsArray: finalArgs,
    commonParameters: runtime.commonParameters,
    verbose: options.verbose,
  });
}
