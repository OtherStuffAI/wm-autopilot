import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/** Check the existing ancestor through the workspace policy before creating anything. */
export async function prepareAgentProfileDirectory(
  directory: string,
  validate?: ((directory: string) => Promise<string>) | null,
): Promise<string> {
  const input = directory.trim();
  if (!isAbsolute(input)) throw new Error("Working folder must be an absolute path.");
  const target = resolve(input);
  let ancestor = target;
  try {
    for (;;) {
      try {
        const info = await stat(ancestor);
        if (!info.isDirectory()) throw new Error(`Path is not a directory: ${ancestor}`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        ancestor = dirname(ancestor);
      }
    }
    await validate?.(ancestor);
    await mkdir(target, { recursive: true });
    return validate ? await validate(target) : target;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Permission denied: cannot create or access working folder ${target}.`, { cause: error });
    }
    throw error;
  }
}
