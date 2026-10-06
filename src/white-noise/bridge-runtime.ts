import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nip19 } from "nostr-tools";
import type { ProcessManager } from "../agents/process-manager";
import { CodexAdapter } from "../agents/codex-adapter";
import { ConversationStore } from "./conversation-store";
import { ConversationRouter } from "./conversation-router";
import { ConnectorClient } from "./connector-client";
import { corroborateCompletedText, recoverCodexCompletion } from "./codex-completion-recovery";

const PETE = "npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy";
export function readPrivateFile(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > maxBytes) throw new Error("bridge_configuration_unsafe");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
interface BridgeConfig { connectorSocket: string; connectorTokenFile?: string; account: string; group: string; session: string; }

export function startWhiteNoiseBridge(configPath: string, dataDir: string, getManager: () => ProcessManager, report: (code: string) => void) {
  const config = JSON.parse(readPrivateFile(configPath, 8192)) as BridgeConfig;
  if (!/^[0-9a-f]{64}$/.test(config.account) || !/^(?:[0-9a-f]{2}){1,128}$/.test(config.group) || typeof config.session !== "string" || !config.session) throw new Error("invalid_bridge_configuration");
  const decoded = nip19.decode(PETE);
  if (decoded.type !== "npub") throw new Error("invalid_sender_identity");
  const adapter = () => {
    const session = getManager().getSession(config.session);
    const candidate = getManager().getAdapter(config.session);
    if (!session || session.npub !== PETE || session.origin?.type !== "white-noise" || session.origin.id !== config.group || !(candidate instanceof CodexAdapter)) throw new Error("dedicated_native_session_required");
    return candidate;
  };
  adapter();
  const store = new ConversationStore(join(dataDir, "white-noise-conversation.db"), { account: config.account, group: config.group, session: config.session, sender: decoded.data });
  const connector = new ConnectorClient(config.connectorSocket, config.connectorTokenFile ? readPrivateFile(config.connectorTokenFile, 4096).trim() : undefined);
  const recoverCompletedTurn = async (prompt: string) => {
    adapter();
    const session = getManager().getSession(config.session)!;
    const native = session.metadata?.nativeAgentSession;
    if (!native || native.agent !== "codex") throw new Error("native_completion_context_missing");
    return await recoverCodexCompletion({ sessionId: native.sessionId, workingDirectory: session.workingDirectory }, prompt);
  };
  let turnActive = false;
  const router = new ConversationRouter(store, {
    beforeTurn: async () => {
      const readiness = await adapter().getPromptReadiness();
      if (readiness.state !== "ready") throw new Error("dedicated_session_not_ready");
    },
    completedTurn: async prompt => {
      turnActive = true;
      try {
        const text = await adapter().sendCompletedMessage(prompt);
        return await corroborateCompletedText(prompt, text, recoverCompletedTurn);
      } finally { turnActive = false; }
    },
    recoverCompletedTurn,
    sendFinal: async input => {
      const response = await connector.request({ type: "send_final", account_id_hex: config.account, group_id_hex: config.group,
        text: input.text, reply_to_message_id_hex: input.replyTo, idempotency_key: input.id });
      if (response.type !== "final_sent" || !Array.isArray(response.message_ids_hex) || !response.message_ids_hex.length) throw new Error("durable_delivery_unconfirmed");
    },
  });
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let resolveRetry: (() => void) | undefined;
  const run = async () => {
    while (!stopped) {
      try {
        adapter();
        await router.drain();
        await connector.subscribe(config.account, config.group, async frame => {
          if (frame.type === "resync_required") throw new Error("connector_resync_required");
          if (frame.type !== "inbound_message") return;
          const message = frame.message as { message_id_hex: string; text: string; sender: { account_id_hex: string; is_self: boolean } };
          if (!message || message.sender?.is_self) return;
          store.receive({ account: String(frame.account_id_hex), group: String(frame.group_id_hex), sender: message.sender?.account_id_hex,
            id: message.message_id_hex, text: message.text });
          await router.drain();
        });
      } catch (error) {
        if (stopped) break;
        // Only known static codes are logged; never connector payloads/identifiers.
        report(error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "white_noise_bridge_failed");
        await new Promise<void>(resolve => { resolveRetry = resolve; retry = setTimeout(resolve, 5000); });
      }
    }
  };
  const running = run();
  return { async close() {
    stopped = true; clearTimeout(retry); resolveRetry?.(); connector.close();
    if (turnActive) await adapter().interruptCurrentTurn();
    await running; store.close();
  } };
}
