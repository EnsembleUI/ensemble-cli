import { describe, it, expect, afterEach, vi } from 'vitest';
import * as globalConfig from '../../src/config/globalConfig.js';
import { tokenCommand } from '../../src/commands/token.js';
import { ui } from '../../src/core/ui.js';

vi.mock('../../src/config/globalConfig.js', () => ({
  readGlobalConfig: vi.fn(),
}));

describe('token command', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.mocked(globalConfig.readGlobalConfig).mockReset();
  });

  it('prints refresh token when user has one', async () => {
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        idToken: 'id-token',
        refreshToken: 'my-refresh-token-for-ci',
      },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const noteSpy = vi.spyOn(ui, 'note').mockImplementation(() => {});

    await tokenCommand();

    expect(logSpy).toHaveBeenCalledWith('my-refresh-token-for-ci');
    expect(noteSpy).toHaveBeenCalledWith(expect.stringContaining('ENSEMBLE_TOKEN'));
    logSpy.mockRestore();
    noteSpy.mockRestore();
  });

  it('errors and sets exitCode 1 when no refresh token', async () => {
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue(null);

    const errorSpy = vi.spyOn(ui, 'error').mockImplementation(() => {});

    await tokenCommand();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ensemble login'));
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
  });

  it('errors when user has idToken but no refreshToken', async () => {
    vi.mocked(globalConfig.readGlobalConfig).mockResolvedValue({
      user: {
        uid: 'u1',
        idToken: 'id-token',
      },
    });

    const errorSpy = vi.spyOn(ui, 'error').mockImplementation(() => {});

    await tokenCommand();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No token found'));
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
  });
});
