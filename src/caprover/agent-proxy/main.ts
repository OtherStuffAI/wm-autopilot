import { resolve } from "node:path";
import { Nip98ReplayCache } from "../../auth/nip98-verifier";
import { DailyLogWriter } from "../../logging/daily-log-writer";
import { ProxyOperationLog } from "./operation-log";
import { loadProxyConfig } from "./config";
import { createAgentCaproverHandler } from "./service";

const port = Number(process.env.CAPROVER_AGENT_PORT);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("CAPROVER_AGENT_PORT must be an integer from 1024 to 65535");
const stateDirectory = process.env.CAPROVER_AGENT_STATE_DIR;
if (!stateDirectory) throw new Error("CAPROVER_AGENT_STATE_DIR is required for durable replay protection");
const config = loadProxyConfig();
const replayCache = new Nip98ReplayCache(10_000, resolve(stateDirectory, "nip98-replay.sqlite"));
const operationLog = new ProxyOperationLog(resolve(stateDirectory, "operations.sqlite"));
const logger = new DailyLogWriter({ directory: resolve(stateDirectory, "logs"), baseName: "caprover-proxy" });
const server = Bun.serve({
  hostname: "127.0.0.1", port, maxRequestBodySize: 128 * 1024,
  idleTimeout: 60,
  fetch: createAgentCaproverHandler(config, replayCache, operationLog),
});
logger.write("INFO", ["CapRover agent proxy listening", { port: server.port, ready: Boolean(config.allowedNpub && config.publicOrigin && config.target) }]);
