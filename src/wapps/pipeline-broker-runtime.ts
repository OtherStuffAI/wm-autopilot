import { join } from "node:path";
import { appRegistry } from "../apps/app-registry";
import { wappStore } from "./wapp-store";
import { WappPipelineGrantStore } from "./pipeline-grant-store";
import { WappPipelineRequestBroker } from "./pipeline-request-broker";

// Lazy construction: importing a route must not provision credentials or modify DBs.
let broker: WappPipelineRequestBroker | null = null;
export function getWappPipelineBroker() {
  return broker ??= new WappPipelineRequestBroker(
    new WappPipelineGrantStore(join(new URL("../../data/",import.meta.url).pathname,"pipeline-app-grants.sqlite")),
    wappStore,async id=>appRegistry.getApp(id),
  );
}
