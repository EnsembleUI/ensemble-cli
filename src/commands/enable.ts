import prompts from 'prompts';

import { ENSEMBLE_MODULES_REPO, ensureModulesTooling } from '../core/modulesCache.js';
import {
  findStarterScript,
  formatModuleLabel,
  loadStarterRegistry,
  normalizeModuleName,
} from '../core/moduleRegistry.js';
import { ModuleBatchError, runStarterScriptsSequentially } from '../core/moduleRunner.js';
import { resolveScriptArguments, type StarterArgMap } from '../core/moduleParams.js';
import { resolveStarterProjectRoot } from '../core/starterProject.js';
import { ui } from '../core/ui.js';
import type { StarterScript } from '../core/starterTypes.js';

export interface EnableCommandOptions {
  modules?: string[];
  project?: string;
  platform?: string;
  verbose?: boolean;
}

const MODULE_NAME_RE = /^[a-z][a-z0-9_]*$/;
const NON_INTERACTIVE_HINT = 'Module name required for non-interactive use.\n\nExample:\n  ensemble enable camera';

function isInteractiveTty(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/** split commander [modules...] tokens into module names and key=value params */
export function parseEnableTokens(tokens: string[]): {
  moduleNames: string[];
  inlineArgs: StarterArgMap;
} {
  const moduleNames: string[] = [];
  const inlineArgs: StarterArgMap = {};
  for (const token of tokens) {
    if (token.includes('=')) {
      const eq = token.indexOf('=');
      const key = token.slice(0, eq);
      if (key) inlineArgs[key] = token.slice(eq + 1);
    } else if (MODULE_NAME_RE.test(token)) {
      moduleNames.push(token);
    }
  }
  return { moduleNames, inlineArgs };
}

async function resolveScripts(
  moduleNames: string[],
  registry: Awaited<ReturnType<typeof loadStarterRegistry>>,
  interactive: boolean
): Promise<StarterScript[]> {
  const names = moduleNames.map(normalizeModuleName).filter(Boolean);
  if (names.length > 0) return names.map((name) => findStarterScript(name, registry));
  if (!interactive) throw new Error(NON_INTERACTIVE_HINT);

  const { selected } = await prompts({
    type: 'multiselect',
    name: 'selected',
    message: 'What do you want to enable?',
    choices: registry.modules.map((module) => ({
      title: formatModuleLabel(module.name),
      value: module.name,
    })),
    hint: '- Space to select. Return to submit.',
  });

  if (!selected?.length) {
    ui.warn('Enable command cancelled.');
    process.exitCode = 130;
    return [];
  }

  return selected.map((name: string) => findStarterScript(name, registry));
}

export async function enableCommand(options: EnableCommandOptions = {}): Promise<void> {
  const interactive = isInteractiveTty();
  const { moduleNames, inlineArgs } = parseEnableTokens(options.modules ?? []);
  const projectRoot = await resolveStarterProjectRoot(options.project);
  const tooling = await ensureModulesTooling();

  if (tooling.usedCacheFallback) {
    ui.warn(`Could not fetch latest module tooling.\nUsing cached module tooling (${tooling.ref}).`);
  }

  const registry = await loadStarterRegistry(tooling.cacheDir);
  const scripts = await resolveScripts(moduleNames, registry, interactive);
  if (scripts.length === 0) return;

  const argsArray = await resolveScriptArguments({
    scripts,
    provided: { ...(options.platform ? { platform: options.platform } : {}), ...inlineArgs },
    interactive,
  });

  const runOptions = {
    cacheDir: tooling.cacheDir,
    projectRoot,
    scripts,
    argsArray,
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
  scripts: StarterScript[];
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
