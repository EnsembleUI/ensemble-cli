import { getEnsembleFirebaseProject } from '../config/env.js';

export class StorageClientError extends Error {
  status?: number;
  hint?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cause?: unknown;

  constructor(params: { message: string; status?: number; hint?: string; cause?: unknown }) {
    super(params.message);
    this.name = 'StorageClientError';
    this.status = params.status;
    this.hint = params.hint;
    this.cause = params.cause;
  }
}

export interface UploadReleaseSnapshotResult {
  bucket: string;
  objectPath: string;
}

export function objectPathForRelease(appId: string, versionId: string): string {
  return `releases/${appId}/${versionId}.enc.json`;
}

function storageAuthHeader(idToken: string): string {
  return `Firebase ${idToken}`;
}

async function toStorageError(context: string, res: Response): Promise<StorageClientError> {
  const text = await res.text();
  return new StorageClientError({
    message: `Storage ${context} failed (${res.status})`,
    status: res.status,
    hint:
      res.status === 401 || res.status === 403
        ? 'Authentication/authorization failed for Storage. Check your login session and Storage rules for releases/*.'
        : res.status === 415
          ? 'Storage rejected the upload content type. Retry after updating the CLI.'
          : undefined,
    cause: text.slice(0, 500),
  });
}

function toFetchBody(body: Buffer | string): BodyInit {
  if (typeof body === 'string') return body;
  const arrayBuffer = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength
  ) as ArrayBuffer;
  return new Uint8Array(arrayBuffer);
}

export async function uploadReleaseSnapshot(
  appId: string,
  idToken: string,
  versionId: string,
  body: Buffer | string
): Promise<UploadReleaseSnapshotResult> {
  const bucket = `${getEnsembleFirebaseProject()}.appspot.com`;
  const objectPath = objectPathForRelease(appId, versionId);
  const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
    bucket
  )}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: storageAuthHeader(idToken),
      'Content-Type': 'application/json',
    },
    body: toFetchBody(body),
  });

  if (!res.ok) {
    throw await toStorageError('upload release snapshot', res);
  }

  return { bucket, objectPath };
}

export async function downloadReleaseSnapshotJson(
  idToken: string,
  objectPath: string
): Promise<string> {
  const bucket = `${getEnsembleFirebaseProject()}.appspot.com`;
  const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
    bucket
  )}/o/${encodeURIComponent(objectPath)}?alt=media`;

  const res = await fetch(url, {
    headers: {
      Authorization: storageAuthHeader(idToken),
    },
  });

  if (!res.ok) {
    throw await toStorageError('download release snapshot', res);
  }

  return res.text();
}
