import { importHotRuntimeModule } from "../hot-runtime-module";
import type * as Bird from "../bird-cli";
export const name = "bird.resolveCli.v1";
export const description = "Validate Jev argument roles and decide whether one extraction fallback is needed.";
export const version = 1;
const bird = await importHotRuntimeModule<typeof Bird>(new URL("../bird-cli.ts", import.meta.url));
export default bird.resolveCliDecision;
