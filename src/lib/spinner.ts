const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r ${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]} ${message}    `);
  }, 80);
  try {
    const result = await fn();
    clearInterval(id);
    process.stdout.write(`\r ✓ ${message}\n`);
    return result;
  } catch (e) {
    clearInterval(id);
    process.stdout.write(`\r ✗ ${message}\n`);
    throw e;
  }
}
