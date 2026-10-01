import { importHotRuntimeModule } from "../hot-runtime-module";
import type * as Bird from "../bird-retrieval";

export const name = "bird.prepare.v1";
export const description = "Hot-loaded deterministic Bird prepareBirdRetrieval.";
export const version = 1;
const bird = await importHotRuntimeModule<typeof Bird>(new URL("../bird-retrieval.ts", import.meta.url));
export default bird.prepareBirdRetrieval;
