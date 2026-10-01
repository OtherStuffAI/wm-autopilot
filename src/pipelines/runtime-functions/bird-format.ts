import { importHotRuntimeModule } from "../hot-runtime-module";
import type * as Bird from "../bird-format";

export const name = "bird.format";
export const description = "Hot-loaded deterministic Bird formatBirdRetrieval.";
export const version = 1;
const bird = await importHotRuntimeModule<typeof Bird>(new URL("../bird-format.ts", import.meta.url));
export default bird.formatBirdRetrieval;
