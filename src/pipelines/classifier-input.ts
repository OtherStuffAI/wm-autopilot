import { assertObject } from "./declarative";
import type { FunctionRegistry } from "./declarative";
import type { JsonObject } from "./pipeline-store";

export async function prepareClassifierInput(selected: JsonObject, inputFunction: string | undefined, registry: FunctionRegistry): Promise<JsonObject> {
  if (!inputFunction) return selected;
  const fn = registry[inputFunction];
  if (!fn) throw new Error(`Unknown classifier input function: ${inputFunction}`);
  const result = await fn(selected);
  assertObject(result, "classifier prepared input");
  return result;
}
