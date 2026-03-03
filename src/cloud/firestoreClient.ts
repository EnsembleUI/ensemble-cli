/**
 * Firestore client for validating app existence and user access.
 * Uses the Firestore REST API with the user's Firebase ID token.
 */

import type {
  ApplicationDTO,
  WidgetDTO,
  ScriptDTO,
  ScreenDTO,
  ThemeDTO,
  TranslationDTO,
} from '../core/dto.js';
import { EnsembleDocumentType } from '../core/dto.js';

const DEFAULT_FIREBASE_PROJECT = 'ensemble-web-studio';

/** Raw Firestore document from list/get API. */
export interface FirestoreDocument {
  name: string;
  fields?: Record<string, unknown>;
}

/** Cloud app in ApplicationDTO shape, aligned with local app structure. */
export type CloudApp = Pick<
  ApplicationDTO,
  | 'id'
  | 'name'
  | 'createdAt'
  | 'updatedAt'
  | 'widgets'
  | 'scripts'
  | 'screens'
  | 'theme'
  | 'translations'
>;

const ALLOWED_ROLES = new Set(['write', 'owner']);

export interface AppInfo {
  name?: string;
  description?: string;
}

export type AppAccessResult =
  | { ok: true; app: AppInfo }
  | { ok: false; reason: 'not_found' | 'no_access' | 'not_logged_in' | 'network_error'; message: string };

function parseFirestoreString(field: { stringValue?: string } | undefined): string | undefined {
  return typeof field?.stringValue === 'string' ? field.stringValue : undefined;
}

function parseFirestoreTimestamp(field: { timestampValue?: string } | undefined): string | undefined {
  const v = field?.timestampValue;
  return typeof v === 'string' ? v : undefined;
}

function parseFirestoreBoolean(field: { booleanValue?: boolean } | undefined): boolean | undefined {
  return typeof field?.booleanValue === 'boolean' ? field.booleanValue : undefined;
}

function parseUpdatedBy(
  field: { mapValue?: { fields?: Record<string, { stringValue?: string }> }; referenceValue?: string } | undefined
): { name: string; email?: string; id: string } | undefined {
  const mapFields = field?.mapValue?.fields;
  if (mapFields) {
    const name = parseFirestoreString(mapFields.name);
    const email = parseFirestoreString(mapFields.email);
    const id = parseFirestoreString(mapFields.id);
    if (name && id) return { name, email, id };
  }
  const ref = field?.referenceValue;
  if (typeof ref === 'string') {
    const id = ref.split('/').pop();
    return id ? { name: id, id } : undefined;
  }
  return undefined;
}

function getDocId(docName: string): string {
  return docName.split('/').pop() ?? docName;
}

type FirestoreFields = Record<
  string,
  | { stringValue?: string }
  | { timestampValue?: string }
  | { booleanValue?: boolean }
  | { mapValue?: { fields?: Record<string, { stringValue?: string }> } }
  | { referenceValue?: string }
>;

function firestoreDocToEnsembleBase(doc: FirestoreDocument): {
  id: string;
  name: string;
  content: string;
  description?: string;
  isRoot?: boolean;
  isDraft?: boolean;
  isArchived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: { name: string; email?: string; id: string };
} {
  const fields = (doc.fields ?? {}) as FirestoreFields;
  const id = getDocId(doc.name);
  const base: ReturnType<typeof firestoreDocToEnsembleBase> = {
    id,
    name: parseFirestoreString(fields.name as { stringValue?: string }) ?? id,
    content: parseFirestoreString(fields.content as { stringValue?: string }) ?? '',
    createdAt: parseFirestoreTimestamp(fields.createdAt as { timestampValue?: string }),
    updatedAt: parseFirestoreTimestamp(fields.updatedAt as { timestampValue?: string }),
  };
  const description = parseFirestoreString(fields.description as { stringValue?: string });
  if (description !== undefined) base.description = description;
  const isArchived = parseFirestoreBoolean(fields.isArchived as { booleanValue?: boolean });
  if (isArchived !== undefined) base.isArchived = isArchived;
  const isRoot = parseFirestoreBoolean(fields.isRoot as { booleanValue?: boolean });
  if (isRoot !== undefined) base.isRoot = isRoot;
  const isDraft = parseFirestoreBoolean(fields.isDraft as { booleanValue?: boolean });
  if (isDraft !== undefined) base.isDraft = isDraft;
  const updatedBy = parseUpdatedBy(
    fields.updatedBy as { mapValue?: { fields?: Record<string, { stringValue?: string }> }; referenceValue?: string }
  );
  if (updatedBy) base.updatedBy = updatedBy;
  return base;
}

function toWidgetDTO(doc: FirestoreDocument): WidgetDTO {
  const base = firestoreDocToEnsembleBase(doc);
  return {
    ...base,
    type: EnsembleDocumentType.Widget,
  };
}

function toScriptDTO(doc: FirestoreDocument): ScriptDTO {
  const base = firestoreDocToEnsembleBase(doc);
  return {
    ...base,
    type: EnsembleDocumentType.Script,
  };
}

function toScreenDTO(doc: FirestoreDocument): ScreenDTO {
  const base = firestoreDocToEnsembleBase(doc);
  return {
    ...base,
    type: EnsembleDocumentType.Screen,
  };
}

function toThemeDTO(doc: FirestoreDocument): ThemeDTO {
  const base = firestoreDocToEnsembleBase(doc);
  return {
    ...base,
    type: EnsembleDocumentType.Theme,
  };
}

function toTranslationDTO(
  doc: FirestoreDocument,
  defaultLocale: boolean,
): TranslationDTO {
  const base = firestoreDocToEnsembleBase(doc);
  return {
    ...base,
    type: EnsembleDocumentType.I18n,
    defaultLocale,
  };
}

function getCollaboratorRole(
  collaboratorsField: { mapValue?: { fields?: Record<string, { stringValue?: string }> } } | undefined,
  userKey: string,
): string | undefined {
  const mapFields = collaboratorsField?.mapValue?.fields;
  if (!mapFields || typeof mapFields !== 'object') return undefined;
  return parseFirestoreString(mapFields[userKey]);
}

/**
 * Check if an app exists in Firestore and the current user has write or owner access.
 * Verifies the user is in collaborators as users_{uid} with "write" or "owner".
 */
export async function checkAppAccess(
  appId: string,
  idToken: string,
  userId: string,
): Promise<AppAccessResult> {
  const project = process.env.ENSEMBLE_FIREBASE_PROJECT ?? DEFAULT_FIREBASE_PROJECT;
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/apps/${appId}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    if (res.ok) {
      const doc = (await res.json()) as {
        fields?: Record<string, { stringValue?: string; mapValue?: { fields?: Record<string, { stringValue?: string }> } }>;
      };
      const fields = doc?.fields ?? {};

      const userKey = `users_${userId}`;
      const role = getCollaboratorRole(fields.collaborators, userKey);
      if (!role || !ALLOWED_ROLES.has(role)) {
        return {
          ok: false,
          reason: 'no_access',
          message: `You do not have write or owner access to app "${appId}".`,
        };
      }

      const app: AppInfo = {
        name: parseFirestoreString(fields.name as { stringValue?: string }),
        description: parseFirestoreString(fields.description as { stringValue?: string }),
      };
      return { ok: true, app };
    }

    if (res.status === 404) {
      return {
        ok: false,
        reason: 'not_found',
        message: `App "${appId}" does not exist.`,
      };
    }

    if (res.status === 403) {
      return {
        ok: false,
        reason: 'no_access',
        message: `You do not have access to app "${appId}".`,
      };
    }

    if (res.status === 401) {
      return {
        ok: false,
        reason: 'not_logged_in',
        message: 'Session expired or invalid. Run `ensemble login` to sign in again.',
      };
    }

    const text = await res.text();
    return {
      ok: false,
      reason: 'network_error',
      message: `Firestore request failed (${res.status}): ${text.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'network_error',
      message: err instanceof Error ? err.message : 'Network request failed.',
    };
  }
}

async function listCollectionDocuments(
  project: string,
  parentPath: string,
  collectionId: string,
  idToken: string,
  filter?: (doc: FirestoreDocument) => boolean,
): Promise<FirestoreDocument[]> {
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${parentPath}/${collectionId}`;
  const docs: FirestoreDocument[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(baseUrl);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${idToken}` },
    });

    if (!res.ok) {
      throw new Error(`Firestore list failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as {
      documents?: FirestoreDocument[];
      nextPageToken?: string;
    };

    for (const doc of body.documents ?? []) {
      if (!filter || filter(doc)) {
        docs.push(doc);
      }
    }
    pageToken = body.nextPageToken;
  } while (pageToken);

  return docs;
}

async function fetchAppDocument(
  project: string,
  appId: string,
  idToken: string,
): Promise<{ id: string; name?: string; createdAt?: string; updatedAt?: string }> {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/apps/${appId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok) throw new Error(`Failed to fetch app: ${res.status}`);
  const doc = (await res.json()) as { name?: string; createTime?: string; updateTime?: string; fields?: FirestoreFields };
  const fields = doc?.fields ?? {};
  return {
    id: appId,
    name: parseFirestoreString(fields.name as { stringValue?: string }),
    createdAt: doc.createTime ?? parseFirestoreTimestamp(fields.createdAt as { timestampValue?: string }),
    updatedAt: doc.updateTime ?? parseFirestoreTimestamp(fields.updatedAt as { timestampValue?: string }),
  };
}

/**
 * Fetch the cloud app and transform to ApplicationDTO shape.
 * - App-level: id, name, createdAt, updatedAt (from app document)
 * - internal_artifacts: scripts, widgets → widgets[], scripts[]
 * - artifacts: screens, appConfig, secrets, theme → screens[], config, secrets, theme
 */
export async function fetchCloudApp(
  appId: string,
  idToken: string,
): Promise<CloudApp> {
  const project = process.env.ENSEMBLE_FIREBASE_PROJECT ?? DEFAULT_FIREBASE_PROJECT;
  const parentPath = `apps/${appId}`;

  const [appDoc, internalArtifacts, artifacts] = await Promise.all([
    fetchAppDocument(project, appId, idToken),
    listCollectionDocuments(project, parentPath, 'internal_artifacts', idToken),
    listCollectionDocuments(project, parentPath, 'artifacts', idToken, (doc) => {
      const docId = getDocId(doc.name);
      return docId !== 'resources';
    }),
  ]);

  const widgets: WidgetDTO[] = [];
  const scripts: ScriptDTO[] = [];
  for (const doc of internalArtifacts) {
    const type = parseFirestoreString((doc.fields?.type as { stringValue?: string }) ?? undefined);
    if (type === 'internal_widget') widgets.push(toWidgetDTO(doc));
    else if (type === 'internal_script') scripts.push(toScriptDTO(doc));
  }

  const screens: ScreenDTO[] = [];
  const translations: TranslationDTO[] = [];
  let theme: ThemeDTO | undefined;
  const i18nDocs: FirestoreDocument[] = [];
  for (const doc of artifacts) {
    const docId = getDocId(doc.name);
    const type = parseFirestoreString((doc.fields?.type as { stringValue?: string }) ?? undefined);
    if (type === 'screen') screens.push(toScreenDTO(doc));
    else if (type === 'i18n') i18nDocs.push(doc);
    else if (docId === 'theme') theme = toThemeDTO(doc);
  }
  const defaultLocaleField = (doc: FirestoreDocument) =>
    parseFirestoreBoolean((doc.fields?.defaultLocale as { booleanValue?: boolean }) ?? undefined);
  for (let i = 0; i < i18nDocs.length; i++) {
    const doc = i18nDocs[i];
    const isDefault = defaultLocaleField(doc) ?? i === 0;
    translations.push(toTranslationDTO(doc, isDefault));
  }

  return {
    id: appDoc.id,
    name: appDoc.name ?? appDoc.id,
    ...(appDoc.createdAt !== undefined && { createdAt: appDoc.createdAt }),
    ...(appDoc.updatedAt !== undefined && { updatedAt: appDoc.updatedAt }),
    widgets,
    scripts,
    screens,
    ...(theme && { theme }),
    ...(translations.length > 0 && { translations }),
  };
}

/**
 * Fetch only the name of the screen with isRoot: true.
 * Uses a minimal Firestore runQuery (type=screen, isRoot=true, limit 1).
 * Parent must be in the URL path for subcollection queries.
 */
export async function fetchRootScreenName(
  appId: string,
  idToken: string,
): Promise<string | undefined> {
  const project = process.env.ENSEMBLE_FIREBASE_PROJECT ?? DEFAULT_FIREBASE_PROJECT;
  const parent = `projects/${project}/databases/(default)/documents/apps/${appId}`;
  const url = `https://firestore.googleapis.com/v1/${parent}:runQuery`;

  const structuredQuery = {
    from: [{ collectionId: 'artifacts' }],
    where: {
      compositeFilter: {
        op: 'AND' as const,
        filters: [
          {
            fieldFilter: {
              field: { fieldPath: 'type' },
              op: 'EQUAL' as const,
              value: { stringValue: 'screen' },
            },
          },
          {
            fieldFilter: {
              field: { fieldPath: 'isRoot' },
              op: 'EQUAL' as const,
              value: { booleanValue: true },
            },
          },
        ],
      },
    },
    limit: 1,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!res.ok) return undefined;

  const body = await res.json();
  const results = Array.isArray(body) ? body : [body];
  const doc = results[0]?.document;
  if (!doc?.fields) return undefined;

  return parseFirestoreString(doc.fields.name as { stringValue?: string });
}
