const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function shouldAnimateSpinner(): boolean {
  // Carriage-return animation only works on a real TTY. CI log collectors
  // treat each frame as a new line.
  if (process.env.CI) return false;
  return Boolean(process.stdout.isTTY);
}

function writeDone(ok: boolean, message: string): void {
  const symbol = ok ? '✓' : '✗';
  const prefix = shouldAnimateSpinner() ? '\r' : '';
  process.stdout.write(`${prefix} ${symbol} ${message}\n`);
}

export async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  if (!shouldAnimateSpinner()) {
    try {
      const result = await fn();
      writeDone(true, message);
      return result;
    } catch (e) {
      writeDone(false, message);
      throw e;
    }
  }

  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r ${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]} ${message}    `);
  }, 80);
  try {
    const result = await fn();
    writeDone(true, message);
    return result;
  } catch (e) {
    writeDone(false, message);
    throw e;
  } finally {
    clearInterval(id);
  }
}
