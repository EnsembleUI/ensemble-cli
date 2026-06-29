import crypto from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import type { EnvEntry } from './envConfig.js';

export const ENSEMBLE_ENCRYPTION_KEY_NAME = 'ENSEMBLE_ENCRYPTION_KEY';

const KEY_HINT = 'Get the key from your team, or generate one with: openssl rand -hex 32';

export class EncryptionError extends Error {
  hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'EncryptionError';
    this.hint = hint;
  }
}

interface EncryptedEnvelope {
  v: number;
  alg: 'AES-256-GCM';
  comp: 'br';
  iv: string;
  tag: string;
  ciphertext: string;
}

function throwReleaseKeyError(
  kind: 'missing' | 'invalid' | 'wrong',
  secretsWriteFile: string
): never {
  if (kind === 'missing') {
    throw new EncryptionError(
      `Releases are encrypted. Add ENSEMBLE_ENCRYPTION_KEY to ${secretsWriteFile} before creating or restoring a release.`,
      KEY_HINT
    );
  }
  if (kind === 'invalid') {
    throw new EncryptionError(
      `Invalid ENSEMBLE_ENCRYPTION_KEY in ${secretsWriteFile}. Use a 256-bit key (64 hex characters).`,
      KEY_HINT
    );
  }
  throw new EncryptionError(
    `Could not decrypt this release. ENSEMBLE_ENCRYPTION_KEY in ${secretsWriteFile} does not match the key used when the release was created.`,
    'Get the correct key from your team.'
  );
}

export function parse256BitSecret(value: string, name: string): Buffer {
  const hexLike = /^[0-9a-fA-F]+$/.test(value);
  if (hexLike && value.length === 64) {
    return Buffer.from(value, 'hex');
  }

  try {
    const b64 = Buffer.from(value, 'base64');
    if (b64.length === 32) return b64;
  } catch {
    // ignore invalid base64
  }

  const utf8 = Buffer.from(value, 'utf8');
  if (utf8.length === 32) return utf8;

  throw new EncryptionError(
    `Invalid ${name}: must be 256-bit (32 bytes) as base64, 64-char hex, or 32-byte UTF-8 string.`,
    KEY_HINT
  );
}

export function requireReleaseEncryptionKey(
  envSecrets: EnvEntry[],
  secretsWriteFile: string
): string {
  const entry = envSecrets.find((e) => e.key === ENSEMBLE_ENCRYPTION_KEY_NAME);
  const encryptionKey = typeof entry?.value === 'string' ? entry.value.trim() : '';
  if (!encryptionKey) {
    throwReleaseKeyError('missing', secretsWriteFile);
  }
  try {
    parse256BitSecret(encryptionKey, ENSEMBLE_ENCRYPTION_KEY_NAME);
  } catch (err) {
    if (err instanceof EncryptionError) {
      throwReleaseKeyError('invalid', secretsWriteFile);
    }
    throw err;
  }
  return encryptionKey;
}

function encryptAes256Gcm(plaintext: Buffer, key: Buffer): Omit<EncryptedEnvelope, 'v' | 'comp'> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptAes256Gcm(envelope: EncryptedEnvelope, key: Buffer): Buffer {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function isEncryptedReleaseEnvelope(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return false;
    const envelope = parsed as Partial<EncryptedEnvelope>;
    return (
      envelope.v === 1 &&
      envelope.alg === 'AES-256-GCM' &&
      typeof envelope.iv === 'string' &&
      typeof envelope.tag === 'string' &&
      typeof envelope.ciphertext === 'string'
    );
  } catch {
    return false;
  }
}

export function encryptReleaseSnapshot(plaintextJson: string, encryptionKeyStr: string): string {
  const key = parse256BitSecret(encryptionKeyStr, ENSEMBLE_ENCRYPTION_KEY_NAME);
  const plaintextCompressed = brotliCompressSync(Buffer.from(plaintextJson, 'utf8'), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  });
  const encrypted = encryptAes256Gcm(plaintextCompressed, key);
  const envelope: EncryptedEnvelope = {
    v: 1,
    comp: 'br',
    ...encrypted,
  };
  return JSON.stringify(envelope);
}

export function parseReleaseSnapshotBody(
  body: string,
  snapshotPath: string,
  encryptionKey: string,
  secretsWriteFile = '.env.secrets'
): string {
  if (!isEncryptedReleaseEnvelope(body)) {
    if (snapshotPath.endsWith('.enc.json')) {
      throw new EncryptionError('Invalid encrypted release envelope.');
    }
    throw new EncryptionError(
      'This release is unencrypted legacy plaintext. Re-create it with `ensemble release create` after adding ENSEMBLE_ENCRYPTION_KEY.'
    );
  }

  const parsed = JSON.parse(body) as EncryptedEnvelope;
  const key = parse256BitSecret(encryptionKey, ENSEMBLE_ENCRYPTION_KEY_NAME);
  try {
    const decrypted = decryptAes256Gcm(parsed, key);
    const decompressed = brotliDecompressSync(decrypted);
    return decompressed.toString('utf8');
  } catch {
    throwReleaseKeyError('wrong', secretsWriteFile);
  }
}
