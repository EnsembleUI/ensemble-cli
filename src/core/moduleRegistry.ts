import path from 'path';
import { createJiti } from 'jiti';

import type { StarterScript } from './starterTypes.js';

const MODULE_ALIASES: Record<string, string> = {
  generate_keystore: 'generateKeystore',
  generatekeystore: 'generateKeystore',
};

export function normalizeModuleName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return MODULE_ALIASES[trimmed.toLowerCase()] ?? trimmed.replace(/-/g, '_');
}

export function formatModuleLabel(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export async function loadStarterRegistry(cacheDir: string): Promise<{
  modules: StarterScript[];
  utilityScripts: StarterScript[];
}> {
  const jiti = createJiti(__filename, { interopDefault: true });
  const modulesExport = jiti(path.join(cacheDir, 'src', 'modules_scripts.ts')) as {
    modules?: StarterScript[];
  };
  const utilityExport = jiti(path.join(cacheDir, 'src', 'utility_scripts.ts')) as {
    scripts?: StarterScript[];
  };

  return {
    modules: modulesExport.modules ?? [],
    utilityScripts: utilityExport.scripts ?? [],
  };
}

export function findStarterScript(
  name: string,
  registry: { modules: StarterScript[]; utilityScripts: StarterScript[] }
): StarterScript {
  const normalized = normalizeModuleName(name);
  const script = [...registry.modules, ...registry.utilityScripts].find(
    (entry) => entry.name === normalized || entry.name === name
  );
  if (!script) {
    throw new Error(
      `Module "${name}" not found. Available modules: ${registry.modules.map((entry) => entry.name).join(', ')}`
    );
  }
  return script;
}
