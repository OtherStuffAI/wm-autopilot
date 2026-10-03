import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nip19 } from "nostr-tools";
import { PipelineStore } from "../src/pipelines/pipeline-store";
import { runDeclarativePipeline } from "../src/pipelines/pipeline-runner";
import {
  listLatestPipelineDefinitions,
  type PipelineDefinitionRecord,
} from "../src/pipelines/pipeline-loader";
import {
  handlePipelineApi,
  type PipelineApiContext,
} from "../src/pipelines/pipeline-api-routes";
import type { RequestAuthContext } from "../src/auth/request-context";
import { createProjectStaticAssetService } from "../src/server/static-assets";
import { createStaticRouteHandler } from "../src/server/static-routes";

export const fixtureOwner = nip19.npubEncode("11".repeat(32));
export const exactPrompt =
  "  Exact user text\n" +
  '😀 <script>window.UNSAFE=true</script> & "quoted"\n'.repeat(1800) +
  " END  ";
export async function createNativeViewerFixture() {
  const directory = mkdtempSync(join(tmpdir(), "native-viewer-browser-"));
  const store = new PipelineStore(join(directory, "runs.sqlite"));
  const record = (name: string, steps: unknown[]) =>
    ({
      id: name,
      name,
      scope: "shared",
      ownerAlias: null,
      path: join(directory, `${name}.json`),
      spec: {
        name,
        description: "Synthetic actual runner fixture",
        version: 1,
        steps,
      },
    }) as PipelineDefinitionRecord;
  const rows = (label: string, path: string) => [
    { label, path, format: "text" },
  ];
  let child = record("synthetic.retrieve", [
    {
      id: "loop",
      name: "loop",
      type: "loop",
      iterations: 2,
      steps: [
        {
          id: "retrieve",
          name: "retrieve",
          title: "Read synthetic records",
          type: "code",
          function: "retrieve",
          description:
            "Each real loop execution returns its own retained records",
          input: "$.request",
          assign: "$.result",
          display: {
            in: rows("Outcome", "$.outcome"),
            out: rows("Records", "$.records"),
          },
        },
      ],
    },
  ]);
  let parent = record("synthetic.chat", [
    {
      id: "prepare",
      name: "prepare",
      title: "Parse chat request",
      description: "Prepare the retrieval request and carry thread metadata",
      type: "code",
      function: "prepare",
      input: "$",
      assign: "$.prepared",
      display: {
        in: rows("Chat Message", "$.prompt"),
        out: [
          ...rows("Request", "$.request"),
          ...rows("Chat Metadata", "$.metadata"),
        ],
      },
    },
    {
      id: "child",
      name: "child",
      title: "Retrieve records",
      description: "Actual child workflow with two bounded retrieval attempts",
      type: "pipeline",
      pipeline: child.name,
      input: "$.prepared",
      assign: "$.retrieved",
      display: {
        in: rows("Request", "$.request"),
        out: rows("Records", "$.result.records"),
      },
    },
    {
      id: "format",
      name: "format",
      title: "Format deterministic reply",
      type: "code",
      function: "format",
      input: "$.retrieved",
      assign: "$.formatted",
      description: "Formatting does not confirm delivery",
      display: {
        in: rows("Records", "$.result.records"),
        out: rows("Reply", "$.reply"),
      },
    },
    {
      id: "clarify",
      name: "clarify",
      title: "Ask for clarification",
      description: "Only ambiguous requests take the clarification branch",
      type: "code",
      function: "clarify",
      when: { path: "$.outcome", equals: "clarification" },
      input: "$",
      assign: "$.clarification",
      display: {
        in: rows("Outcome", "$.outcome"),
        out: rows("Question", "$.question"),
      },
    },
    {
      id: "deliver",
      name: "deliver",
      title: "Confirm synthetic delivery",
      type: "code",
      function: "flightdeck.returnToThread",
      input: {
        pick: { reply: "$.formatted.reply", metadata: "$.prepared.metadata" },
      },
      assign: "$.delivery",
      description:
        "Delivery adapter confirmation is separate from formatted text",
      display: {
        in: [
          ...rows("Reply", "$.reply"),
          ...rows("Chat Metadata", "$.metadata"),
        ],
        out: [
          ...rows("Posted Reply", "$.delivery.reply"),
          ...rows("Null field", "$.explicitNull"),
          ...rows("Missing field", "$.missing"),
        ],
      },
    },
  ]);
  const priorRoot = process.env.WINGMEN_PIPELINES_ROOT;
  process.env.WINGMEN_PIPELINES_ROOT = join(directory, "pipelines");
  const definitionsDirectory = join(
    process.env.WINGMEN_PIPELINES_ROOT,
    "shared",
    "definitions",
  );
  mkdirSync(definitionsDirectory, { recursive: true });
  for (const definition of [parent, child])
    writeFileSync(
      join(definitionsDirectory, `${definition.name}.json`),
      JSON.stringify(definition.spec),
    );
  const loaded = await listLatestPipelineDefinitions(null);
  parent = loaded.find((definition) => definition.name === parent.name)!;
  child = loaded.find((definition) => definition.name === child.name)!;
  const runs: Record<string, string> = {};
  for (const outcome of [
    "full",
    "partial",
    "clarification",
    "failed",
    "no-results",
  ]) {
    const run = await runDeclarativePipeline({
      store,
      definition: parent,
      ownerNpub: fixtureOwner,
      ownerAlias: null,
      input: { prompt: exactPrompt, outcome },
      callbackOrigin: "http://synthetic.test",
      sessionApiContext: {} as never,
      resolveChildDefinition: async () => child,
      registry: {
        prepare: (input) => ({
          request: { outcome: input.outcome },
          metadata: { thread: "synthetic-thread", prompt: input.prompt },
        }),
        retrieve: (input) => {
          if (input.outcome === "failed")
            throw new Error("Synthetic retrieval failed");
          return {
            records: Array.from(
              {
                length:
                  input.outcome === "full"
                    ? 5000
                    : input.outcome === "partial"
                      ? 3
                      : 0,
              },
              (_, index) => ({
                index,
                text: `Record ${index} <img onerror=alert(1)>`,
              }),
            ),
            outcome: input.outcome,
            verdict: input.outcome === "partial" ? "running" : input.outcome,
            reason: `Synthetic ${input.outcome} reason`,
          };
        },
        format: (input) => ({
          reply: `Deterministic ${outcome} reply\n  exact spacing  `,
          count: (input.result as any)?.records?.length,
        }),
        clarify: () => ({ question: "Which source should be read?" }),
        "flightdeck.returnToThread": (input) => ({
          delivery: {
            reply: input.reply,
            status: "posted",
            threadId: "synthetic-thread",
          },
          explicitNull: null,
        }),
      },
    });
    runs[outcome] = run.id;
  }
  const legacy = store.createRun({
    name: "Synthetic legacy",
    definitionId: parent.id,
    ownerNpub: fixtureOwner,
    scope: "shared",
    input: {},
  });
  runs.legacy = legacy.id;
  let denied = false,
    refuse = false,
    delay = false,
    release: (() => void) | null = null;
  const apiContext = {
    store,
    sessionApiContext: {},
    defaultAgent: "codex",
    ensureApiAccess: async () =>
      denied ? Response.json({ error: "denied" }, { status: 403 }) : null,
    AccessActions: { SessionsManage: "sessions:manage" },
  } as unknown as PipelineApiContext;
  const auth = {
    authMethod: "session",
    npub: fixtureOwner,
    targetOwnerNpub: fixtureOwner,
    session: { npub: fixtureOwner },
  } as RequestAuthContext;
  const assets = createProjectStaticAssetService(
    resolve(import.meta.dir, ".."),
  );
  const routes = createStaticRouteHandler({ assetService: assets });
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url),
        path = url.pathname;
      const early = await routes.serveBeforeApi(request, path);
      if (early) return early;
      if (path.startsWith("/api/")) requests.push(path);
      if (path.startsWith("/api/pipelines/viewer/")) {
        if (refuse)
          return Response.json(
            { error: "pipeline-viewer-evidence-redaction-review-required" },
            { status: 409 },
          );
        if (path.includes("/evidence/") && delay) {
          delay = false;
          await new Promise<void>((done) => {
            release = done;
          });
        }
        return (
          (await handlePipelineApi(request, url, "GET", auth, apiContext)) ??
          new Response("Missing fixture route", { status: 404 })
        );
      }
      if (path === "/api/pipelines/root")
        return Response.json({ root: "Synthetic fixture" });
      if (path === "/api/pipelines/definitions")
        return Response.json({ definitions: [{ ...parent, ...parent.spec }] });
      if (path === "/api/pipelines/runs")
        return Response.json({
          runs: store.listRuns().map((run) => ({
            id: run.id,
            name: run.name,
            status: run.status,
            startedAt: run.startedAt,
            definitionId: run.definitionId,
          })),
        });
      const match = path.match(/^\/api\/pipelines\/runs\/([^/]+)$/);
      if (match)
        return Response.json({
          run: store.getRunSummary(match[1]!),
          steps: [],
        });
      if (
        path === "/api/sessions/subscribe" ||
        path === "/api/mcp/nip98/subscribe"
      )
        return new Response("retry: 60000\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      if (path === "/api/config")
        return Response.json({
          agents: [{ id: "codex", label: "Codex" }],
          defaultAgent: "codex",
          featureFlags: [],
        });
      if (path === "/api/sessions")
        return Response.json({ sessions: [], filters: [] });
      if (path === "/api/apps") return Response.json({ apps: [] });
      if (path === "/api/bot-keys/me") return Response.json({ bot: null });
      if (path === "/api/feature-flags") return Response.json({ flags: [] });
      if (path === "/api/identity/profile")
        return Response.json({ profile: { display_name: "Synthetic owner" } });
      if (path.startsWith("/api/"))
        return Response.json({
          sessions: [],
          apps: [],
          projects: [],
          delegations: [],
          providers: [],
          schedules: [],
          users: [],
          entries: [],
          items: [],
          enabled: false,
        });
      return (
        (await routes.serveBeforeApi(request, path)) ??
        (await routes.serveAfterApi(request, path))
      );
    },
  });
  return {
    server,
    runs,
    parent,
    store,
    requests,
    deny: () => {
      denied = true;
    },
    refuse: () => {
      refuse = true;
    },
    recover: () => {
      denied = false;
      refuse = false;
    },
    delay: () => {
      delay = true;
    },
    release: () => {
      release?.();
      release = null;
    },
    async close() {
      release?.();
      server.stop(true);
      if (priorRoot === undefined) delete process.env.WINGMEN_PIPELINES_ROOT;
      else process.env.WINGMEN_PIPELINES_ROOT = priorRoot;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
