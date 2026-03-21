export class AssetClientError extends Error {
  status?: number;
  hint?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cause?: any;

  constructor(params: { message: string; status?: number; hint?: string; cause?: unknown }) {
    super(params.message);
    this.name = 'AssetClientError';
    this.status = params.status;
    this.hint = params.hint;
    this.cause = params.cause;
  }
}

export interface UploadAssetResponse {
  success: boolean;
  assetBaseUrl: string;
  envVariable: {
    key: string;
    value: string;
  };
  usageKey: string;
}

const STUDIO_UPLOAD_ASSET_URL =
  'https://us-central1-ensemble-web-studio.cloudfunctions.net/studio-uploadAsset';

function parseUploadAssetResponse(raw: unknown): UploadAssetResponse {
  const candidate =
    typeof raw === 'object' && raw !== null && 'result' in raw
      ? (raw as { result?: unknown }).result
      : raw;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof (candidate as { success?: unknown }).success !== 'boolean'
  ) {
    throw new AssetClientError({
      message: 'Asset upload response is invalid.',
      cause: raw,
    });
  }
  const payload = candidate as {
    success: boolean;
    assetBaseUrl?: unknown;
    envVariable?: unknown;
    usageKey?: unknown;
  };
  if (!payload.success) {
    throw new AssetClientError({
      message: 'Asset upload failed.',
      cause: raw,
    });
  }
  const envVariable = payload.envVariable as { key?: unknown; value?: unknown } | undefined;
  if (
    typeof payload.assetBaseUrl !== 'string' ||
    !envVariable ||
    typeof envVariable.key !== 'string' ||
    typeof envVariable.value !== 'string' ||
    typeof payload.usageKey !== 'string'
  ) {
    throw new AssetClientError({
      message: 'Asset upload response is missing required fields.',
      cause: raw,
    });
  }
  return {
    success: payload.success,
    assetBaseUrl: payload.assetBaseUrl,
    envVariable: {
      key: envVariable.key,
      value: envVariable.value,
    },
    usageKey: payload.usageKey,
  };
}

export async function uploadAssetToStudio(
  appId: string,
  fileName: string,
  fileDataBase64: string,
  idToken: string
): Promise<UploadAssetResponse> {
  const res = await fetch(STUDIO_UPLOAD_ASSET_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        appId,
        fileName,
        fileData: fileDataBase64,
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
    throw new AssetClientError({
      message: `Asset upload failed (${res.status}).`,
      status: res.status,
      hint:
        res.status === 401 || res.status === 403
          ? 'Authentication/authorization failed for asset upload. Run `ensemble login` and retry.'
          : undefined,
      cause: parsed,
    });
  }

  return parseUploadAssetResponse(parsed);
}
