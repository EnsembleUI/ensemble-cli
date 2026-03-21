import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import { loadProjectConfig } from '../config/projectConfig.js';
import { resolveAppContext } from '../config/projectConfig.js';
import { getValidAuthSession } from '../auth/session.js';
import { uploadAssetToStudio } from '../cloud/assetClient.js';
import { upsertManifestEntry, type RootManifest } from '../core/manifest.js';
import { ui } from '../core/ui.js';
import { withSpinner } from '../lib/spinner.js';

export type AddKind = 'screen' | 'widget' | 'script' | 'action' | 'translation' | 'asset';

function normalizeName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Untitled';
  // Replace consecutive whitespace with single space, then remove quotes.
  return trimmed.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');
}

function nameWithoutSpaces(name: string): string {
  return name.replace(/\s+/g, '');
}

async function resolveNameWithSpaces(name: string, interactive: boolean): Promise<string> {
  if (!/\s/.test(name)) return name;
  const suggestion = nameWithoutSpaces(name);
  if (!interactive) {
    throw new Error(`Artifact names cannot contain spaces. Did you mean "${suggestion}"?`);
  }
  const { useSuggestion } = await prompts({
    type: 'confirm',
    name: 'useSuggestion',
    message: `Artifact names cannot contain spaces. Use "${suggestion}" instead?`,
    initial: true,
  });
  if (!useSuggestion) {
    throw new Error(
      `Artifact names cannot contain spaces. Try again with a name like "${suggestion}".`
    );
  }
  return suggestion;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseEnvConfig(raw: string): {
  lines: string[];
  keyToLineIndex: Map<string, number>;
} {
  const lines = raw.split(/\r?\n/);
  const keyToLineIndex = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key) keyToLineIndex.set(key, i);
  }
  return { lines, keyToLineIndex };
}

async function upsertEnvConfig(
  projectRoot: string,
  entries: Array<{ key: string; value: string; overwrite?: boolean }>
): Promise<void> {
  const envPath = path.join(projectRoot, '.env.config');
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    raw = '';
  }
  const parsed = parseEnvConfig(raw);
  // Avoid introducing visual gaps when appending new entries.
  while (parsed.lines.length > 0 && parsed.lines[parsed.lines.length - 1].trim() === '') {
    parsed.lines.pop();
  }
  for (const entry of entries) {
    const line = `${entry.key}=${entry.value}`;
    const existingIdx = parsed.keyToLineIndex.get(entry.key);
    if (existingIdx === undefined) {
      parsed.lines.push(line);
      parsed.keyToLineIndex.set(entry.key, parsed.lines.length - 1);
    } else if (entry.overwrite !== false) {
      parsed.lines[existingIdx] = line;
    }
  }
  const normalized = parsed.lines.join('\n').replace(/\n*$/, '\n');
  await fs.writeFile(envPath, normalized, 'utf8');
}

async function addAsset(
  projectRoot: string,
  assetPathInput: string
): Promise<{
  fileName: string;
  createdPath: string;
  usageKey: string;
}> {
  const resolvedInputPath = path.resolve(projectRoot, assetPathInput.trim());
  const sourceStat = await fs.stat(resolvedInputPath).catch(() => null);
  if (!sourceStat || !sourceStat.isFile()) {
    throw new Error(`Asset path does not exist or is not a file: ${assetPathInput}`);
  }
  const fileName = path.basename(resolvedInputPath);
  const targetDir = path.join(projectRoot, 'assets');
  await ensureDir(targetDir);
  const targetPath = path.join(targetDir, fileName);
  if (await fileExists(targetPath)) {
    throw new Error(`File already exists: ${path.relative(projectRoot, targetPath)}`);
  }

  await fs.copyFile(resolvedInputPath, targetPath);

  const fileBuffer = await fs.readFile(targetPath);
  const fileDataBase64 = fileBuffer.toString('base64');

  const { appId } = await resolveAppContext();
  const session = await getValidAuthSession();
  if (!session.ok) {
    throw new Error(`${session.message}\nRun \`ensemble login\` and try again.`);
  }
  const uploadResult = await withSpinner('Uploading asset to cloud...', async () => {
    const result = await uploadAssetToStudio(appId, fileName, fileDataBase64, session.idToken);
    await upsertEnvConfig(projectRoot, [
      { key: 'assets', value: result.assetBaseUrl, overwrite: false },
      { key: result.envVariable.key, value: result.envVariable.value },
    ]);
    return result;
  });

  return {
    fileName,
    createdPath: path.relative(projectRoot, targetPath),
    usageKey: uploadResult.usageKey,
  };
}

async function maybeSetHomeScreenName(
  projectRoot: string,
  screenName: string,
  interactive: boolean
): Promise<boolean> {
  const manifestPath = path.join(projectRoot, '.manifest.json');
  let manifest: RootManifest = {};
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as RootManifest;
  } catch {
    manifest = {};
  }

  if (manifest.homeScreenName && typeof manifest.homeScreenName === 'string') {
    return false;
  }

  let shouldSet = true;
  if (interactive) {
    const { setHome } = await prompts({
      type: 'confirm',
      name: 'setHome',
      message: `Set "${screenName}" as homeScreenName (no homeScreenName set yet)?`,
      initial: true,
    });
    shouldSet = setHome === true;
  }

  if (!shouldSet) return false;

  manifest.homeScreenName = screenName;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return true;
}

function screenTemplate(name: string): string {
  return `View:
  styles:
    useSafeArea: true

  # Optional - set the header for the screen
  header:
    titleText: ${name}

  # Specify the body of the screen
  body:
    Column:
      styles:
        padding: 24
        gap: 8
      children:
        - Text:
            text: Hi there!
        - Button:
            label: Checkout Ensemble Kitchen Sink
            onTap:
              openUrl:
                url: 'https://studio.ensembleui.com/preview/index.html?appId=e24402cb-75e2-404c-866c-29e6c3dd7992'
`;
}

function widgetTemplate(): string {
  return `Widget:
  inputs:
    - customProperty
  body:
    Column:
      children:
        - Text:
            text: \${customProperty}
`;
}

function actionTemplate(): string {
  return `Action:
  inputs:
    - message
  body:
    executeActionGroup:
      actions:
        - showToast:
            message: \${message}
`;
}

function scriptTemplate(name: string): string {
  return `// Script: ${name}
`;
}

function translationTemplate(name: string): string {
  return `# Translation: ${name}

`;
}

export async function addCommand(kindArg?: AddKind, rawNameArg?: string): Promise<void> {
  let kind = kindArg;
  let rawName = rawNameArg;
  const interactive = !kindArg || !rawNameArg;

  if (!kind) {
    const { kind: selected } = await prompts({
      type: 'select',
      name: 'kind',
      message: 'What would you like to add?',
      choices: [
        { title: 'Screen', value: 'screen' },
        { title: 'Widget', value: 'widget' },
        { title: 'Script', value: 'script' },
        { title: 'Action', value: 'action' },
        { title: 'Translation', value: 'translation' },
        { title: 'Asset', value: 'asset' },
      ],
    });
    if (!selected) {
      ui.warn('Add cancelled.');
      return;
    }
    kind = selected as AddKind;
  }

  if (!kind) {
    throw new Error('Artifact type is required.');
  }

  if (!rawName) {
    const { name } = await prompts({
      type: 'text',
      name: 'name',
      message: kind === 'asset' ? 'Path for the asset file:' : `Name for the ${kind}:`,
      validate: (v: string) => (v && v.trim().length > 0 ? true : 'Value is required'),
    });
    if (!name) {
      ui.warn('Add cancelled.');
      return;
    }
    rawName = name as string;
  }

  if (!rawName) {
    throw new Error('Name is required.');
  }

  const { projectRoot } = await loadProjectConfig();
  if (kind === 'asset') {
    const { fileName, createdPath, usageKey } = await addAsset(projectRoot, rawName);
    ui.success(`Created asset "${fileName}" at ${createdPath} and updated .env.config.`);
    ui.note(`Usage Example: ${usageKey}`);
    return;
  }

  let name = normalizeName(rawName);
  name = await resolveNameWithSpaces(name, interactive);

  let targetDir: string;
  let fileName: string;
  let contents: string;
  let updateManifest = false;

  switch (kind) {
    case 'screen':
      targetDir = path.join(projectRoot, 'screens');
      fileName = `${name}.yaml`;
      contents = screenTemplate(name);
      break;
    case 'widget':
      targetDir = path.join(projectRoot, 'widgets');
      fileName = `${name}.yaml`;
      contents = widgetTemplate();
      updateManifest = true;
      break;
    case 'script':
      targetDir = path.join(projectRoot, 'scripts');
      fileName = `${name}.js`;
      contents = scriptTemplate(name);
      updateManifest = true;
      break;
    case 'action':
      targetDir = path.join(projectRoot, 'actions');
      fileName = `${name}.yaml`;
      contents = actionTemplate();
      updateManifest = true;
      break;
    case 'translation':
      targetDir = path.join(projectRoot, 'translations');
      fileName = `${name}.yaml`;
      contents = translationTemplate(name);
      updateManifest = true;
      break;
    default:
      // This should be unreachable if commander validates input.
      throw new Error(
        `Unknown artifact type "${kind}". Expected one of: screen, widget, script, action, translation, asset.`
      );
  }

  await ensureDir(targetDir);
  const filePath = path.join(targetDir, fileName);
  if (await fileExists(filePath)) {
    throw new Error(`File already exists: ${path.relative(projectRoot, filePath)}`);
  }

  await fs.writeFile(filePath, contents, 'utf8');

  if (updateManifest) {
    await upsertManifestEntry(
      projectRoot,
      kind as 'widget' | 'script' | 'action' | 'translation',
      name
    );
  }

  const homeUpdated =
    kind === 'screen' ? await maybeSetHomeScreenName(projectRoot, name, interactive) : false;

  ui.success(
    `Created ${kind} "${name}" at ${path.relative(
      projectRoot,
      filePath
    )}${updateManifest ? ' and updated .manifest.json' : ''}${homeUpdated ? ' (set as homeScreenName)' : ''}.`
  );
}
