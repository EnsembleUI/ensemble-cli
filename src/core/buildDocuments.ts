import crypto from 'crypto';

import type { ParsedAppFiles } from './appCollector.js';
import type { CloudApp } from '../cloud/firestoreClient.js';
import {
  EnsembleDocumentType,
  type ScreenDTO,
  type WidgetDTO,
  type ScriptDTO,
  type ThemeDTO,
  type TranslationDTO,
  type ApplicationDTO,
} from './dto.js';

/**
 * Build a stable document id from a relative path (e.g. "screens/Home.yaml" -> "screens/Home.yaml").
 */
function pathToId(relativePath: string): string {
  return relativePath;
}

/**
 * Build a human-readable name from a path (e.g. "screens/Home.yaml" -> "Home").
 */
function pathToName(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? relativePath;
  const lastDot = base.lastIndexOf('.');
  return lastDot > 0 ? base.slice(0, lastDot) : base;
}

type BuildDocumentsStatusPhase = 'building' | 'validating';

export interface BuildDocumentsOptions {
  onStatus?: (phase: BuildDocumentsStatusPhase, details?: Record<string, unknown>) => void;
}

export function buildDocumentsFromParsed(
  parsed: ParsedAppFiles,
  appId: string,
  appName: string,
  appHome?: string,
  defaultLanguage?: string,
  options: BuildDocumentsOptions = {},
): ApplicationDTO {
  const now = new Date().toISOString();
  const { onStatus } = options;
  const reportStatus = (phase: BuildDocumentsStatusPhase, details?: Record<string, unknown>) => {
    onStatus?.(phase, details);
  };

  reportStatus('building', {
    screenFileCount: Object.keys(parsed.screens).length,
    widgetFileCount: Object.keys(parsed.widgets).length,
    scriptFileCount: Object.keys(parsed.scripts).length,
    translationFileCount: Object.keys(parsed.translations).length,
    hasTheme: typeof parsed.theme === 'string',
  });

  const screens: ScreenDTO[] = Object.entries(parsed.screens).map(
    ([relativePath, content]) => {
      const name = pathToName(relativePath);
      return {
        id: pathToId(`screens/${relativePath}`),
        name,
        content,
        type: EnsembleDocumentType.Screen,
        isRoot: appHome !== undefined ? name === appHome : undefined,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  const widgets: WidgetDTO[] = Object.entries(parsed.widgets).map(
    ([relativePath, content]) => ({
      id: pathToId(`widgets/${relativePath}`),
      name: pathToName(relativePath),
      content,
      type: EnsembleDocumentType.Widget,
      createdAt: now,
      updatedAt: now,
    }),
  );

  const scripts: ScriptDTO[] = Object.entries(parsed.scripts).map(
    ([relativePath, content]) => ({
      id: pathToId(`scripts/${relativePath}`),
      name: pathToName(relativePath),
      content,
      type: EnsembleDocumentType.Script,
      createdAt: now,
      updatedAt: now,
    }),
  );

  const theme: ThemeDTO | undefined = parsed.theme
    ? {
        id: 'theme',
        name: 'theme',
        content: parsed.theme,
        type: EnsembleDocumentType.Theme,
        createdAt: now,
        updatedAt: now,
      }
    : undefined;

  const translationEntries = Object.entries(parsed.translations);
  const translations: TranslationDTO[] = translationEntries.map(
    ([relativePath, content], index) => {
      const name = pathToName(relativePath);
      const isDefaultFromManifest =
        typeof defaultLanguage === 'string' && defaultLanguage.trim() !== ''
          ? name === defaultLanguage
          : false;
      return {
        id: `i18n_${name}`,
        name,
        content,
        type: EnsembleDocumentType.I18n,
        defaultLocale: isDefaultFromManifest || (!defaultLanguage && index === 0),
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  reportStatus('validating', {
    screenCount: screens.length,
    widgetCount: widgets.length,
    scriptCount: scripts.length,
    translationCount: translations.length,
    appHome,
    defaultLanguage,
  });

  if (typeof appHome === 'string' && appHome.trim() !== '') {
    if (screens.length === 0) {
      throw new Error(
        [
          'Configured a home screen in app config, but no screens were found in the app.',
          'Add at least one screen file under "screens/" (for example "screens/Home.yaml"),',
          'or remove the "appHome" setting from your Ensemble config.',
        ].join(' '),
      );
    }

    const hasHomeScreen = screens.some((screen) => screen.name === appHome);
    if (!hasHomeScreen) {
      throw new Error(
        [
          `Configured home screen "${appHome}" was not found among your screens.`,
          'Create a screen file whose base name matches the home screen',
          `(for example "screens/${appHome}.yaml") or update "appHome" in your Ensemble config.`,
        ].join(' '),
      );
    }
  }

  if (typeof defaultLanguage === 'string' && defaultLanguage.trim() !== '') {
    const hasDefaultLanguage = translations.some(
      (translation) => translation.name === defaultLanguage,
    );

    if (!hasDefaultLanguage) {
      throw new Error(
        [
          `Default language "${defaultLanguage}" is configured, but no matching translation was found.`,
          'Create a translation file whose base name matches the default language',
          `(for example "translations/${defaultLanguage}.yaml") or update "defaultLanguage" in ".manifest.json".`,
        ].join(' '),
      );
    }
  }

  const application: ApplicationDTO = {
    id: appId,
    name: appName,
    createdAt: now,
    updatedAt: now,
    ...(screens.length > 0 && { screens }),
    ...(widgets.length > 0 && { widgets }),
    ...(scripts.length > 0 && { scripts }),
    ...(theme && { theme }),
    ...(translations.length > 0 && { translations }),
  };

  return application;
}

type UpdatedBy = { name: string; email?: string; id: string };

function mergeArtifacts<
  T extends {
    id: string;
    name: string;
    content: string;
    type?: string;
    isArchived?: boolean;
    isRoot?: boolean;
    defaultLocale?: boolean;
  },
>(
  cloudItems: T[] | undefined,
  localItems: T[] | undefined,
  now: string,
  updatedBy: UpdatedBy,
): T[] {
  const localByName = new Map<string, T>();
  for (const item of localItems ?? []) {
    localByName.set(item.name, item);
  }
  const cloudByName = new Set<string>();
  const merged: T[] = [];
  for (const cloud of cloudItems ?? []) {
    cloudByName.add(cloud.name);
    const local = localByName.get(cloud.name);
    const deletedLocally = !local;
    const localWithRoot = local as { isRoot?: boolean; defaultLocale?: boolean } | undefined;
    const cloudWithRoot = cloud as { isRoot?: boolean; defaultLocale?: boolean };
    const localWithArchived = local as { isArchived?: boolean } | undefined;

    merged.push({
      ...cloud,
      content: local?.content ?? cloud.content,
      isArchived: deletedLocally ? true : (localWithArchived?.isArchived ?? false),
      isRoot: deletedLocally ? cloudWithRoot.isRoot : (localWithRoot?.isRoot ?? cloudWithRoot.isRoot),
      defaultLocale: deletedLocally
        ? cloudWithRoot.defaultLocale
        : localWithRoot?.defaultLocale ?? cloudWithRoot.defaultLocale,
      ...(deletedLocally && {
        updatedAt: now,
        updatedBy,
      }),
    });
  }
  for (const local of localItems ?? []) {
    if (!cloudByName.has(local.name)) {
      const localWithType = local as { type?: EnsembleDocumentType };
      let id = local.id;
      if (
        localWithType.type === EnsembleDocumentType.Screen ||
        localWithType.type === EnsembleDocumentType.Widget ||
        localWithType.type === EnsembleDocumentType.Script
      ) {
        id = crypto.randomUUID();
      }
      // For translations and theme we keep the existing id:
      // - translations: i18n_{name}
      // - theme: "theme"
      merged.push({
        ...local,
        id,
        isArchived: false,
        createdAt: now,
        updatedAt: now,
        updatedBy,
      } as T);
    }
  }
  return merged;
}

/**
 * Create a bundle by merging local app (updated content) with cloud app (correct keys/ids).
 * Result: cloud structure + local content where we have local files.
 * @param updatedBy - User info for updatedBy on new/changed artifacts (from CLI config)
 */
export function buildMergedBundle(
  localApp: ApplicationDTO,
  cloudApp: CloudApp,
  updatedBy: { name: string; email?: string; id: string },
): ApplicationDTO {
  const now = new Date().toISOString();

  const screens = mergeArtifacts(
    cloudApp.screens as ScreenDTO[] | undefined,
    localApp.screens,
    now,
    updatedBy,
  ) as ScreenDTO[];
  const widgets = mergeArtifacts(
    cloudApp.widgets as WidgetDTO[] | undefined,
    localApp.widgets,
    now,
    updatedBy,
  ) as WidgetDTO[];
  const scripts = mergeArtifacts(
    cloudApp.scripts as ScriptDTO[] | undefined,
    localApp.scripts,
    now,
    updatedBy,
  ) as ScriptDTO[];
  const translations = mergeArtifacts(
    cloudApp.translations as TranslationDTO[] | undefined,
    localApp.translations,
    now,
    updatedBy,
  ) as TranslationDTO[];

  const theme = localApp.theme ?? cloudApp.theme;

  const result: ApplicationDTO = {
    id: cloudApp.id,
    name: cloudApp.name ?? localApp.name,
    createdAt: cloudApp.createdAt ?? now,
    updatedAt: now,
    ...(screens.length > 0 && { screens }),
    ...(widgets.length > 0 && { widgets }),
    ...(scripts.length > 0 && { scripts }),
    ...(translations.length > 0 && { translations }),
    ...(theme && { theme }),
  };
  return result;
}
