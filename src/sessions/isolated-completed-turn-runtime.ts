import { runIsolatedCodex } from "../isolation/isolated-codex.ts";
import { validateSnapshot, type ProjectFile } from "../isolation/project-profile.ts";
import type { ProjectProvider } from "../isolation/provider-policy.ts";
import { createResponsesProvider } from "../isolation/responses-provider.ts";
import type { CompletedTurnRuntime } from "./completed-turn-service.ts";
import type { IsolatedTurnStore, IsolatedTurnState } from "./isolated-turn-store.ts";

export interface IsolatedTurnConfiguration { image: string; provider: ProjectProvider; }

/** Dedicated, explicitly provisioned transport only. No existing credential fallback. */
export function isolatedTurnConfiguration(env: Record<string, string | undefined> = process.env): IsolatedTurnConfiguration {
  const image = env.WINGMAN_ISOLATED_CODEX_IMAGE;
  const model = env.WINGMAN_ISOLATED_CODEX_MODEL;
  const key = env.WINGMAN_ISOLATED_CODEX_API_KEY;
  if (!image || !model || !key) throw new Error("Isolated native builder gated: provision audited WINGMAN_ISOLATED_CODEX_IMAGE, fixed WINGMAN_ISOLATED_CODEX_MODEL and dedicated authorized WINGMAN_ISOLATED_CODEX_API_KEY");
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !/^[A-Za-z0-9._-]{1,80}$/.test(model)) throw new Error("Invalid isolated native runtime configuration");
  return { image, provider: createResponsesProvider(model, key) };
}

export function createIsolatedCompletedTurnRuntime(store: IsolatedTurnStore, config: IsolatedTurnConfiguration,
  run: typeof runIsolatedCodex = runIsolatedCodex): CompletedTurnRuntime {
  const prepared = new Map<string, { requestId: string; durationMs: number }>();
  function state(id: string): IsolatedTurnState {
    const value = store.get(id);
    if (!value) throw new Error("Isolated native execution binding unavailable");
    if (value.config !== JSON.stringify({ image: config.image, model: config.provider.model })) throw new Error("Isolated native runtime configuration changed");
    return value;
  }
  function output(value: IsolatedTurnState) {
    const projectFiles = JSON.parse(value.projectJson) as ProjectFile[];
    validateSnapshot(projectFiles);
    return { executionProfile: "isolated-codex", projectFiles };
  }
  return {
    authorize: async (request) => {
      if (request.executionProfile !== "isolated-codex" || !request.projectFiles || !request.durationMs || request.sessionId) throw new Error("Isolated native execution profile required");
      if (request.model && request.model !== config.provider.model) throw new Error("Isolated native model selection denied");
      validateSnapshot(request.projectFiles);
    },
    prepare: async (binding, request) => {
      const value = store.prepare(binding.owner, request, JSON.stringify({ image: config.image, model: config.provider.model }), binding.executionId);
      prepared.set(value.executionId, { requestId: request.requestId, durationMs: request.durationMs! });
      return { executionId: value.executionId, sessionId: null };
    },
    ready: async (id) => { state(id); },
    checkpoint: async (id) => {
      const value = state(id);
      return { nativeSessionId: value.nativeReference, count: value.turns };
    },
    send: async (id, prompt) => {
      const value = state(id);
      const pending = prepared.get(id);
      if (!pending || pending.requestId !== value.pendingRequestId || prompt !== value.prompt || value.completedRequestId === value.pendingRequestId) throw new Error("Isolated exact native request binding changed");
      const result = await run(config.image, { prompt, project: JSON.parse(value.projectJson), continuity: JSON.parse(value.continuityJson),
        durationMs: pending.durationMs, ...(value.nativeReference ? { nativeReference: value.nativeReference } : {}) }, config.provider);
      validateSnapshot(result.project);
      validateSnapshot(result.continuity);
      store.complete(value, result);
      const completed = state(id);
      return { reply: result.reply, nativeSessionId: result.nativeReference, output: output(completed) };
    },
    recover: async (row) => {
      if (!row.executionId || row.checkpoint === null) throw new Error("Isolated native receipt checkpoint missing");
      const value = state(row.executionId);
      if (value.owner !== row.owner || value.conversationKey !== row.conversationKey) throw new Error("Isolated native ownership denied");
      if (value.completedRequestId !== row.requestId || value.turns !== row.checkpoint + 1 || !value.reply || !value.nativeReference) return null;
      if (row.nativeSessionId && row.nativeSessionId !== value.nativeReference) throw new Error("Isolated native reference changed");
      return { reply: value.reply, nativeSessionId: value.nativeReference, output: output(value) };
    },
  };
}
