import { importHotRuntimeModule } from "../hot-runtime-module";
import type * as Bird from "../bird-cli";
export const name = "bird.retrieveCli.v1";
export const description = "Validate CLI interpretation and retrieve bounded exact Bird records.";
export const version = 1;
const bird = await importHotRuntimeModule<typeof Bird>(new URL("../bird-cli.ts", import.meta.url));
export default bird.retrieveBirdCli;
