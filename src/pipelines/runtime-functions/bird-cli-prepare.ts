import { importHotRuntimeModule } from "../hot-runtime-module";
import type * as Bird from "../bird-cli";
export const name = "bird.prepareCli.v1";
export const description = "Prepare registered CLI contract candidates, excluding routing mentions.";
export const version = 1;
const bird = await importHotRuntimeModule<typeof Bird>(new URL("../bird-cli.ts", import.meta.url));
export default bird.prepareBirdCli;
