import { describe, it, expect } from 'vitest';

import {
  encryptReleaseSnapshot,
  EncryptionError,
  isEncryptedReleaseEnvelope,
  parse256BitSecret,
  parseReleaseSnapshotBody,
  requireReleaseEncryptionKey,
} from '../../src/core/encryption.js';
import type { EnvEntry } from '../../src/core/envConfig.js';

export const TEST_ENCRYPTION_KEY = 'a'.repeat(64);
const TEST_SNAPSHOT_PATH = 'releases/app1/ver.enc.json';

describe('encryption', () => {
  it('parse256BitSecret accepts 64-char hex', () => {
    const key = parse256BitSecret(TEST_ENCRYPTION_KEY, 'ENSEMBLE_ENCRYPTION_KEY');
    expect(key).toHaveLength(32);
  });

  it('encryptReleaseSnapshot roundtrips plaintext json', () => {
    const plaintext = JSON.stringify({ id: 'app1', name: 'App' });
    const envelope = encryptReleaseSnapshot(plaintext, TEST_ENCRYPTION_KEY);
    expect(isEncryptedReleaseEnvelope(envelope)).toBe(true);
    expect(parseReleaseSnapshotBody(envelope, TEST_SNAPSHOT_PATH, TEST_ENCRYPTION_KEY)).toBe(
      plaintext
    );
  });

  it('requireReleaseEncryptionKey returns key when present', () => {
    const entries: EnvEntry[] = [{ key: 'ENSEMBLE_ENCRYPTION_KEY', value: TEST_ENCRYPTION_KEY }];
    expect(requireReleaseEncryptionKey(entries, '.env.secrets')).toBe(TEST_ENCRYPTION_KEY);
  });

  it('requireReleaseEncryptionKey throws with secrets file hint when key missing', () => {
    expect(() => requireReleaseEncryptionKey([], '.env.secrets.uat')).toThrow(EncryptionError);
    try {
      requireReleaseEncryptionKey([], '.env.secrets.uat');
    } catch (err) {
      expect(err).toBeInstanceOf(EncryptionError);
      const encErr = err as EncryptionError;
      expect(encErr.message).toContain('.env.secrets.uat');
      expect(encErr.message).toContain('Releases are encrypted');
      expect(encErr.hint).toContain('openssl rand -hex 32');
    }
  });

  it('requireReleaseEncryptionKey throws when key format is invalid', () => {
    const entries: EnvEntry[] = [{ key: 'ENSEMBLE_ENCRYPTION_KEY', value: 'tooshort' }];
    expect(() => requireReleaseEncryptionKey(entries, '.env.secrets')).toThrow(EncryptionError);
    try {
      requireReleaseEncryptionKey(entries, '.env.secrets');
    } catch (err) {
      const encErr = err as EncryptionError;
      expect(encErr.message).toContain('Invalid ENSEMBLE_ENCRYPTION_KEY in .env.secrets');
      expect(encErr.hint).toContain('openssl rand -hex 32');
    }
  });

  it('parseReleaseSnapshotBody throws when encryption key does not match', () => {
    const plaintext = JSON.stringify({ id: 'app1' });
    const envelope = encryptReleaseSnapshot(plaintext, TEST_ENCRYPTION_KEY);
    const wrongKey = `${TEST_ENCRYPTION_KEY.slice(0, -1)}c`;
    expect(() =>
      parseReleaseSnapshotBody(envelope, TEST_SNAPSHOT_PATH, wrongKey, '.env.secrets')
    ).toThrow(EncryptionError);
    try {
      parseReleaseSnapshotBody(envelope, TEST_SNAPSHOT_PATH, wrongKey, '.env.secrets');
    } catch (err) {
      const encErr = err as EncryptionError;
      expect(encErr.message).toContain('Could not decrypt this release');
      expect(encErr.message).toContain('.env.secrets');
      expect(encErr.hint).toContain('Get the correct key from your team');
    }
  });

  it('parseReleaseSnapshotBody rejects legacy plain json', () => {
    expect(() =>
      parseReleaseSnapshotBody('{"id":"app1"}', 'releases/app1/ver.json', TEST_ENCRYPTION_KEY)
    ).toThrow('unencrypted legacy plaintext');
  });
});
