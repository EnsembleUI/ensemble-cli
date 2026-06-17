import path from 'path';
import { createJiti } from 'jiti';
import prompts from 'prompts';

export interface EnableParameter {
  key: string;
  question: string;
  type: string;
  choices?: string[];
  platform: string[];
}

export interface EnableScript {
  name: string;
  path: string;
  parameters: EnableParameter[];
}

export interface LoadedEnableRuntime {
  modules: EnableScript[];
  utilityScripts: EnableScript[];
  commonParameters: EnableParameter[];
  selectModules: () => Promise<EnableScript[]>;
  checkAndAskForMissingArgs: (selected: EnableScript[], argsArray: string[]) => Promise<string[]>;
}

/** `=` → param, else → script/module name (matches cached dart_runner parseArguments) */
export function parseEnableTokens(tokens: string[]): {
  scriptNames: string[];
  argsArray: string[];
} {
  const scriptNames: string[] = [];
  const argsArray: string[] = [];
  for (const token of tokens) {
    if (token.includes('=')) {
      argsArray.push(token);
    } else {
      scriptNames.push(token);
    }
  }
  return { scriptNames, argsArray };
}

function canonicalName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

export function formatModuleLabel(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function resolveScript(name: string, runtime: LoadedEnableRuntime): EnableScript {
  const all = [...runtime.modules, ...runtime.utilityScripts];
  const found =
    all.find((script) => script.name === name) ??
    all.find((script) => canonicalName(script.name) === canonicalName(name));
  if (!found) {
    throw new Error(
      `Module "${name}" not found. Available modules: ${runtime.modules.map((module) => module.name).join(', ')}`
    );
  }
  return found;
}

function parseArgsMap(argsArray: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argsArray) {
    const eq = arg.indexOf('=');
    if (eq < 0) continue;
    const key = arg.slice(0, eq);
    let value = arg.slice(eq + 1);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    args[key] = value;
  }
  return args;
}

function parsePlatformValue(args: Record<string, string>): string | undefined {
  const first = args.platform?.split(',')[0]?.trim().toLowerCase();
  if (first === 'ios' || first === 'android' || first === 'web') return first;
  return undefined;
}

function isParameterRequired(
  param: EnableParameter,
  args: Record<string, string>,
  providedKeys: Set<string>
): boolean {
  if (providedKeys.has(param.key) || args[param.key]) return false;
  if (!args.platform) return true;

  const platform = parsePlatformValue(args);
  return platform !== undefined && param.platform.includes(platform);
}

function dedupeParameters(params: EnableParameter[]): EnableParameter[] {
  const seen = new Set<string>();
  return params.filter((param) => {
    if (seen.has(param.key)) return false;
    seen.add(param.key);
    return true;
  });
}

export function assertRequiredParamsPresent(
  scripts: EnableScript[],
  commonParameters: EnableParameter[],
  argsArray: string[]
): void {
  const args = parseArgsMap(argsArray);
  const providedKeys = new Set(Object.keys(args));
  const params = dedupeParameters([
    ...commonParameters,
    ...scripts.flatMap((script) => script.parameters),
  ]);
  const missing = params
    .filter((param) => isParameterRequired(param, args, providedKeys))
    .map((param) => param.key);

  if (missing.length === 0) return;

  throw new Error(
    `Missing required parameter(s): ${missing.join(', ')}.\n\nPass them as key=value, for example:\n  ensemble enable camera platform=ios ensemble_version=1.2.40`
  );
}

export function argsForScript(
  script: EnableScript,
  argsArray: string[],
  commonParameters: EnableParameter[]
): string[] {
  const allowed = new Set([
    ...script.parameters.map((param) => param.key),
    ...commonParameters.map((param) => param.key),
  ]);
  return argsArray.filter((arg) => allowed.has(arg.split('=')[0] ?? ''));
}

function normalizePromptAnswers(
  answers: Record<string, string | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (value === 'yes') normalized[key] = 'true';
    else if (value === 'no') normalized[key] = 'false';
    else if (value !== undefined) normalized[key] = String(value);
  }
  return normalized;
}

async function askForMissingParameters(
  params: EnableParameter[],
  args: Record<string, string>,
  providedKeys: Set<string>
): Promise<Record<string, string>> {
  const questions: prompts.PromptObject[] = params
    .filter((param) => isParameterRequired(param, args, providedKeys))
    .map((param) => ({
      type: (param.type === 'toggle' ? 'select' : param.type) as prompts.PromptType,
      name: param.key,
      message: param.question,
      choices: param.choices?.map((choice) => ({ title: choice, value: choice })),
      validate: (value: string) => (value ? true : `Parameter "${param.key}" is required.`),
    }));

  if (questions.length === 0) return {};
  return normalizePromptAnswers((await prompts(questions)) as Record<string, string | undefined>);
}

async function selectModulesFromRegistry(modules: EnableScript[]): Promise<EnableScript[]> {
  const { selectedModules } = await prompts({
    type: 'multiselect',
    name: 'selectedModules',
    message: 'Please select the modules you want to enable:',
    choices: modules.map((module) => ({
      title: formatModuleLabel(module.name),
      value: module.name,
    })),
    hint: '- Space to select. Return to submit.',
  });

  if (!selectedModules?.length) return [];
  return selectedModules.map(
    (name: string) => modules.find((module) => module.name === name) as EnableScript
  );
}

async function checkAndAskForMissingArgs(
  scripts: EnableScript[],
  argsArray: string[],
  commonParameters: EnableParameter[]
): Promise<string[]> {
  const args = parseArgsMap(argsArray);
  const providedKeys = new Set(Object.keys(args));

  const commonAnswers = await askForMissingParameters(commonParameters, args, providedKeys);
  Object.assign(args, commonAnswers);
  for (const key of Object.keys(commonAnswers)) providedKeys.add(key);

  const moduleAnswers = await askForMissingParameters(
    dedupeParameters(scripts.flatMap((script) => script.parameters)),
    args,
    providedKeys
  );

  return argsArray.concat(
    ...Object.entries({ ...commonAnswers, ...moduleAnswers }).map(
      ([key, value]) => `${key}=${value}`
    )
  );
}

/** Dart getArgumentValue splits on '=' and does not strip shell quotes — execFile args must be unquoted. */
export function normalizeArgsForDart(argsArray: string[]): string[] {
  return argsArray.map((arg) => {
    const eq = arg.indexOf('=');
    if (eq < 0) return arg;
    const key = arg.slice(0, eq);
    let value = arg.slice(eq + 1);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    return `${key}=${value}`;
  });
}

function createCacheJiti(): ReturnType<typeof createJiti> {
  return createJiti(__filename, { interopDefault: true });
}

export async function loadEnableRuntime(cacheDir: string): Promise<LoadedEnableRuntime> {
  const jiti = createCacheJiti();
  const srcDir = path.join(cacheDir, 'src');

  const modulesExport = jiti(path.join(srcDir, 'modules_scripts.ts')) as {
    modules?: EnableScript[];
  };
  const utilityExport = jiti(path.join(srcDir, 'utility_scripts.ts')) as {
    scripts?: EnableScript[];
    commonParameters?: EnableParameter[];
  };

  const modules = modulesExport.modules ?? [];
  const utilityScripts = utilityExport.scripts ?? [];
  const commonParameters = utilityExport.commonParameters ?? [];

  return {
    modules,
    utilityScripts,
    commonParameters,
    selectModules: () => selectModulesFromRegistry(modules),
    checkAndAskForMissingArgs: (selected, argsArray) =>
      checkAndAskForMissingArgs(selected, argsArray, commonParameters),
  };
}
