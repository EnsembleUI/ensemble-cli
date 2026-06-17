import { ENSEMBLE_MODULES_REPO, ensureModulesTooling } from '../core/modulesCache.js';
import {
  assertRequiredParamsPresent,
  formatModuleLabel,
  loadEnableRuntime,
  parseEnableTokens,
  resolveScript,
  type EnableScript,
} from '../core/enableRuntime.js';
import { ModuleBatchError, runStarterScriptsSequentially } from '../core/moduleRunner.js';
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

  const runOptions = {
    cacheDir: tooling.cacheDir,
    projectRoot,
    scripts,
    argsArray: finalArgs,
    commonParameters: runtime.commonParameters,
    verbose: options.verbose,
  };

  try {
    printEnableSummary({
      scripts,
      results: await runStarterScriptsSequentially(runOptions),
      toolingRef: tooling.ref,
    });
  } catch (err) {
    if (err instanceof ModuleBatchError) {
      printEnableSummary({ scripts, results: err.completed, toolingRef: tooling.ref });
      ui.error(`Stopped at ${formatModuleLabel(err.failedScript)}.`);
      throw new Error(err.scriptOutput);
    }
    throw err;
  }
}

function printEnableSummary(options: {
  scripts: EnableScript[];
  results: Array<{ scriptName: string; modifiedFiles: string[] }>;
  toolingRef: string;
}): void {
  const succeeded = new Set(options.results.map((result) => result.scriptName));
  const enabled = options.scripts
    .filter((script) => succeeded.has(script.name))
    .map((script) => formatModuleLabel(script.name));
  const modified = [...new Set(options.results.flatMap((result) => result.modifiedFiles))].sort();

  if (enabled.length === 0) return;

  ui.success('Enabled:');
  // eslint-disable-next-line no-console
  console.log(enabled.map((name) => `  - ${name}`).join('\n'));

  ui.note('\nScripts:');
  ui.note(`  Source: ${ENSEMBLE_MODULES_REPO}`);
  ui.note(`  Ref: ${options.toolingRef}`);
  ui.note('  Registry: src/modules_scripts.ts');

  if (modified.length > 0) {
    ui.note('\nModified:');
    for (const file of modified) ui.note(`  - ${file}`);
  }

  if (modified.includes('pubspec.yaml')) {
    ui.note('\nDependencies changed. Run:');
    ui.note('  flutter pub get');
  }
}
