import { readGlobalConfig, clearUserAuth } from '../config/globalConfig.js';

export async function logoutCommand(): Promise<void> {
  const config = await readGlobalConfig();
  const email = config?.user?.email;
  await clearUserAuth();
  console.log(email ? `Logged out (${email}).` : 'Logged out.');
}
