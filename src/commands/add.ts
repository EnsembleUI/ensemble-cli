import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import { loadProjectConfig } from '../config/projectConfig.js';
import { buildLocalAssetEnvEntries, buildLocalAssetUsageKey } from '../core/assetEnv.js';
import { readEnvFile, upsertEnvConfig } from '../core/envConfig.js';
import { upsertManifestEntry } from '../core/manifest.js';
import { ui } from '../core/ui.js';

export type AddKind = 'screen' | 'widget' | 'script' | 'action' | 'translation' | 'asset';

type AssetConflictResolution = 'cancel' | 'overwrite';

function isInteractiveTty(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

function normalizeName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Untitled';
  // Replace consecutive whitespace with single space, then remove quotes.
  return trimmed.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');
}

function nameWithoutSpaces(name: string): string {
  return name.replace(/\s+/g, '');
}

function stripWrappingQuotes(input: string): string {
  const trimmed = input.trim();
  // Strip one pair of wrapping quotes to support common CLI copy/paste like '/path with spaces/file.png'
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
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

async function addAsset(
  projectRoot: string,
  assetPathInput: string,
  options: { overwrite?: boolean; interactive?: boolean } = {}
): Promise<{
  fileName: string;
  createdPath: string;
  usageKey: string;
  skipped?: boolean;
}> {
  const resolvedInputPath = path.resolve(projectRoot, stripWrappingQuotes(assetPathInput));
  const sourceStat = await fs.stat(resolvedInputPath).catch(() => null);
  if (!sourceStat || !sourceStat.isFile()) {
    throw new Error(`Asset path does not exist or is not a file: ${assetPathInput}`);
  }
  const fileName = path.basename(resolvedInputPath);
  const targetDir = path.join(projectRoot, 'assets');
  await ensureDir(targetDir);
  const targetPath = path.join(targetDir, fileName);
  const overwrite = options.overwrite === true;
  if (await fileExists(targetPath)) {
    if (!overwrite) {
      const canPrompt = options.interactive === true;
      if (!canPrompt) {
        throw new Error(
          `File already exists: ${path.relative(projectRoot, targetPath)}. Re-run with --overwrite to replace it.`
        );
      }

      const { resolution } = await prompts({
        type: 'select',
        name: 'resolution',
        message: `Asset already exists at ${path.relative(projectRoot, targetPath)}. What do you want to do?`,
        choices: [
          { title: 'Cancel', value: 'cancel' },
          { title: 'Overwrite', value: 'overwrite' },
        ],
        initial: 0,
      });

      const r = resolution as AssetConflictResolution | undefined;
      if (!r || r === 'cancel') {
        return {
          fileName,
          createdPath: path.relative(projectRoot, targetPath),
          usageKey: '',
          skipped: true,
        };
      }
    }
  }

  await fs.copyFile(resolvedInputPath, targetPath);

  let existingAssetsBaseUrl: string | undefined;
  try {
    const existingConfig = await readEnvFile(projectRoot, '.env.config');
    const assetsEntry = existingConfig.find((entry) => entry.key === 'assets');
    if (assetsEntry?.value) {
      existingAssetsBaseUrl = assetsEntry.value;
    }
  } catch {
    existingAssetsBaseUrl = undefined;
  }

  await upsertEnvConfig(projectRoot, buildLocalAssetEnvEntries(fileName, existingAssetsBaseUrl));

  return {
    fileName,
    createdPath: path.relative(projectRoot, targetPath),
    usageKey: buildLocalAssetUsageKey(fileName),
  };
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

export async function addCommand(
  kindArg?: AddKind,
  rawNameArg?: string,
  options: { overwrite?: boolean } = {}
): Promise<void> {
  let kind = kindArg;
  let rawName = rawNameArg;
  const canPrompt = isInteractiveTty();
  const interactive = canPrompt && (!kindArg || !rawNameArg);

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
    const { fileName, createdPath, usageKey, skipped } = await addAsset(projectRoot, rawName, {
      interactive: canPrompt,
      overwrite: options.overwrite,
    });
    if (skipped) {
      ui.warn('Add cancelled.');
      return;
    }
    ui.success(`Created asset "${fileName}" at ${createdPath} and updated .env.config.`);
    if (usageKey) {
      ui.note(`Usage: ${usageKey}`);
    }
    ui.note('Asset saved locally. Run `ensemble push` to upload to cloud.');
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

  ui.success(
    `Created ${kind} "${name}" at ${path.relative(
      projectRoot,
      filePath
    )}${updateManifest ? ' and updated .manifest.json' : ''}.`
  );
}
