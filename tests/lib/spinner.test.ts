import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withSpinner } from '../../src/lib/spinner.js';

describe('withSpinner', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('returns the result of the async function', async () => {
    const result = await withSpinner('Loading', async () => {
      return 42;
    });

    expect(result).toBe(42);
  });

  it('calls the function and writes success message', async () => {
    await withSpinner('Test', async () => 'done');

    expect(writeSpy).toHaveBeenCalled();
    const calls = writeSpy.mock.calls.map((c) => c[0]);
    expect(calls.some((s) => typeof s === 'string' && s.includes('✓') && s.includes('Test'))).toBe(true);
  });

  it('rethrows when function throws', async () => {
    await expect(
      withSpinner('Fail', async () => {
        throw new Error('oops');
      }),
    ).rejects.toThrow('oops');

    const calls = writeSpy.mock.calls.map((c) => c[0]);
    expect(calls.some((s) => typeof s === 'string' && s.includes('✗'))).toBe(true);
  });
});
