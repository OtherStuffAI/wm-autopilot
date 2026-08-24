import { describe, expect, test } from "bun:test";

import {
  resolveAdapterFactory,
  resolveAgentTransport,
  resolveCodexTransport,
  resolvePiTransport,
  type AdapterSessionContext,
} from "./agent-adapter";

const context: AdapterSessionContext = {
  id: "session-1",
  port: 3700,
  agent: "codex",
  host: "127.0.0.1",
  workingDirectory: "/tmp",
};

describe("Codex transport resolution", () => {
  test("keeps AgentAPI as the default when both flags are off", () => {
    expect(resolveCodexTransport(false, false)).toBe("agentapi");
    expect(resolveAdapterFactory("codex", "agentapi")(context).constructor.name).toBe("AgentApiAdapter");
  });

  test("selects ACP when its flag is on", () => {
    expect(resolveCodexTransport(true, false)).toBe("codex-acp");
    expect(resolveAdapterFactory("codex", "codex-acp")(context).constructor.name).toBe("CodexAcpAdapter");
  });

  test("gives ACP deterministic precedence over the native SDK", () => {
    expect(resolveCodexTransport(true, true)).toBe("codex-acp");
  });

  test("honors a transport pinned on an existing session", () => {
    expect(resolveAgentTransport("codex", "agentapi")).toBe("agentapi");
    expect(resolveAgentTransport("codex", "codex-acp")).toBe("codex-acp");
  });

  test("does not apply a transport pinned for a different agent", () => {
    expect(resolveAgentTransport("goose", "codex-acp")).not.toBe("codex-acp");
  });
});

describe("Pi transport resolution", () => {
  const piContext = { ...context, agent: "pi" as const };

  test("keeps AgentAPI as the default when ACP is off", () => {
    expect(resolvePiTransport(false)).toBe("agentapi");
    expect(resolveAdapterFactory("pi", "agentapi")(piContext).constructor.name).toBe("AgentApiAdapter");
  });

  test("selects Pi ACP only when explicitly enabled", () => {
    expect(resolvePiTransport(true)).toBe("pi-acp");
    expect(resolveAdapterFactory("pi", "pi-acp")(piContext).constructor.name).toBe("PiAcpAdapter");
  });

  test("preserves the historical native transport only when pinned", () => {
    expect(resolveAgentTransport("pi", "pi-native")).toBe("pi-native");
  });
});
