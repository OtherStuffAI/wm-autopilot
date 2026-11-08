/** Validate command-local options without changing other CLIs' parsers. */
export function parseCommandOptions(args: string[], allowed: Record<string, "value" | "boolean">) {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("-")) { positional.push(token); continue; }
    const kind = allowed[token];
    if (!kind) throw new Error(`Unknown option: ${token}`);
    if (token in options) throw new Error(`Duplicate option: ${token}`);
    if (kind === "boolean") { options[token] = true; continue; }
    const value = args[++i];
    if (!value?.trim() || value.startsWith("--")) throw new Error(`${token} requires a value`);
    options[token] = value;
  }
  return { positional, options };
}

export function validateCommandArguments(command: string, args: string[], counts: Record<string, number>): void {
  const count = counts[command];
  if (count === undefined) throw new Error(`Unknown command: ${command}`);
  if (args.length !== count) throw new Error(`${command} requires ${count - 1} argument(s); received ${args.length - 1}`);
}

export function ownerApiPath(path: string, owner?: string): string {
  return owner ? `/api/owners/${encodeURIComponent(owner)}${path.slice(4)}` : path;
}
