import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import {
  discoverCodexSessionIdForPrompt,
  fingerprintCodexPrompt,
  normaliseCodexPromptForMatch,
} from "./codex-session-discovery";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createCodexHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-discovery-"));
  tempRoots.push(root);
  await mkdir(join(root, "sessions", "2026", "05", "31"), { recursive: true });
  return root;
}

async function writeRollout(
  codexHome: string,
  name: string,
  records: Array<Record<string, unknown>>,
): Promise<string> {
  const filePath = join(codexHome, "sessions", "2026", "05", "31", name);
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return filePath;
}

function sessionMeta(id: string, cwd = "/tmp/project", timestamp = "2026-05-31T01:00:00.000Z") {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      id,
      timestamp,
      cwd,
    },
  };
}

function userMessage(message: string, timestamp = "2026-05-31T01:00:05.000Z") {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "user_message",
      message,
    },
  };
}

describe("Codex session discovery", () => {
  test("normalises and fingerprints prompt text for matching", () => {
    expect(normaliseCodexPromptForMatch("  fix\n\n this\tplease  ")).toBe("fix this please");
    expect(fingerprintCodexPrompt("fix this please")).toBe(fingerprintCodexPrompt(" fix\nthis\tplease "));
  });

  test("finds the unique Codex rollout matching cwd, time, and first user prompt", async () => {
    const codexHome = await createCodexHome();
    const matchedFile = await writeRollout(codexHome, "rollout-match.jsonl", [
      sessionMeta("codex-session-1"),
      userMessage("Implement the persistence fix"),
    ]);
    await writeRollout(codexHome, "rollout-other-cwd.jsonl", [
      sessionMeta("codex-session-2", "/tmp/other"),
      userMessage("Implement the persistence fix"),
    ]);
    await writeRollout(codexHome, "rollout-other-message.jsonl", [
      sessionMeta("codex-session-3"),
      userMessage("Different task"),
    ]);

    const result = await discoverCodexSessionIdForPrompt({
      codexHome,
      workingDirectory: "/tmp/project",
      prompt: "Implement   the\npersistence fix",
      sessionStartedAtMs: Date.parse("2026-05-31T00:59:00.000Z"),
      sentAtMs: Date.parse("2026-05-31T01:00:04.000Z"),
      nowMs: Date.parse("2026-05-31T01:00:10.000Z"),
    });

    expect(result).toEqual({
      sessionId: "codex-session-1",
      filePath: matchedFile,
      reason: "matched",
      candidateCount: 1,
    });
  });

  test("matches an AgentAPI rollout that records the submitted prompt twice", async () => {
    const codexHome = await createCodexHome();
    const prompt = "AGENT DIRECT CHAT\n\nAnswer the latest Flight Deck message.";
    const matchedFile = await writeRollout(codexHome, "rollout-duplicated-prompt.jsonl", [
      sessionMeta("codex-session-duplicated"),
      userMessage(`${prompt}\n\n${prompt}`),
    ]);

    const result = await discoverCodexSessionIdForPrompt({
      codexHome,
      workingDirectory: "/tmp/project",
      prompt,
      sessionStartedAtMs: Date.parse("2026-05-31T00:59:00.000Z"),
      sentAtMs: Date.parse("2026-05-31T01:00:04.000Z"),
      nowMs: Date.parse("2026-05-31T01:00:10.000Z"),
    });

    expect(result).toEqual({
      sessionId: "codex-session-duplicated",
      filePath: matchedFile,
      reason: "matched",
      candidateCount: 1,
    });
  });

  test("matches an AgentAPI rollout that concatenates the submitted prompt twice without a separator", async () => {
    const codexHome = await createCodexHome();
    const prompt = "AGENT DIRECT CHAT\n\nAnswer the latest Flight Deck message.";
    const matchedFile = await writeRollout(codexHome, "rollout-concatenated-prompt.jsonl", [
      sessionMeta("codex-session-concatenated"),
      userMessage(`${prompt}${prompt}`),
    ]);

    const result = await discoverCodexSessionIdForPrompt({
      codexHome,
      workingDirectory: "/tmp/project",
      prompt,
      sessionStartedAtMs: Date.parse("2026-05-31T00:59:00.000Z"),
      sentAtMs: Date.parse("2026-05-31T01:00:04.000Z"),
      nowMs: Date.parse("2026-05-31T01:00:10.000Z"),
    });

    expect(result).toEqual({
      sessionId: "codex-session-concatenated",
      filePath: matchedFile,
      reason: "matched",
      candidateCount: 1,
    });
  });

  test("does not guess when multiple Codex rollouts match", async () => {
    const codexHome = await createCodexHome();
    await writeRollout(codexHome, "rollout-one.jsonl", [
      sessionMeta("codex-session-1"),
      userMessage("continue"),
    ]);
    await writeRollout(codexHome, "rollout-two.jsonl", [
      sessionMeta("codex-session-2"),
      userMessage("continue"),
    ]);

    const result = await discoverCodexSessionIdForPrompt({
      codexHome,
      workingDirectory: "/tmp/project",
      prompt: "continue",
      sessionStartedAtMs: Date.parse("2026-05-31T00:59:00.000Z"),
      sentAtMs: Date.parse("2026-05-31T01:00:04.000Z"),
      nowMs: Date.parse("2026-05-31T01:00:10.000Z"),
    });

    expect(result.reason).toBe("ambiguous");
    expect(result.sessionId).toBeNull();
    expect(result.candidateCount).toBe(2);
  });
});
