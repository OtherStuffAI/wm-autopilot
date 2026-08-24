export interface AppCommand {
  executable: string;
  args: string[];
}

const SAFE_EXECUTABLES = new Set([
  "bun",
  "bunx",
  "cargo",
  "docker-compose",
  "flutter",
  "go",
  "make",
  "node",
  "npm",
  "npx",
  "pip",
  "pip3",
  "pnpm",
  "python",
  "python3",
  "vite",
  "yarn",
]);

const SHELL_SYNTAX = /[;&|<>`$\n\r]/;

export function appCommand(executable: string, ...args: string[]): AppCommand {
  return validateAppCommand({ executable, args });
}

export function validateAppCommand(input: unknown): AppCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Lifecycle commands must be objects with executable and args fields");
  }
  const record = input as Record<string, unknown>;
  const executable = typeof record.executable === "string" ? record.executable.trim() : "";
  if (!executable || executable.includes("\0") || executable.includes("/") || SHELL_SYNTAX.test(executable)) {
    throw new Error("Lifecycle command executable must be a plain executable name");
  }
  if (!Array.isArray(record.args) || !record.args.every((value) => typeof value === "string" && !value.includes("\0"))) {
    throw new Error("Lifecycle command args must be an array of strings");
  }
  return { executable, args: [...record.args] as string[] };
}

export function migrateLegacyAppCommand(input: string): AppCommand | null {
  const command = input.trim();
  if (!command || SHELL_SYNTAX.test(command) || /\s{2,}/.test(command)) return null;
  const parts = command.split(/\s+/);
  const executable = parts.shift() ?? "";
  if (!SAFE_EXECUTABLES.has(executable)) return null;
  try {
    return validateAppCommand({ executable, args: parts });
  } catch {
    return null;
  }
}

export function appCommandsEqual(left: AppCommand | undefined, right: AppCommand | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
