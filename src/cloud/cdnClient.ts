export class CdnClientError extends Error {
  status?: number;
  hint?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cause?: any;

  constructor(params: { message: string; status?: number; hint?: string; cause?: unknown }) {
    super(params.message);
    this.name = 'CdnClientError';
    this.status = params.status;
    this.hint = params.hint;
    this.cause = params.cause;
  }
}

const CREATE_APP_MANIFEST_URL =
  'https://us-central1-ensemble-web-studio.cloudfunctions.net/studio-createAppManifest';

function parseCreateAppManifestResponse(raw: unknown): void {
  if (raw === null || raw === undefined || raw === '') {
    return;
  }

  const candidate =
    typeof raw === 'object' && raw !== null && 'result' in raw
      ? (raw as { result?: unknown }).result
      : raw;

  if (candidate === null || candidate === undefined || candidate === '') {
    return;
  }

  if (typeof candidate !== 'object') {
    throw new CdnClientError({
      message: 'CDN sync response is invalid.',
      cause: raw,
    });
  }

  const success = (candidate as { success?: unknown }).success;
  if (success === false) {
    throw new CdnClientError({
      message: 'CDN sync failed.',
      cause: raw,
    });
  }
}

export async function createAppManifest(appId: string, idToken: string): Promise<void> {
  const res = await fetch(CREATE_APP_MANIFEST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        appId,
      },
    }),
  });

  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    throw new CdnClientError({
      message: `CDN sync failed (${res.status}).`,
      status: res.status,
      hint:
        res.status === 401 || res.status === 403
          ? 'Authentication/authorization failed for CDN sync. Run `ensemble login` and retry.'
          : undefined,
      cause: parsed,
    });
  }

  parseCreateAppManifestResponse(parsed);
}
