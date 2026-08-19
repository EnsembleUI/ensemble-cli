import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withSpinner } from '../../src/lib/spinner.js';

describe('withSpinner', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;
  let originalCI: string | undefined;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true) as ReturnType<
      typeof vi.spyOn
    >;
    originalIsTTY = process.stdout.isTTY;
    originalCI = process.env.CI;
    delete process.env.CI;
  });

  afterEach(() => {
    writeSpy.mockRestore();
    vi.useRealTimers();
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
  });

  function writtenChunks(): string[] {
    return writeSpy.mock.calls.map((c) => String(c[0]));
  }

  it('returns the result of the async function', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const result = await withSpinner('Loading', async () => {
      return 42;
    });

    expect(result).toBe(42);
  });

  it('calls the function and writes success message', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    await withSpinner('Test', async () => 'done');

    expect(writeSpy).toHaveBeenCalled();
    const calls = writtenChunks();
    expect(calls.some((s) => s.includes('✓') && s.includes('Test'))).toBe(true);
  });

  it('rethrows when function throws', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    await expect(
      withSpinner('Fail', async () => {
        throw new Error('oops');
      })
    ).rejects.toThrow('oops');

    const calls = writtenChunks();
    expect(calls.some((s) => s.includes('✗'))).toBe(true);
  });

  it('does not animate spinner frames when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    vi.useFakeTimers();

    let resolveFn!: (value: string) => void;
    const pending = withSpinner(
      'Preparing app for push...',
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        })
    );

    await vi.advanceTimersByTimeAsync(400);
    resolveFn('ok');
    await pending;

    const calls = writtenChunks();
    expect(calls.some((s) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(s))).toBe(false);
    expect(calls.filter((s) => s.includes('Preparing app for push...'))).toHaveLength(1);
    expect(calls.some((s) => s.includes('✓') && s.includes('Preparing app for push...'))).toBe(
      true
    );
  });

  it('does not animate when CI is set even if stdout is a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.CI = 'true';
    vi.useFakeTimers();

    let resolveFn!: (value: string) => void;
    const pending = withSpinner(
      'Loading',
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        })
    );

    await vi.advanceTimersByTimeAsync(400);
    resolveFn('ok');
    await pending;

    expect(writtenChunks().some((s) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(s))).toBe(false);
  });

  it('animates spinner frames on a TTY outside CI', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.useFakeTimers();

    let resolveFn!: (value: string) => void;
    const pending = withSpinner(
      'Loading',
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        })
    );

    await vi.advanceTimersByTimeAsync(200);
    resolveFn('ok');
    await pending;

    const calls = writtenChunks();
    expect(calls.some((s) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(s))).toBe(true);
    expect(calls.some((s) => s.includes('✓') && s.includes('Loading'))).toBe(true);
  });
});
