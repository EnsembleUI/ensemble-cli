import prompts from 'prompts';

import {
  STARTER_COMMON_PARAMETERS,
  type StarterParameter,
  type StarterPlatform,
  type StarterScript,
} from './starterTypes.js';

export type StarterArgMap = Record<string, string>;

const GOOGLE_MAPS_KEYS = [
  'iOSGoogleMapsApiKey',
  'androidGoogleMapsApiKey',
  'webGoogleMapsApiKey',
] as const;

function applyConvenienceFlags(args: StarterArgMap): StarterArgMap {
  const next = { ...args };
  const sharedGoogleMapsKey = next.googleMapsApiKey;
  if (!sharedGoogleMapsKey) return next;

  for (const key of GOOGLE_MAPS_KEYS) {
    if (!next[key]) next[key] = sharedGoogleMapsKey;
  }
  delete next.googleMapsApiKey;
  return next;
}

function parsePlatformValue(raw: string | undefined): StarterPlatform | undefined {
  const first = raw?.split(',')[0]?.trim().toLowerCase();
  if (first === 'ios' || first === 'android' || first === 'web') return first;
  return undefined;
}

function isStarterParameterRequired(
  param: StarterParameter,
  args: StarterArgMap,
  providedKeys: Set<string>
): boolean {
  if (providedKeys.has(param.key) || args[param.key]) return false;
  if (!args.platform) return true;

  const platform = parsePlatformValue(args.platform);
  return platform !== undefined && param.platform.includes(platform);
}

function normalizeAnswers(answers: Record<string, string>): StarterArgMap {
  const normalized: StarterArgMap = {};
  for (const [key, value] of Object.entries(answers)) {
    if (value === 'yes') normalized[key] = 'true';
    else if (value === 'no') normalized[key] = 'false';
    else if (value !== undefined) normalized[key] = String(value);
  }
  return normalized;
}

async function askForMissingParameters(
  params: StarterParameter[],
  args: StarterArgMap,
  providedKeys: Set<string>,
  interactive: boolean
): Promise<StarterArgMap> {
  const questions: prompts.PromptObject[] = params
    .filter((param) => isStarterParameterRequired(param, args, providedKeys))
    .map((param) => ({
      type: (param.type === 'toggle' ? 'select' : param.type) as prompts.PromptType,
      name: param.key,
      message: param.question,
      choices: param.choices?.map((choice) => ({ title: choice, value: choice })),
      validate: (value: string) => (value ? true : `Parameter "${param.key}" is required.`),
    }));

  if (questions.length === 0) return {};
  if (!interactive) {
    throw new Error(
      `Missing required parameter(s): ${questions.map((q) => q.name).join(', ')}.\n\nPass them as key=value, for example:\n  ensemble enable google_maps googleMapsApiKey=YOUR_KEY ensemble_version=1.2.40`
    );
  }

  return normalizeAnswers((await prompts(questions)) as Record<string, string>);
}

function dedupeParameters(params: StarterParameter[]): StarterParameter[] {
  const seen = new Set<string>();
  return params.filter((param) => {
    if (seen.has(param.key)) return false;
    seen.add(param.key);
    return true;
  });
}

export async function resolveScriptArguments(options: {
  scripts: StarterScript[];
  provided: StarterArgMap;
  interactive: boolean;
}): Promise<string[]> {
  const args = applyConvenienceFlags(options.provided);
  const providedKeys = new Set(Object.keys(args));

  for (const params of [
    STARTER_COMMON_PARAMETERS,
    dedupeParameters(options.scripts.flatMap((script) => script.parameters)),
  ]) {
    Object.assign(args, await askForMissingParameters(params, args, providedKeys, options.interactive));
    for (const key of Object.keys(args)) providedKeys.add(key);
  }

  return Object.entries(args).map(([key, value]) => `${key}=${value}`);
}

export function formatArgsForScript(script: StarterScript, argsArray: string[]): string[] {
  const allowed = new Set([
    ...script.parameters.map((param) => param.key),
    ...STARTER_COMMON_PARAMETERS.map((param) => param.key),
  ]);
  return argsArray.filter((arg) => allowed.has(arg.split('=')[0] ?? ''));
}
