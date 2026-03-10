import { readGlobalConfig, clearUserAuth } from '../config/globalConfig.js';
import { ui } from '../core/ui.js';

export async function logoutCommand(): Promise<void> {
  const config = await readGlobalConfig();
  const email = config?.user?.email;
  await clearUserAuth();
  ui.success(email ? `Logged out (${email}).` : 'Logged out.');
}
