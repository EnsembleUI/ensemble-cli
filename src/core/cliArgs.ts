/** first top-level subcommand, ignoring global flags (e.g. --debug). */
export function getTopLevelCommand(argv: string[]): string | undefined {
  const args = argv.slice(2);
  return args.find((arg) => !arg.startsWith('-'));
}

export function isUpdateCommand(argv: string[] = process.argv): boolean {
  return getTopLevelCommand(argv) === 'update';
}
