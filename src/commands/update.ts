import { exec } from 'node:child_process';

export async function updateCommand(): Promise<void> {
  return new Promise((resolve) => {
    const child = exec('npm install -g @ensembleui/cli', (error) => {
      if (error) {
        console.error('Failed to update @ensembleui/cli automatically.');
        console.error('Please run the following command manually:');
        console.error('  npm install -g @ensembleui/cli');
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

