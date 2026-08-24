const SHELL_SYNTAX = /[;&|<>`$\n\r]/;

export function formatLifecycleCommand(command) {
  if (!command || typeof command !== "object" || typeof command.executable !== "string") return "";
  const args = Array.isArray(command.args) ? command.args : [];
  return [command.executable, ...args].join(" ");
}

export function parseLifecycleCommand(value) {
  const command = String(value ?? "").trim();
  if (!command) return null;
  if (SHELL_SYNTAX.test(command) || /["']/.test(command)) {
    throw new Error("Lifecycle commands must be a single executable with plain argv; shell syntax is not allowed.");
  }
  const [executable, ...args] = command.split(/\s+/);
  if (!executable || executable.includes("/")) {
    throw new Error("Lifecycle commands require a plain executable name.");
  }
  return { executable, args };
}
