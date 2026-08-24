import { describe, expect, test } from "bun:test";
import {
  countSessionsByLiveTabGroup,
  filterTaskDispatchSessionsForTabs,
  filterSessionsForLiveTabGroup,
  getLiveSessionTabGroup,
  isAgentChatSession,
  isTaskDispatchSession,
  resolveLiveTabGroup,
} from "./session-classification.js";

describe("session-classification", () => {
  const standardSession = {
    id: "standard-1",
    metadata: { role: "user" },
    origin: { type: "cli" },
  };

  const wingmanSession = {
    id: "wingman-1",
    metadata: { role: "agent-chat", agentChatAgentId: "agent_EXAMPLE_AGENT" },
    origin: { type: "agent-chat" },
  };
  const agentWorkSession = {
    id: "agent-work-1",
    metadata: { role: "agent-work" },
    origin: { type: "agent-work" },
  };
  const pipelineStepSession = {
    id: "pipeline-step-1",
    metadata: { role: "pipeline-step" },
    origin: { type: "cli" },
  };

  test("identifies agent-chat sessions from metadata", () => {
    expect(isAgentChatSession(wingmanSession)).toBe(true);
    expect(isAgentChatSession(standardSession)).toBe(false);
  });

  test("identifies task dispatch sessions from metadata and origin", () => {
    expect(isTaskDispatchSession(agentWorkSession)).toBe(true);
    expect(isTaskDispatchSession(pipelineStepSession)).toBe(true);
    expect(isTaskDispatchSession(standardSession)).toBe(false);
  });

  test("filters task dispatch sessions when tab visibility is disabled", () => {
    const sessions = [standardSession, agentWorkSession, pipelineStepSession, wingmanSession];
    expect(filterTaskDispatchSessionsForTabs(sessions, true)).toEqual(sessions);
    expect(filterTaskDispatchSessionsForTabs(sessions, false)).toEqual([standardSession, wingmanSession]);
  });

  test("maps sessions into standard and wingman live groups", () => {
    expect(getLiveSessionTabGroup(wingmanSession)).toBe("wingman");
    expect(getLiveSessionTabGroup(standardSession)).toBe("standard");
  });

  test("filters sessions for the selected live tab group", () => {
    const sessions = [standardSession, wingmanSession];
    expect(filterSessionsForLiveTabGroup(sessions, "all")).toEqual(sessions);
    expect(filterSessionsForLiveTabGroup(sessions, "standard")).toEqual([standardSession]);
    expect(filterSessionsForLiveTabGroup(sessions, "wingman")).toEqual([wingmanSession]);
  });

  test("counts sessions for the live tab group badges", () => {
    expect(countSessionsByLiveTabGroup([standardSession, wingmanSession, wingmanSession])).toEqual({
      all: 3,
      standard: 1,
      wingman: 2,
    });
  });

  test("falls back to the active session group when none is selected yet", () => {
    expect(resolveLiveTabGroup(null, [standardSession, wingmanSession], wingmanSession)).toBe("wingman");
    expect(resolveLiveTabGroup(undefined, [standardSession], null)).toBe("standard");
  });
});
