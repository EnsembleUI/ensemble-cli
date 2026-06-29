import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchLatestStableEnsembleReleaseRef,
  getStableReleaseTag,
} from '../../src/core/ensembleRelease.js';

describe('ensembleRelease', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getStableReleaseTag', () => {
    it('accepts stable releases', () => {
      expect(
        getStableReleaseTag({ tag_name: 'ensemble-v1.2.48', prerelease: false, draft: false })
      ).toBe('ensemble-v1.2.48');
    });

    it('rejects prerelease and draft tags', () => {
      expect(
        getStableReleaseTag({ tag_name: 'ensemble-v1.2.47-beta.1', prerelease: true, draft: false })
      ).toBeNull();
      expect(
        getStableReleaseTag({ tag_name: 'ensemble-v1.2.48', prerelease: false, draft: true })
      ).toBeNull();
    });
  });

  describe('fetchLatestStableEnsembleReleaseRef', () => {
    it('returns latest stable tag from GitHub', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: 'ensemble-v1.2.48', prerelease: false, draft: false }),
      } as Response);

      await expect(fetchLatestStableEnsembleReleaseRef()).resolves.toBe('ensemble-v1.2.48');
    });
  });
});
