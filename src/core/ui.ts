import pc from 'picocolors';

type MessageKind = 'info' | 'success' | 'warn' | 'error';

const SYMBOLS: Record<MessageKind, string> = {
  info: pc.cyan('ℹ'),
  success: pc.green('✔'),
  warn: pc.yellow('⚠'),
  error: pc.red('✖'),
};

export const ui = {
  heading(message: string): void {
    // Simple bold heading with a subtle divider.
    // eslint-disable-next-line no-console
    console.log('\n' + pc.bold(message));
    // eslint-disable-next-line no-console
    console.log(pc.dim('─'.repeat(Math.min(message.length, 60))));
  },

  note(message: string): void {
    // eslint-disable-next-line no-console
    console.log(pc.dim(message));
  },

  info(message: string): void {
    ui.log('info', message);
  },

  success(message: string): void {
    ui.log('success', message);
  },

  warn(message: string): void {
    ui.log('warn', message);
  },

  error(message: string): void {
    ui.log('error', message);
  },

  log(kind: MessageKind, message: string): void {
    const symbol = SYMBOLS[kind];
    const colored =
      kind === 'info'
        ? pc.cyan(message)
        : kind === 'success'
          ? pc.green(message)
          : kind === 'warn'
            ? pc.yellow(message)
            : pc.red(message);

    // eslint-disable-next-line no-console
    console.log(`${symbol} ${colored}`);
  },
};

