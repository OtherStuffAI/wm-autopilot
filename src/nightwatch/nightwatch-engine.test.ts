import { afterEach, describe, expect, test } from "bun:test";

import { maybeTriggerNightWatch } from "./nightwatch-engine";
import type { NightWatchSessionState } from "./nightwatch-store";
import type { SessionSnapshot } from "../agents/process-manager";

const baseMetadata = {
  AGENT: false,
  billingMode: "subscription" as const,
};

const baseSession: SessionSnapshot = {
  id: "session-1",
  agent: "codex",
  port: 3700,
  name: "nightwatch-worker",
  status: "running",
  agentRuntimeStatus: "stable",
  startedAt: new Date().toISOString(),
  npub: "npub1owner",
  pid: 1234,
  command: ["codex"],
  workingDirectory: "/tmp/project",
  logs: [],
  metadata: baseMetadata,
};

const baseState: NightWatchSessionState = {
  sessionId: "session-1",
  enabled: true,
  cycleCount: 0,
  maxCycles: 21,
  model: "google/gemini-3-flash-preview",
  prompt: "Any progress?",
  intervalMinutes: 5,
  promptAt: new Date(Date.now() - 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("maybeTriggerNightWatch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends a generated reflection prompt without consuming the hook", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const reports: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await maybeTriggerNightWatch(
      {
        ...baseSession,
        metadata: {
          ...baseMetadata,
          goal: "Ship the release",
          nextAction: "reflect",
          nextActionPayload: "Focus on tests first",
        },
      },
      {
        store: {
          getSessionState: () => baseState,
          scheduleNextPrompt: () => {},
          postponePrompt: () => {},
          recordPromptSent: () => 1,
          addReport: (report: Record<string, unknown>) => {
            reports.push(report);
            return report as never;
          },
          disableSession: () => {},
        } as never,
        featureFlagStore: {
          getFlag: () => ({ state: "on" }),
        },
        agentHost: "127.0.0.1",
        getSession: () => ({
          ...baseSession,
          metadata: {
            ...baseMetadata,
            goal: "Ship the release",
            nextAction: "reflect",
            nextActionPayload: "Focus on tests first",
          },
        }),
        updateSessionMetadata: () => baseSession,
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("127.0.0.1");
    expect(requests[0]?.body).toMatchObject({
      type: "user",
    });
    expect(String(requests[0]?.body?.content ?? "")).toContain("Current goal: Ship the release");
    expect(String(requests[0]?.body?.content ?? "")).toContain("Additional context: Focus on tests first");
    expect(reports).toHaveLength(1);
    expect(String(reports[0]?.reasoning ?? "")).toContain('hook "reflect"');
  });

  test("renders a custom reflection template with placeholders", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];

    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    await maybeTriggerNightWatch(
      {
        ...baseSession,
        name: "custom-reflector",
        metadata: {
          ...baseMetadata,
          goal: "Ship the release",
          nextAction: "reflect",
          nextActionPayload: "Focus on tests first",
          nextActionTemplate:
            "Goal: {{goal}}\nSession: {{sessionName}}\nNext move: {{nextActionPayload}}",
        },
      },
      {
        store: {
          getSessionState: () => baseState,
          scheduleNextPrompt: () => {},
          postponePrompt: () => {},
          recordPromptSent: () => 1,
          addReport: () => ({} as never),
          disableSession: () => {},
        } as never,
        featureFlagStore: {
          getFlag: () => ({ state: "on" }),
        },
        agentHost: "127.0.0.1",
        getSession: () => ({
          ...baseSession,
          name: "custom-reflector",
          metadata: {
            ...baseMetadata,
            goal: "Ship the release",
            nextAction: "reflect",
            nextActionPayload: "Focus on tests first",
            nextActionTemplate:
              "Goal: {{goal}}\nSession: {{sessionName}}\nNext move: {{nextActionPayload}}",
          },
        }),
        updateSessionMetadata: () => ({
          ...baseSession,
          name: "custom-reflector",
          metadata: {
            ...baseMetadata,
            goal: "Ship the release",
            nextAction: "none",
            nextActionTemplate:
              "Goal: {{goal}}\nSession: {{sessionName}}\nNext move: {{nextActionPayload}}",
          },
        }),
      },
    );

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.body?.content ?? "")).toBe(
      "Goal: Ship the release\nSession: custom-reflector\nNext move: Focus on tests first",
    );
  });

  test("disables future prompts when the session requests stop", async () => {
    let disableCount = 0;
    let recordPromptSentCount = 0;
    const reports: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;

    await maybeTriggerNightWatch(
      {
        ...baseSession,
        metadata: {
          ...baseMetadata,
          nextAction: "stop",
        },
      },
      {
        store: {
          getSessionState: () => baseState,
          scheduleNextPrompt: () => {},
          postponePrompt: () => {},
          recordPromptSent: () => {
            recordPromptSentCount += 1;
            return 1;
          },
          addReport: (report: Record<string, unknown>) => {
            reports.push(report);
            return report as never;
          },
          disableSession: () => {
            disableCount += 1;
          },
        } as never,
        featureFlagStore: {
          getFlag: () => ({ state: "on" }),
        },
        agentHost: "127.0.0.1",
        getSession: () => ({
          ...baseSession,
          metadata: {
            ...baseMetadata,
            nextAction: "stop",
          },
        }),
      },
    );

    expect(disableCount).toBe(1);
    expect(recordPromptSentCount).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "complete",
      summary: "Night Watch disabled by session metadata hook.",
    });
  });

  test("records an explicit placeholder when the session requests restart", async () => {
    let disableCount = 0;
    let recordPromptSentCount = 0;
    const reports: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;

    await maybeTriggerNightWatch(
      {
        ...baseSession,
        metadata: {
          ...baseMetadata,
          nextAction: "restart",
          nextActionPayload: "resume from clean state",
        },
      },
      {
        store: {
          getSessionState: () => baseState,
          scheduleNextPrompt: () => {},
          postponePrompt: () => {},
          recordPromptSent: () => {
            recordPromptSentCount += 1;
            return 1;
          },
          addReport: (report: Record<string, unknown>) => {
            reports.push(report);
            return report as never;
          },
          disableSession: () => {
            disableCount += 1;
          },
        } as never,
        featureFlagStore: {
          getFlag: () => ({ state: "on" }),
        },
        agentHost: "127.0.0.1",
        getSession: () => ({
          ...baseSession,
          metadata: {
            ...baseMetadata,
            nextAction: "restart",
            nextActionPayload: "resume from clean state",
          },
        }),
      },
    );

    expect(disableCount).toBe(1);
    expect(recordPromptSentCount).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "monitor",
    });
    expect(String(reports[0]?.summary ?? "")).toContain("restart orchestration is not implemented");
    expect(String(reports[0]?.reasoning ?? "")).toContain('hook "restart"');
  });
});
