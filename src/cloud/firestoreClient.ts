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

type FirestoreValue =
  | { stringValue: string }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { mapValue: { fields: Record<string, FirestoreValue> } }
  | { referenceValue: string };

type FirestoreWriteFields = Record<string, FirestoreValue>;

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

type YamlArtifactPushOperation =
  | {
      operation: 'create';
      document: {
        id: string;
        name: string;
        content: string;
        type: string;
        isRoot?: boolean;
        isArchived?: boolean;
        defaultLocale?: boolean;
        createdAt?: string;
        updatedAt?: string;
        updatedBy?: { name: string; email?: string; id: string };
        createdBy?: { name: string; email?: string; id: string };
        description?: string;
      };
    }
  | {
      operation: 'update';
      id: string;
      history: {
        content: string;
        name: string;
        type: string;
        isRoot?: boolean;
        isArchived?: boolean;
        updatedAt?: string;
        updatedBy?: { name: string; email?: string; id: string };
      };
      updates: {
        content?: string;
        name?: string;
        isRoot?: boolean;
        isArchived?: boolean;
        defaultLocale?: boolean;
        updatedAt?: string;
        updatedBy?: { name: string; email?: string; id: string };
      };
    };

interface PushPayloadShape {
  id: string;
  name?: string;
  updatedAt: string;
  screens?: YamlArtifactPushOperation[];
  widgets?: YamlArtifactPushOperation[];
  scripts?: YamlArtifactPushOperation[];
  translations?: YamlArtifactPushOperation[];
  theme?: YamlArtifactPushOperation;
}

type CreateYamlOp = Extract<YamlArtifactPushOperation, { operation: 'create' }>;
type UpdateYamlOp = Extract<YamlArtifactPushOperation, { operation: 'update' }>;
type UpdateHistory = UpdateYamlOp['history'];
type UpdateUpdates = UpdateYamlOp['updates'];

function assertValidPushPayload(payload: unknown): asserts payload is PushPayloadShape {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid push payload: expected an object.');
  }
  const p = payload as { id?: unknown; updatedAt?: unknown };
  if (typeof p.id !== 'string' || typeof p.updatedAt !== 'string') {
    throw new Error('Invalid push payload: missing or invalid "id" or "updatedAt".');
  }
}

async function processWithConcurrency<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency = 5,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, concurrency);
  let index = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(
      (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const currentIndex = index;
          if (currentIndex >= items.length) break;
          index = currentIndex + 1;
          // eslint-disable-next-line no-await-in-loop
          await worker(items[currentIndex]!);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

async function applyYamlOperationsForKind(
  kind: 'screens' | 'widgets' | 'scripts' | 'translations' | 'theme',
  appId: string,
  idToken: string,
  project: string,
  ops: YamlArtifactPushOperation[] | undefined,
): Promise<void> {
  if (!ops || ops.length === 0) return;
  const { collection } = artifactCollectionAndType(kind);
  const baseCollectionUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/apps/${appId}/${collection}`;

  await processWithConcurrency(ops, async (op) => {
    if (op.operation === 'create') {
      const doc = op.document;
      const fields = encodeYamlDocumentFields(kind, doc);
      const createUrl = `${baseCollectionUrl}?documentId=${encodeURIComponent(doc.id)}`;
      const res = await fetch(createUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Failed to create ${kind.slice(0, -1)} "${doc.name}" (${res.status}): ${text.slice(
            0,
            200,
          )}`,
        );
      }
    } else if (op.operation === 'update') {
      const docId = op.id;
      const docUrl = `${baseCollectionUrl}/${encodeURIComponent(docId)}`;

      // 1) Write history entry
      const historyFields = encodeHistoryFields(op.history);
      const historyUrl = `${docUrl}/history`;
      const historyRes = await fetch(historyUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: historyFields }),
      });
      if (!historyRes.ok) {
        const text = await historyRes.text();
        throw new Error(
          `Failed to write history for ${kind.slice(0, -1)} "${op.history.name}" (${historyRes.status}): ${text.slice(
            0,
            200,
          )}`,
        );
      }

      // 2) Patch main document with partial updates
      const { fields: updateFields, fieldPaths } = encodeUpdateFields(kind, op.updates);
      if (fieldPaths.length === 0) {
        return;
      }
      const params = fieldPaths
        .map((p) => `updateMask.fieldPaths=${encodeURIComponent(p)}`)
        .join('&');
      const patchUrl = `${docUrl}?${params}`;
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: updateFields }),
      });
      if (!patchRes.ok) {
        const text = await patchRes.text();
        throw new Error(
          `Failed to update ${kind.slice(0, -1)} "${op.history.name}" (${patchRes.status}): ${text.slice(
            0,
            200,
          )}`,
        );
      }
    }
  });
}

/**
 * Apply a push payload directly to Firestore, updating YAML artifacts in-place.
 * This updates screens, widgets, scripts, translations, and theme under the app document.
 */
export async function submitCliPush(
  appId: string,
  idToken: string,
  payload: unknown,
): Promise<void> {
  const project = process.env.ENSEMBLE_FIREBASE_PROJECT ?? DEFAULT_FIREBASE_PROJECT;
  assertValidPushPayload(payload);
  const p = payload as PushPayloadShape;

  await applyYamlOperationsForKind('screens', appId, idToken, project, p.screens);
  await applyYamlOperationsForKind('widgets', appId, idToken, project, p.widgets);
  await applyYamlOperationsForKind('scripts', appId, idToken, project, p.scripts);
  await applyYamlOperationsForKind('translations', appId, idToken, project, p.translations);
  if (p.theme) {
    await applyYamlOperationsForKind('theme', appId, idToken, project, [p.theme]);
  }
}

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
  field: { referenceValue?: string } | undefined,
): { name: string; email?: string; id: string } | undefined {
  const ref = field?.referenceValue;
  if (typeof ref === 'string') {
    const id = ref.split('/').pop();
    return id ? { name: id, id } : undefined;
  }
  return undefined;
}

function encodeUpdatedBy(
  updatedBy:
    | { name: string; email?: string; id: string }
    | undefined,
): FirestoreValue | undefined {
  if (!updatedBy) return undefined;
  const project = process.env.ENSEMBLE_FIREBASE_PROJECT ?? DEFAULT_FIREBASE_PROJECT;
  return {
    referenceValue: `projects/${project}/databases/(default)/documents/users/${updatedBy.id}`,
  };
}

function getDocId(docName: string): string {
  return docName.split('/').pop() ?? docName;
}

function artifactCollectionAndType(kind: 'screens' | 'widgets' | 'scripts' | 'translations' | 'theme'): {
  collection: 'artifacts' | 'internal_artifacts';
  typeValue: string | null;
} {
  switch (kind) {
    case 'widgets':
      return { collection: 'internal_artifacts', typeValue: 'internal_widget' };
    case 'scripts':
      return { collection: 'internal_artifacts', typeValue: 'internal_script' };
    case 'screens':
      return { collection: 'artifacts', typeValue: 'screen' };
    case 'translations':
      return { collection: 'artifacts', typeValue: 'i18n' };
    case 'theme':
      return { collection: 'artifacts', typeValue: 'theme' };
  }
}

function encodeYamlDocumentFields(
  kind: 'screens' | 'widgets' | 'scripts' | 'translations' | 'theme',
  doc: CreateYamlOp['document'],
): FirestoreWriteFields {
  const { typeValue } = artifactCollectionAndType(kind);
  const fields: FirestoreWriteFields = {
    name: { stringValue: doc.name },
    content: { stringValue: doc.content },
  };
  if (typeValue) {
    fields.type = { stringValue: typeValue };
  }
  if (typeof doc.description === 'string') {
    fields.description = { stringValue: doc.description };
  }
  if (typeof doc.isRoot === 'boolean') {
    fields.isRoot = { booleanValue: doc.isRoot };
  }
  if (typeof doc.isArchived === 'boolean') {
    fields.isArchived = { booleanValue: doc.isArchived };
  }
  if (typeof doc.defaultLocale === 'boolean') {
    fields.defaultLocale = { booleanValue: doc.defaultLocale };
  }
  if (doc.createdAt) {
    fields.createdAt = { timestampValue: doc.createdAt };
  }
  if (doc.updatedAt) {
    fields.updatedAt = { timestampValue: doc.updatedAt };
  }
  const updatedByVal = encodeUpdatedBy(doc.updatedBy);
  if (updatedByVal) {
    fields.updatedBy = updatedByVal;
  }
   const createdByVal = encodeUpdatedBy(
    (doc as { createdBy?: { name: string; email?: string; id: string } }).createdBy,
  );
  if (createdByVal) {
    fields.createdBy = createdByVal;
  }
  return fields;
}

function encodeHistoryFields(history: UpdateHistory): FirestoreWriteFields {
  const fields: FirestoreWriteFields = {
    name: { stringValue: history.name },
    content: { stringValue: history.content },
    type: { stringValue: history.type },
  };
  if (typeof history.isRoot === 'boolean') {
    fields.isRoot = { booleanValue: history.isRoot };
  }
  if (typeof history.isArchived === 'boolean') {
    fields.isArchived = { booleanValue: history.isArchived };
  }
  if (history.updatedAt) {
    fields.updatedAt = { timestampValue: history.updatedAt };
  }
  const updatedByVal = encodeUpdatedBy(history.updatedBy);
  if (updatedByVal) {
    fields.updatedBy = updatedByVal;
  }
  return fields;
}

function encodeUpdateFields(
  kind: 'screens' | 'widgets' | 'scripts' | 'translations' | 'theme',
  updates: UpdateUpdates,
): { fields: FirestoreWriteFields; fieldPaths: string[] } {
  const { typeValue } = artifactCollectionAndType(kind);
  const fields: FirestoreWriteFields = {};
  const fieldPaths: string[] = [];
  if (typeof updates.name === 'string') {
    fields.name = { stringValue: updates.name };
    fieldPaths.push('name');
  }
  if (typeof updates.content === 'string') {
    fields.content = { stringValue: updates.content };
    fieldPaths.push('content');
  }
  if (typeof updates.isRoot === 'boolean') {
    fields.isRoot = { booleanValue: updates.isRoot };
    fieldPaths.push('isRoot');
  }
  if (typeof updates.isArchived === 'boolean') {
    fields.isArchived = { booleanValue: updates.isArchived };
    fieldPaths.push('isArchived');
  }
  if (typeof updates.defaultLocale === 'boolean') {
    fields.defaultLocale = { booleanValue: updates.defaultLocale };
    fieldPaths.push('defaultLocale');
  }
  if (updates.updatedAt) {
    fields.updatedAt = { timestampValue: updates.updatedAt };
    fieldPaths.push('updatedAt');
  }
  if (updates.updatedBy) {
    const updatedByVal = encodeUpdatedBy(updates.updatedBy);
    if (updatedByVal) {
      fields.updatedBy = updatedByVal;
      fieldPaths.push('updatedBy');
    }
  }
  // Ensure type is set on update if needed (theme / artifacts should already have type, so we skip here).
  if (typeValue && !fieldPaths.includes('type')) {
    // no-op: rely on existing type field
  }
  return { fields, fieldPaths };
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
  createdBy?: { name: string; email?: string; id: string };
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
    fields.updatedBy as {
      mapValue?: { fields?: Record<string, { stringValue?: string }> };
      referenceValue?: string;
    },
  );
  if (updatedBy) base.updatedBy = updatedBy;
  const createdBy = parseUpdatedBy(
    fields.createdBy as {
      mapValue?: { fields?: Record<string, { stringValue?: string }> };
      referenceValue?: string;
    },
  );
  if (createdBy) base.createdBy = createdBy;
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
    else if (type === 'theme') {
      if (!theme || docId === 'theme') {
        theme = toThemeDTO(doc);
      }
    }
  }
  const defaultLocaleField = (doc: FirestoreDocument) =>
    parseFirestoreBoolean((doc.fields?.defaultLocale as { booleanValue?: boolean }) ?? undefined);
  for (let i = 0; i < i18nDocs.length; i++) {
    const doc = i18nDocs[i];
    const isDefault = defaultLocaleField(doc);
    translations.push(
      // Only pass true/false when explicitly stored; otherwise leave undefined
      toTranslationDTO(doc, isDefault === true),
    );
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
