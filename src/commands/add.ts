import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

import { loadProjectConfig } from '../config/projectConfig.js';

export type AddKind = 'screen' | 'widget' | 'script' | 'translation';

function normalizeName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Untitled';
  // Replace consecutive whitespace with single space, then remove quotes.
  return trimmed.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '');
}

function nameWithoutSpaces(name: string): string {
  return name.replace(/\s+/g, '');
}

async function resolveNameWithSpaces(
  name: string,
  interactive: boolean,
): Promise<string> {
  if (!/\s/.test(name)) return name;
  const suggestion = nameWithoutSpaces(name);
  if (!interactive) {
    throw new Error(
      `Artifact names cannot contain spaces. Did you mean "${suggestion}"?`,
    );
  }
  const { useSuggestion } = await prompts({
    type: 'confirm',
    name: 'useSuggestion',
    message: `Artifact names cannot contain spaces. Use "${suggestion}" instead?`,
    initial: true,
  });
  if (!useSuggestion) {
    throw new Error(
      `Artifact names cannot contain spaces. Try again with a name like "${suggestion}".`,
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

interface RootManifest {
  scripts?: { name: string }[];
  widgets?: { name: string }[];
  homeScreenName?: string;
  defaultLanguage?: string;
  languages?: string[];
}

async function upsertManifest(
  projectRoot: string,
  kind: 'widget' | 'script' | 'translation',
  name: string,
): Promise<void> {
  // Root-level manifest file (note the leading dot).
  const manifestPath = path.join(projectRoot, '.manifest.json');
  let manifest: RootManifest = {};
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as RootManifest;
  } catch {
    manifest = {};
  }

  if (kind === 'widget') {
    const current = manifest.widgets ?? [];
    if (!current.some((w) => w.name === name)) {
      manifest.widgets = [...current, { name }];
    }
  } else if (kind === 'script') {
    const current = manifest.scripts ?? [];
    if (!current.some((s) => s.name === name)) {
      manifest.scripts = [...current, { name }];
    }
  } else if (kind === 'translation') {
    const currentLangs = manifest.languages ?? [];
    if (!currentLangs.includes(name)) {
      manifest.languages = [...currentLangs, name];
    }
    if (!manifest.defaultLanguage) {
      manifest.defaultLanguage = name;
    }
  }

  await fs.writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
}

async function maybeSetHomeScreenName(
  projectRoot: string,
  screenName: string,
  interactive: boolean,
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
  await fs.writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
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
        { title: 'Translation', value: 'translation' },
      ],
    });
    if (!selected) {
      // eslint-disable-next-line no-console
      console.log('Add cancelled.');
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
      message: `Name for the ${kind}:`,
      validate: (v: string) => (v && v.trim().length > 0 ? true : 'Name is required'),
    });
    if (!name) {
      // eslint-disable-next-line no-console
      console.log('Add cancelled.');
      return;
    }
    rawName = name as string;
  }

  if (!rawName) {
    throw new Error('Name is required.');
  }

  let name = normalizeName(rawName);
  name = await resolveNameWithSpaces(name, interactive);
  const { projectRoot } = await loadProjectConfig();

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
    case 'translation':
      targetDir = path.join(projectRoot, 'translations');
      fileName = `${name}.yaml`;
      contents = translationTemplate(name);
      updateManifest = true;
      break;
    default:
      // This should be unreachable if commander validates input.
      throw new Error(
        `Unknown artifact type "${kind}". Expected one of: screen, widget, script, translation.`,
      );
  }

  await ensureDir(targetDir);
  const filePath = path.join(targetDir, fileName);
  if (await fileExists(filePath)) {
    throw new Error(`File already exists: ${path.relative(projectRoot, filePath)}`);
  }

  await fs.writeFile(filePath, contents, 'utf8');

  if (updateManifest) {
    await upsertManifest(
      projectRoot,
      kind as 'widget' | 'script' | 'translation',
      name,
    );
  }

  const homeUpdated =
    kind === 'screen'
      ? await maybeSetHomeScreenName(projectRoot, name, interactive)
      : false;

  // eslint-disable-next-line no-console
  console.log(
    `Created ${kind} "${name}" at ${path.relative(
      projectRoot,
      filePath,
    )}${updateManifest ? ' and updated .manifest.json' : ''}${homeUpdated ? ' (set as homeScreenName)' : ''}.`,
  );
}

