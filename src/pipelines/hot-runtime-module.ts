import { createHash } from "node:crypto";
import { runtimeFunctionHash } from "./pipeline-function-pins";
import { writeFile, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** Opt-in reload for a runtime function's local helper graph, excluding packages. */
export async function importHotRuntimeModule<T>(source: URL): Promise<T> {
  const path = fileURLToPath(source);
  const build = await Bun.build({ entrypoints: [path], target: "bun", packages: "external" });
  if (!build.success) throw new Error(`Runtime helper bundle failed: ${build.logs.map(String).join("; ")}`);
  const output = build.outputs[0];
  if (!output) throw new Error("Runtime helper bundle produced no module");
  const snapshot = join(dirname(path), `.wingmen-hot-${basename(path)}-${crypto.randomUUID()}.mjs`);
  try {
    const source = await output.text();
    await writeFile(snapshot, source, { flag: "wx" });
    const module = await import(pathToFileURL(snapshot).href);
    const hash = createHash("sha256").update(source).digest("hex");
    for (const value of Object.values(module)) {
      if (typeof value === "function") Object.defineProperty(value, runtimeFunctionHash, { value: hash });
    }
    return module as T;
  } finally {
    await unlink(snapshot);
  }
}
