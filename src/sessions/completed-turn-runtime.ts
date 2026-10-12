import { createHash } from "node:crypto";
import type { AgentAdapter } from "../agents/agent-adapter.ts";
import type { SessionApiContext } from "../server/session-api-routes.ts";
import { waitForSessionPromptReadiness } from "../server/session-readiness.ts";
import { resolveSessionOwnerNpub } from "./session-ownership.ts";
import { resolveNativeResumeLaunch, type NativeResumeSourceSession } from "./native-resume-launch.ts";
import { nativeTurnCheckpoint, recoverNativeTurn } from "./completed-turn-recovery.ts";
import type { CompletedTurnRequest } from "./completed-turn-contract.ts";
import type { CompletedTurnRuntime } from "./completed-turn-service.ts";
import type { TurnBinding } from "./completed-turn-store.ts";

export function completedTurnBindingId(owner: string, key: string): string {
  return createHash("sha256").update(JSON.stringify([owner, key])).digest("hex");
}

/** Only an owned dedicated native session may participate; no submission adapter fallback. */
export function createCompletedTurnRuntime(ctx: SessionApiContext): CompletedTurnRuntime {
  function source(id: string): NativeResumeSourceSession {
    const session = ctx.manager.getSession(id) ?? ctx.messageStore.getSession(id) ?? ctx.sessionArchiveStore?.getArchivedSession(id);
    if (!session) throw new Error("Completed-turn bound session unavailable");
    return session;
  }
  function authorized(session: NativeResumeSourceSession, request: CompletedTurnRequest, owner: string): void {
    if (resolveSessionOwnerNpub(session.npub ?? null, session.metadata) !== owner) throw new Error("Completed-turn session ownership denied");
    if (session.agent !== "codex" || session.workingDirectory !== request.directory ||
      session.metadata?.agentTransport !== "codex-sdk" || session.metadata?.role !== "completed-turn" ||
      session.metadata?.bindingId !== completedTurnBindingId(owner, request.conversationKey)) {
      throw new Error("Completed turns require the matching dedicated Codex SDK conversation");
    }
  }
  function adapter(id: string): AgentAdapter & { sendCompletedMessage: (prompt: string) => Promise<string> } {
    const candidate = ctx.manager.getAdapter(id);
    if (!candidate?.sendCompletedMessage) throw new Error("Bound transport has no native completed-turn capability");
    return candidate as AgentAdapter & { sendCompletedMessage: (prompt: string) => Promise<string> };
  }
  function nativeContext(id: string) {
    const session = source(id);
    const native = session.metadata?.nativeAgentSession;
    if (native?.agent !== "codex" || !native.sessionId || native.workingDirectory !== session.workingDirectory) {
      throw new Error("Bound native conversation reference missing or inconsistent");
    }
    return { nativeSessionId: native.sessionId, directory: session.workingDirectory! };
  }
  async function prepare(binding: TurnBinding, request: CompletedTurnRequest, recovering: boolean): Promise<string> {
    let id = binding.sessionId;
    if (!id && recovering) {
      const candidates = ctx.messageStore.listSessions().filter((session) =>
        session.metadata?.role === "completed-turn" && session.metadata.bindingId === completedTurnBindingId(binding.owner, binding.conversationKey));
      if (candidates.length !== 1) throw new Error("Completed-turn launch outcome uncertain; requires session binding recovery");
      id = candidates[0]!.id;
    }
    if (id) {
      const existing = source(id);
      authorized(existing, request, binding.owner);
      const live = ctx.manager.getSession(id);
      if (live && live.status !== "stopped" && live.status !== "error") {
        adapter(id);
        return id;
      }
      const launch = resolveNativeResumeLaunch(existing, ctx.isAgentType, binding.owner);
      if (recovering) {
        const resumedCandidates = ctx.messageStore.listSessions().filter((session) =>
          session.metadata?.resumedFromWingmanSessionId === id && session.metadata?.role === "completed-turn" &&
          session.metadata.bindingId === completedTurnBindingId(binding.owner, binding.conversationKey));
        if (resumedCandidates.length !== 1) throw new Error("Completed-turn resume launch outcome uncertain; requires session binding recovery");
        const candidate = resumedCandidates[0]!;
        authorized(candidate, request, binding.owner);
        if (candidate.metadata?.nativeAgentSession?.sessionId !== launch.metadata.nativeAgentSession?.sessionId) {
          throw new Error("Completed-turn recovered resume native reference changed");
        }
        const resumedLive = ctx.manager.getSession(candidate.id);
        if (!resumedLive || resumedLive.status === "stopped" || resumedLive.status === "error") {
          throw new Error("Completed-turn recovered resume process unavailable; requires operator recovery");
        }
        adapter(candidate.id);
        return candidate.id;
      }
      const resumed = await ctx.manager.createSession(launch.agent, launch.workingDirectory, launch.name, launch.origin,
        undefined, binding.owner, { ...launch.metadata, nextAction: "none", autoStop: false }, request.model ?? undefined);
      record(resumed.id);
      return resumed.id;
    }
    const created = await ctx.manager.createSession("codex", request.directory, "Native completed-turn conversation", null,
      undefined, binding.owner, {
        AGENT: true, agentTransport: "codex-sdk", role: "completed-turn", nextAction: "none", autoStop: false,
        ownerNpub: binding.owner, bindingId: completedTurnBindingId(binding.owner, binding.conversationKey),
      }, request.model ?? undefined);
    record(created.id);
    return created.id;
  }
  function record(id: string): void {
    const session = ctx.manager.getSession(id);
    if (!session) throw new Error("Completed-turn launched session missing");
    ctx.messageStore.recordSession({ ...session, runtimeStatus: session.agentRuntimeStatus ?? null });
  }
  return {
    authorize: async (request, owner) => {
      if (request.sessionId) authorized(source(request.sessionId), request, owner);
    },
    prepare,
    ready: async (id) => {
      if (ctx.promptQueueStore.getQueueCount(id)) throw new Error("Completed-turn session has unrelated queued prompts");
      adapter(id);
      await waitForSessionPromptReadiness({ getSession: (sessionId) => ctx.manager.getSession(sessionId) ?? null,
        getAdapter: (sessionId) => ctx.manager.getAdapter(sessionId), sessionId: id, host: ctx.agentHost,
        timeoutMs: 120_000, pollIntervalMs: 250, requiredStablePolls: 1 });
    },
    checkpoint: async (id) => {
      const native = source(id).metadata?.nativeAgentSession;
      if (!native?.sessionId) return { nativeSessionId: null, count: 0 };
      const context = nativeContext(id);
      return { nativeSessionId: context.nativeSessionId, count: await nativeTurnCheckpoint(context) };
    },
    send: async (id, prompt) => {
      const reply = await adapter(id).sendCompletedMessage(prompt);
      const context = nativeContext(id);
      record(id);
      await ctx.syncSessionMessages(id, true);
      return { reply, nativeSessionId: context.nativeSessionId };
    },
    recover: async (row) => {
      if (!row.sessionId || row.checkpoint === null) throw new Error("Completed-turn recovery checkpoint unavailable");
      const session = source(row.sessionId);
      const binding: CompletedTurnRequest = { conversationKey: row.conversationKey, requestId: row.requestId,
        projectId: row.projectId, prompt: row.prompt, directory: session.workingDirectory!, sessionId: row.sessionId, model: null,
        executionProfile: null, projectFiles: null, durationMs: null };
      authorized(session, binding, row.owner);
      const liveAdapter = ctx.manager.getAdapter(row.sessionId);
      if (liveAdapter && (await liveAdapter.getPromptReadiness?.())?.state !== "ready") {
        throw new Error("Completed-turn delivery remains active; recovery refused");
      }
      const context = nativeContext(row.sessionId);
      if (row.nativeSessionId && row.nativeSessionId !== context.nativeSessionId) throw new Error("Completed-turn native conversation changed");
      const reply = await recoverNativeTurn(context, row.checkpoint, row.prompt);
      return reply === null ? null : { reply, nativeSessionId: context.nativeSessionId };
    },
  };
}
