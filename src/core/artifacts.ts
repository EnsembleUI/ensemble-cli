import { EnsembleDocumentType } from './dto.js';

/**
 * Central registry for all artifact kinds handled by the CLI.
 *
 * This is the single source of truth for:
 * - Property names on ApplicationDTO / CloudApp
 * - Filesystem layout (directories + extensions)
 * - Firestore collection + type mapping
 * - Human‑readable labels
 *
 * Adding a new artifact kind should be as simple as adding one entry here.
 */

export const ArtifactProps = [
  'screens',
  'widgets',
  'scripts',
  'actions',
  'translations',
  'theme',
] as const;

export type ArtifactProp = (typeof ArtifactProps)[number];

export interface ArtifactConfig {
  /** Property name on ApplicationDTO / CloudApp. */
  readonly prop: ArtifactProp;
  /** Human‑readable singular label (used in logs, summaries, etc.). */
  readonly label: string;
  /** Top‑level directory name for local files (if any). */
  readonly fsDir?: string;
  /** File extension (including dot) for local files (if any). */
  readonly fileExtension?: string;
  /** Whether this represents the singleton theme artifact. */
  readonly isTheme?: boolean;
  /** Firestore collection for this artifact kind. */
  readonly firestoreCollection: 'artifacts' | 'internal_artifacts';
  /** Firestore `type` field value for documents of this kind. */
  readonly firestoreType: EnsembleDocumentType | 'i18n' | 'theme';
}

const ARTIFACT_CONFIGS_ARRAY: readonly ArtifactConfig[] = [
  {
    prop: 'screens',
    label: 'screen',
    fsDir: 'screens',
    fileExtension: '.yaml',
    firestoreCollection: 'artifacts',
    firestoreType: EnsembleDocumentType.Screen,
  },
  {
    prop: 'widgets',
    label: 'widget',
    fsDir: 'widgets',
    fileExtension: '.yaml',
    firestoreCollection: 'internal_artifacts',
    firestoreType: EnsembleDocumentType.Widget,
  },
  {
    prop: 'scripts',
    label: 'script',
    fsDir: 'scripts',
    fileExtension: '.js',
    firestoreCollection: 'internal_artifacts',
    firestoreType: EnsembleDocumentType.Script,
  },
  {
    prop: 'actions',
    label: 'action',
    fsDir: 'actions',
    fileExtension: '.yaml',
    firestoreCollection: 'internal_artifacts',
    firestoreType: EnsembleDocumentType.Action,
  },
  {
    prop: 'translations',
    label: 'translation',
    fsDir: 'translations',
    fileExtension: '.yaml',
    firestoreCollection: 'artifacts',
    firestoreType: EnsembleDocumentType.I18n,
  },
  {
    prop: 'theme',
    label: 'theme',
    // Theme is a singleton file at project root (theme.yaml / theme.yml),
    // so it intentionally has no fsDir.
    fileExtension: '.yaml',
    isTheme: true,
    firestoreCollection: 'artifacts',
    firestoreType: EnsembleDocumentType.Theme,
  },
] as const;

export const ARTIFACT_CONFIGS: readonly ArtifactConfig[] = ARTIFACT_CONFIGS_ARRAY;

const ARTIFACT_CONFIG_BY_PROP: Record<ArtifactProp, ArtifactConfig> = ARTIFACT_CONFIGS_ARRAY.reduce(
  (acc, cfg) => {
    acc[cfg.prop] = cfg;
    return acc;
  },
  {} as Record<ArtifactProp, ArtifactConfig>
);

export function getArtifactConfig(prop: ArtifactProp): ArtifactConfig {
  return ARTIFACT_CONFIG_BY_PROP[prop];
}

/** Projection used by sync / pull logic for filesystem comparison. */
export interface ArtifactFsConfig {
  readonly prop: ArtifactProp;
  readonly ext?: string;
  readonly isTheme?: boolean;
}

export const ARTIFACT_FS_CONFIG: readonly ArtifactFsConfig[] = ARTIFACT_CONFIGS.map((cfg) => ({
  prop: cfg.prop,
  ext: cfg.isTheme ? undefined : cfg.fileExtension,
  isTheme: cfg.isTheme,
}));
