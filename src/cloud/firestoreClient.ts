/**
 * Firestore client for validating app existence and user access.
 * Uses the Firestore REST API with the user's Firebase ID token.
 */

import type {
  ApplicationDTO,
  WidgetDTO,
  ScriptDTO,
  ActionDTO,
  ScreenDTO,
  ThemeDTO,
  TranslationDTO,
} from '../core/dto.js';
import { EnsembleDocumentType } from '../core/dto.js';
import { getArtifactConfig, type ArtifactProp } from '../core/artifacts.js';
import { processWithConcurrency } from '../core/concurrency.js';
import { getEnsembleFirebaseProject } from '../config/env.js';

const DEFAULT_FIRESTORE_CONCURRENCY = 15;

export type FirestoreErrorCode =
  | 'AUTH_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'NETWORK_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'UNKNOWN';

export class FirestoreClientError extends Error {
  code: FirestoreErrorCode;

  status?: number;

  hint?: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cause?: any;

  constructor(params: {
    code: FirestoreErrorCode;
    message: string;
    status?: number;
    hint?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cause?: any;
  }) {
    super(params.message);
    this.name = 'FirestoreClientError';
    this.code = params.code;
    this.status = params.status;
    this.hint = params.hint;
    this.cause = params.cause;
  }
}

export type FirestoreDebugEvent =
  | {
      kind: 'request';
      method: string;
      url: string;
      context: string;
    }
  | {
      kind: 'response';
      method: string;
      url: string;
      status: number;
      context: string;
    }
  | {
      kind: 'list_documents';
      collection: string;
      parentPath: string;
      count: number;
    }
  | {
      kind: 'push_operation';
      appId: string;
      operation: 'create' | 'update';
      artifactKind: ArtifactProp;
      documentId: string;
    };

export interface FirestoreClientOptions {
  debug?: (event: FirestoreDebugEvent) => void;
}

function logDebug(options: FirestoreClientOptions | undefined, event: FirestoreDebugEvent): void {
  if (!options?.debug) return;
  try {
    options.debug(event);
  } catch {
    // Debug logging must never break core behavior.
  }
}

function mapStatusToErrorCode(status: number): FirestoreErrorCode {
  if (status === 401) return 'AUTH_EXPIRED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429 || status === 503) return 'QUOTA_EXCEEDED';
  if (status === 0) return 'NETWORK_UNAVAILABLE';
  return 'UNKNOWN';
}

function defaultHintForCode(code: FirestoreErrorCode): string | undefined {
  if (code === 'AUTH_EXPIRED') {
    return 'Session expired or invalid. Run `ensemble login` and try again.';
  }
  if (code === 'PERMISSION_DENIED') {
    return 'You do not have permission to access this app. Check your account or app sharing settings.';
  }
  if (code === 'NETWORK_UNAVAILABLE') {
    return 'Check your internet connection or proxy settings, then try again.';
  }
  if (code === 'QUOTA_EXCEEDED') {
    return 'You have hit a Firestore quota limit. Try again later or adjust your Firebase project quotas.';
  }
  return undefined;
}

async function toFirestoreError(
  context: string,
  res: Response,
  options?: FirestoreClientOptions,
): Promise<FirestoreClientError> {
  const text = await res.text();
  const code = mapStatusToErrorCode(res.status);
  const hint = defaultHintForCode(code);

  logDebug(options, {
    kind: 'response',
    method: 'UNKNOWN',
    url: res.url ?? '',
    status: res.status,
    context,
  });

  return new FirestoreClientError({
    code,
    status: res.status,
    message: `Firestore ${context} failed (${res.status})`,
    hint,
    cause: text.slice(0, 200),
  });
}

function networkError(context: string, err: unknown): FirestoreClientError {
  const message =
    err instanceof Error && typeof err.message === 'string'
      ? err.message
      : 'Network request failed.';
  return new FirestoreClientError({
    code: 'NETWORK_UNAVAILABLE',
    message: `Firestore ${context} failed: ${message}`,
    cause: err,
  });
}

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
  | 'actions'
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
  | {
      ok: false;
      reason: 'not_found' | 'no_access' | 'not_logged_in' | 'network_error';
      message: string;
      code?: FirestoreErrorCode;
      hint?: string;
      status?: number;
    };

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
        defaultLocale?: boolean;
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
  actions?: YamlArtifactPushOperation[];
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

function getFirestoreConcurrency(): number {
  const raw = process.env.ENSEMBLE_FIRESTORE_CONCURRENCY;
  if (raw === undefined) return DEFAULT_FIRESTORE_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FIRESTORE_CONCURRENCY;
  }
  return Math.floor(parsed);
}

async function applyYamlOperationsForKind(
  kind: 'screens' | 'widgets' | 'scripts' | 'actions' | 'translations' | 'theme',
  appId: string,
  idToken: string,
  project: string,
  ops: YamlArtifactPushOperation[] | undefined,
  options?: FirestoreClientOptions,
): Promise<void> {
  if (!ops || ops.length === 0) return;
  const { collection } = artifactCollectionAndType(kind);
  const baseCollectionUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/apps/${appId}/${collection}`;

  const concurrency = getFirestoreConcurrency();

  await processWithConcurrency(ops, async (op) => {
    if (op.operation === 'create') {
      const doc = op.document;
      const fields = encodeYamlDocumentFields(kind, doc);
      const createUrl = `${baseCollectionUrl}?documentId=${encodeURIComponent(doc.id)}`;
      logDebug(options, {
        kind: 'push_operation',
        appId,
        operation: 'create',
        artifactKind: kind,
        documentId: doc.id,
      });
      logDebug(options, {
        kind: 'request',
        method: 'POST',
        url: createUrl,
        context: 'submitCliPush/create',
      });
      const res = await fetch(createUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) {
        throw await toFirestoreError(
          `create ${kind.slice(0, -1)} "${doc.name}"`,
          res,
          options,
        );
      }
    } else if (op.operation === 'update') {
      const docId = op.id;
      const docUrl = `${baseCollectionUrl}/${encodeURIComponent(docId)}`;

      // 1) Write history entry
      const historyFields = encodeHistoryFields(op.history);
      const historyUrl = `${docUrl}/history`;
      logDebug(options, {
        kind: 'push_operation',
        appId,
        operation: 'update',
        artifactKind: kind,
        documentId: docId,
      });
      logDebug(options, {
        kind: 'request',
        method: 'POST',
        url: historyUrl,
        context: 'submitCliPush/writeHistory',
      });
      const historyRes = await fetch(historyUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: historyFields }),
      });
      if (!historyRes.ok) {
        throw await toFirestoreError(
          `write history for ${kind.slice(0, -1)} "${op.history.name}"`,
          historyRes,
          options,
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
      logDebug(options, {
        kind: 'request',
        method: 'PATCH',
        url: patchUrl,
        context: 'submitCliPush/patchDocument',
      });
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: updateFields }),
      });
      if (!patchRes.ok) {
        throw await toFirestoreError(
          `update ${kind.slice(0, -1)} "${op.history.name}"`,
          patchRes,
          options,
        );
      }
    }
  }, concurrency);
}

/**
 * Apply a push payload directly to Firestore, updating YAML artifacts in-place.
 * This updates screens, widgets, scripts, translations, and theme under the app document.
 */
export async function submitCliPush(
  appId: string,
  idToken: string,
  payload: unknown,
  options?: FirestoreClientOptions,
): Promise<void> {
  const project = getEnsembleFirebaseProject();
  assertValidPushPayload(payload);
  const p = payload as PushPayloadShape;

  await applyYamlOperationsForKind('screens', appId, idToken, project, p.screens, options);
  await applyYamlOperationsForKind('widgets', appId, idToken, project, p.widgets, options);
  await applyYamlOperationsForKind('scripts', appId, idToken, project, p.scripts, options);
  await applyYamlOperationsForKind('actions', appId, idToken, project, p.actions, options);
  await applyYamlOperationsForKind('translations', appId, idToken, project, p.translations, options);
  if (p.theme) {
    await applyYamlOperationsForKind('theme', appId, idToken, project, [p.theme], options);
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
  const project = getEnsembleFirebaseProject();
  return {
    referenceValue: `projects/${project}/databases/(default)/documents/users/${updatedBy.id}`,
  };
}

function getDocId(docName: string): string {
  return docName.split('/').pop() ?? docName;
}

function artifactCollectionAndType(kind: ArtifactProp): {
  collection: 'artifacts' | 'internal_artifacts';
  typeValue: string | null;
} {
  const cfg = getArtifactConfig(kind);
  return {
    collection: cfg.firestoreCollection,
    typeValue: cfg.firestoreType,
  };
}

function encodeYamlDocumentFields(kind: ArtifactProp, doc: CreateYamlOp['document']): FirestoreWriteFields {
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
  const defaultLocale = (history as { defaultLocale?: boolean }).defaultLocale;
  if (typeof defaultLocale === 'boolean') {
    fields.defaultLocale = { booleanValue: defaultLocale };
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
  kind: ArtifactProp,
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

function toActionDTO(doc: FirestoreDocument): ActionDTO {
  const base = firestoreDocToEnsembleBase(doc);
  return {
    ...base,
    type: EnsembleDocumentType.Action,
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
  options?: FirestoreClientOptions,
): Promise<AppAccessResult> {
  const project = getEnsembleFirebaseProject();
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/apps/${appId}`;

  try {
    logDebug(options, {
      kind: 'request',
      method: 'GET',
      url,
      context: 'checkAppAccess',
    });
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    if (res.ok) {
      logDebug(options, {
        kind: 'response',
        method: 'GET',
        url,
        status: res.status,
        context: 'checkAppAccess',
      });
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
          code: 'PERMISSION_DENIED',
          hint: defaultHintForCode('PERMISSION_DENIED'),
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
        code: mapStatusToErrorCode(res.status),
        status: res.status,
      };
    }

    if (res.status === 403) {
      return {
        ok: false,
        reason: 'no_access',
        message: `You do not have access to app "${appId}".`,
        code: mapStatusToErrorCode(res.status),
        status: res.status,
        hint: defaultHintForCode('PERMISSION_DENIED'),
      };
    }

    if (res.status === 401) {
      return {
        ok: false,
        reason: 'not_logged_in',
        message: 'Session expired or invalid. Run `ensemble login` to sign in again.',
        code: mapStatusToErrorCode(res.status),
        status: res.status,
        hint: defaultHintForCode('AUTH_EXPIRED'),
      };
    }

    const text = await res.text();
    return {
      ok: false,
      reason: 'network_error',
      message: `Firestore request failed (${res.status}): ${text.slice(0, 200)}`,
      code: mapStatusToErrorCode(res.status),
      status: res.status,
    };
  } catch (err) {
    const mapped = networkError('checkAppAccess', err);
    return {
      ok: false,
      reason: 'network_error',
      message: mapped.message,
      code: mapped.code,
      hint: mapped.hint,
    };
  }
}

async function listCollectionDocuments(
  project: string,
  parentPath: string,
  collectionId: string,
  idToken: string,
  filter?: (doc: FirestoreDocument) => boolean,
  options?: FirestoreClientOptions,
): Promise<FirestoreDocument[]> {
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${parentPath}/${collectionId}`;
  const docs: FirestoreDocument[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(baseUrl);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    logDebug(options, {
      kind: 'request',
      method: 'GET',
      url: url.toString(),
      context: 'listCollectionDocuments',
    });
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${idToken}` },
    });

    if (!res.ok) {
      throw await toFirestoreError('list collection documents', res, options);
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
    logDebug(options, {
      kind: 'list_documents',
      collection: collectionId,
      parentPath,
      count: body.documents?.length ?? 0,
    });
    pageToken = body.nextPageToken;
  } while (pageToken);

  return docs;
}

async function fetchAppDocument(
  project: string,
  appId: string,
  idToken: string,
  options?: FirestoreClientOptions,
): Promise<{ id: string; name?: string; createdAt?: string; updatedAt?: string }> {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/apps/${appId}`;
  logDebug(options, {
    kind: 'request',
    method: 'GET',
    url,
    context: 'fetchAppDocument',
  });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok) {
    throw await toFirestoreError('fetch app document', res, options);
  }
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
  options?: FirestoreClientOptions,
): Promise<CloudApp> {
  const project = getEnsembleFirebaseProject();
  const parentPath = `apps/${appId}`;

  const [appDoc, internalArtifacts, artifacts] = await Promise.all([
    fetchAppDocument(project, appId, idToken, options),
    listCollectionDocuments(project, parentPath, 'internal_artifacts', idToken, undefined, options),
    listCollectionDocuments(
      project,
      parentPath,
      'artifacts',
      idToken,
      (doc) => {
        const docId = getDocId(doc.name);
        return docId !== 'resources';
      },
      options,
    ),
  ]);

  const widgets: WidgetDTO[] = [];
  const scripts: ScriptDTO[] = [];
  const actions: ActionDTO[] = [];
  for (const doc of internalArtifacts) {
    const type = parseFirestoreString((doc.fields?.type as { stringValue?: string }) ?? undefined);
    if (type === 'internal_widget') widgets.push(toWidgetDTO(doc));
    else if (type === 'internal_script') scripts.push(toScriptDTO(doc));
    else if (type === 'internal_action') actions.push(toActionDTO(doc));
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
    // Actions are stored as internal_artifacts with type=internal_action.
    ...(actions.length > 0 && { actions }),
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
  options?: FirestoreClientOptions,
): Promise<string | undefined> {
  const project = getEnsembleFirebaseProject();
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

  logDebug(options, {
    kind: 'request',
    method: 'POST',
    url,
    context: 'fetchRootScreenName',
  });
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
