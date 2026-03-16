import { exec } from 'node:child_process';
import { ui } from '../core/ui.js';

export async function updateCommand(): Promise<void> {
  ui.heading('Updating Ensemble CLI');

  return new Promise((resolve) => {
    const child = exec('npm install -g @ensembleui/cli', (error) => {
      if (error) {
        ui.error('Failed to update @ensembleui/cli automatically.');
        ui.note('Please run the following command manually:');
        // eslint-disable-next-line no-console
        console.log('  npm install -g @ensembleui/cli');
      } else {
        ui.success('Successfully updated @ensembleui/cli to the latest version.');
      }
      resolve();
    });

    if (child.stdout) {
      child.stdout.pipe(process.stdout);
    }
    if (child.stderr) {
      child.stderr.pipe(process.stderr);
    }
  });
}
