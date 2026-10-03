import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nip19 } from "nostr-tools";
import { PipelineStore } from "./pipeline-store";
import { handleNativePipelineViewerApi } from "./pipeline-native-viewer-routes";
import {
  handlePipelineApi,
  type PipelineApiContext,
} from "./pipeline-api-routes";
import type { RequestAuthContext } from "../auth/request-context";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { runDeclarativePipeline } from "./pipeline-runner";

const owner = nip19.npubEncode("11".repeat(32)),
  other = nip19.npubEncode("22".repeat(32));
let dir: string, store: PipelineStore, ctx: PipelineApiContext;
const auth = {
  authMethod: "session",
  npub: owner,
  targetOwnerNpub: owner,
  session: { npub: owner },
} as RequestAuthContext;
const definition = {
  id: "native-fixture",
  name: "Native fixture",
  scope: "shared",
  ownerAlias: null,
  path: "/synthetic",
  spec: {
    name: "Native fixture",
    steps: [
      {
        id: "emit",
        name: "emit",
        type: "code",
        function: "emit",
        display: {
          in: [{ label: "Prompt", path: "$.prompt" }],
          out: [{ label: "Records", path: "$.records" }],
        },
      },
    ],
  },
} as PipelineDefinitionRecord;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "native-viewer-"));
  store = new PipelineStore(join(dir, "runs.sqlite"));
  ctx = {
    store,
    sessionApiContext: {},
    ensureApiAccess: async () => null,
    AccessActions: { SessionsManage: "sessions:manage" },
  } as unknown as PipelineApiContext;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
async function request(path: string, selected = auth, method = "GET") {
  const url = new URL(`http://synthetic.test/api/pipelines/viewer/${path}`);
  return (await handleNativePipelineViewerApi(
    new Request(url, { method }),
    url,
    selected,
    ctx,
  ))!;
}
async function run(
  input = { prompt: "synthetic" },
  registry = {
    emit: () => ({
      records: Array.from({ length: 5000 }, (_, index) => ({ index })),
    }),
  },
) {
  return await runDeclarativePipeline({
    store,
    definition,
    registry,
    input,
    ownerNpub: owner,
    ownerAlias: null,
    callbackOrigin: "http://synthetic.test",
    sessionApiContext: {} as never,
  });
}
test("actual runner snapshots and exact lazy pages are available only to owner sessions", async () => {
  const result = await run({ prompt: "exact\n" + "long ".repeat(12000) });
  const response = await request(`runs/${result.id}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const snapshot = await response.json();
  expect(snapshot.definition.id).toBe(definition.id);
  const output = snapshot.steps[0].evidence.find(
    (ref: any) => ref.kind === "returned_output",
  );
  const full = await (
    await request(`runs/${result.id}/evidence/${output.id}`)
  ).json();
  expect(full.value.records).toHaveLength(5000);
  expect(full.nextOffset).toBeNull();
  const input = snapshot.steps[0].evidence.find(
    (ref: any) => ref.kind === "resolved_input",
  );
  expect(
    (await (await request(`runs/${result.id}/evidence/${input.id}`)).json())
      .value.prompt,
  ).toBe("exact\n" + "long ".repeat(12000));
  expect(
    (
      await request(`runs/${result.id}`, {
        ...auth,
        npub: other,
        session: { ...auth.session!, npub: other },
        targetOwnerNpub: other,
      })
    ).status,
  ).toBe(404);
  for (const selected of [
    { ...auth, authMethod: "nip98" },
    { ...auth, delegatedOwnerNpub: other },
    { ...auth, session: null },
    { ...auth, targetOwnerNpub: other },
  ]) {
    expect(
      (await request(`runs/${result.id}`, selected as RequestAuthContext))
        .status,
    ).toBe(403);
  }
  expect((await request(`runs/${result.id}`, auth, "POST")).status).toBe(405);
  ctx.ensureApiAccess = async () =>
    Response.json({ error: "denied" }, { status: 403 });
  expect((await request(`runs/${result.id}`)).status).toBe(403);
});
test("run/evidence mismatch, malformed pages and shared access never grant ownership", async () => {
  const first = await run(),
    second = await run();
  const ref = store.evidence.list(second.id)[0]!;
  expect((await request(`runs/${first.id}/evidence/${ref.id}`)).status).toBe(
    404,
  );
  for (const query of [
    "limit=0",
    "limit=501",
    "offset=-1",
    "offset=1&offset=2",
  ])
    expect(
      (await request(`runs/${second.id}/evidence/${ref.id}?${query}`)).status,
    ).toBe(400);
  expect(
    (await request(`runs/${second.id}/evidence/${ref.id}?offset=1`)).status,
  ).toBe(400);
  ctx.sharedInstanceAccess = true;
  expect(
    (
      await request(`runs/${second.id}`, {
        ...auth,
        npub: other,
        targetOwnerNpub: other,
        session: { ...auth.session!, npub: other },
      })
    ).status,
  ).toBe(404);
  const url = new URL(
    `http://synthetic.test/api/pipelines/viewer/runs/${first.id}`,
  );
  expect(
    (await handlePipelineApi(new Request(url), url, "GET", auth, ctx))!.status,
  ).toBe(200);
});
test("legacy missing snapshot is explicit and later credentials refuse all evidence", async () => {
  const legacy = store.createRun({
    name: "Legacy",
    definitionId: definition.id,
    ownerNpub: owner,
    scope: "shared",
    input: {},
  });
  expect(
    (await (await request(`runs/${legacy.id}`)).json()).definition.availability,
  ).toBe("unavailable");
  const result = await run(
    { prompt: "x".repeat(1000) + "synthetic-late-secret" },
    { emit: () => ({ apiKey: "synthetic-late-secret", records: [] }) } as never,
  );
  store.evidence.registerSecret("synthetic-late-secret");
  expect((await request(`runs/${result.id}`)).status).toBe(409);
  expect(
    (
      await request(
        `runs/${result.id}/evidence/${store.evidence.list(result.id)[0]!.id}`,
      )
    ).status,
  ).toBe(409);
});
test("foreign ancestry denies a same-owner child", async () => {
  const result = await run();
  const parent = store.createRun({
    name: "foreign",
    definitionId: definition.id,
    ownerNpub: other,
    scope: "shared",
    input: {},
  });
  const step = store.createStep({
    runId: parent.id,
    stepIndex: 0,
    name: "call",
    kind: "pipeline",
    input: {},
  });
  store.composition.link({
    parentRunId: parent.id,
    parentStepId: step.id,
    childRunId: result.id,
    deadline: Date.now() + 1000,
  });
  expect((await request(`runs/${result.id}`)).status).toBe(404);
});
