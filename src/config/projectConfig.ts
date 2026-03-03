import fs from 'fs/promises';
import path from 'path';

import type { ArtifactProp } from '../core/dto.js';

export type EnsembleProjectAppConfigOptions = Partial<Record<ArtifactProp, boolean>>;

export interface EnsembleProjectAppConfig {
  appId: string;
  name?: string;
  description?: string;
  /** Name of the screen with isRoot: true (from cloud app). Used when building/pushing. */
  appHome?: string;
  options?: EnsembleProjectAppConfigOptions;
  [key: string]: unknown;
}

export interface EnsembleProjectConfig {
  default: string;
  apps: Record<string, EnsembleProjectAppConfig>;
}

export interface AppContext {
  projectRoot: string;
  config: EnsembleProjectConfig;
  appKey: string;
  appId: string;
}

const PROJECT_CONFIG_FILENAME = 'ensemble.config.json';

async function findProjectRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  // Walk up until we find ensemble.config.json or reach filesystem root.
  // Use an explicit loop that terminates when we hit the filesystem root.
  for (;;) {
    const candidate = path.join(current, PROJECT_CONFIG_FILENAME);
    try {
      await fs.access(candidate);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

export async function loadProjectConfig(): Promise<{
  projectRoot: string;
  config: EnsembleProjectConfig;
}> {
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new Error(
      `Could not find ${PROJECT_CONFIG_FILENAME}. Run "ensemble init" in your project root first.`
    );
  }

  const raw = await fs.readFile(path.join(root, PROJECT_CONFIG_FILENAME), 'utf8');
  const parsed = JSON.parse(raw) as EnsembleProjectConfig;

  if (!parsed.default || !parsed.apps || typeof parsed.apps !== 'object') {
    throw new Error(
      `${PROJECT_CONFIG_FILENAME} is invalid. It must include "default" and "apps" fields.`
    );
  }

  const defaultApp = parsed.apps[parsed.default];
  if (!defaultApp || typeof defaultApp.appId !== 'string') {
    throw new Error(
      `${PROJECT_CONFIG_FILENAME} is invalid. "apps.${parsed.default}.appId" must be a string.`
    );
  }

  return { projectRoot: root, config: parsed };
}

export async function resolveAppContext(requestedAppKey?: string): Promise<AppContext> {
  const { projectRoot, config } = await loadProjectConfig();
  const appKey = requestedAppKey || config.default;
  const appConfig = config.apps[appKey];

  if (!appConfig || typeof appConfig.appId !== 'string') {
    throw new Error(
      `No app id configured for key "${appKey}". Check "apps" in ${PROJECT_CONFIG_FILENAME}.`
    );
  }

  return { projectRoot, config, appKey, appId: appConfig.appId };
}

export async function writeProjectConfigIfMissing(config: EnsembleProjectConfig): Promise<void> {
  const cwd = process.cwd();
  const filePath = path.join(cwd, PROJECT_CONFIG_FILENAME);

  try {
    await fs.access(filePath);
    // Already exists, do not overwrite.
    console.log(`${PROJECT_CONFIG_FILENAME} already exists, leaving it as-is.`);
    return;
  } catch {
    // continue
  }

  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Created ${PROJECT_CONFIG_FILENAME} in ${cwd}.`);
}

export interface UpsertAppAliasOptions {
  name?: string;
  description?: string;
  /** Name of screen with isRoot: true (fetched from cloud artifacts). */
  appHome?: string;
}

export async function upsertAppAlias(
  alias: string,
  appId: string,
  opts?: UpsertAppAliasOptions,
): Promise<void> {
  const root = await findProjectRoot(process.cwd());

  const appEntry: EnsembleProjectAppConfig = {
    appId,
    ...(opts?.name !== undefined && { name: opts.name }),
    ...(opts?.description !== undefined && { description: opts.description }),
    ...(opts?.appHome !== undefined && { appHome: opts.appHome }),
  };

  if (!root) {
    const initialConfig: EnsembleProjectConfig = {
      default: alias,
      apps: {
        [alias]: appEntry,
      },
    };
    await writeProjectConfigIfMissing(initialConfig);
    return;
  }

  const filePath = path.join(root, PROJECT_CONFIG_FILENAME);
  const raw = await fs.readFile(filePath, 'utf8');
  const existing = JSON.parse(raw) as EnsembleProjectConfig;

  const apps = {
    ...existing.apps,
    [alias]: {
      ...(existing.apps?.[alias] ?? {}),
      ...appEntry,
    },
  };

  const merged: EnsembleProjectConfig = {
    ...existing,
    apps,
  };

  await fs.writeFile(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log(`Updated ${PROJECT_CONFIG_FILENAME}: alias "${alias}" now points to app "${appId}".`);
}
