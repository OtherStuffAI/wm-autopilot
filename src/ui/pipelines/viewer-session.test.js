import { expect, test } from "bun:test";
import {
  createNativeViewerSession,
  summaryOnly,
  REDACTION_REASON,
} from "./viewer-session.js";
import {
  pipelineNodes,
  flattenPipelineNodes,
  portSelection,
  diagramPorts,
  latestPortReference,
} from "./viewer-projection.js";

const json = (body, status = 200) =>
  Response.json({ version: 1, serviceId: "native", ...body }, { status });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const ref = {
  id: "e",
  runId: "a",
  stepId: "s",
  kind: "returned_output",
  availability: "complete",
};
const snapshot = {
  run: { id: "a", serviceId: "native", status: "ok" },
  revision: "a".repeat(64),
  definition: { id: "def", steps: [] },
  steps: [
    {
      id: "s",
      logicalKey: "emit",
      attempt: 1,
      evidence: [
        { ...ref, preview: { value: "PRIVATE PREVIEW", truncated: false } },
      ],
    },
  ],
};

test("summaries strip private previews and pinned values never enter publication", async () => {
  const records = [],
    calls = [];
  const session = createNativeViewerSession({
    publish: async (row) => records.push(row),
    request: async (path, options) => {
      calls.push({ path, options });
      return path.includes("evidence")
        ? json({ evidence: ref, value: "PRIVATE FULL", nextOffset: null })
        : json(snapshot);
    },
  });
  await session.select("run", "a");
  expect(session.preview("e").value).toBe("PRIVATE PREVIEW");
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
  await session.evidence(ref);
  expect(session.value("e").value).toBe("PRIVATE FULL");
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
  expect(calls[0].options.cache).toBe("no-store");
  expect(calls[0].options.redirect).toBe("error");
  session.dispose();
  expect(session.value("e")).toBeUndefined();
  expect(session.preview("e")).toBeUndefined();
});

test("delayed selection and delayed evidence cannot revive a previous mode or closed inspector", async () => {
  const records = [],
    old = deferred(),
    value = deferred();
  const session = createNativeViewerSession({
    publish: async (row) => records.push(row),
    request: async (path) => {
      if (path.includes("evidence")) return value.promise;
      if (path.endsWith("/a")) return old.promise;
      return json({ definition: { id: "b", steps: [] } });
    },
  });
  const pending = session.select("run", "a");
  await Promise.resolve();
  await session.select("definition", "b");
  old.resolve(json(snapshot));
  await pending;
  expect(records.at(-1).snapshot.definition.id).toBe("b");
  expect(session.preview("e")).toBeUndefined();
  const next = createNativeViewerSession({
    publish: async () => {},
    request: async (path) =>
      path.includes("evidence") ? value.promise : json(snapshot),
  });
  await next.select("run", "a");
  const loading = next.evidence(ref);
  next.clearValues();
  value.resolve(
    json({ evidence: ref, value: "late private", nextOffset: null }),
  );
  await loading;
  expect(next.value("e")).toBeUndefined();
  next.dispose();
  session.dispose();
});

test("refusal clears all values and ignores an earlier released 200", async () => {
  const records = [],
    delayed = deferred();
  let denied = false;
  const session = createNativeViewerSession({
    publish: async (row) => records.push(row),
    request: async (path) => {
      if (denied) return json({ error: REDACTION_REASON }, 409);
      return path.includes("evidence") ? delayed.promise : json(snapshot);
    },
  });
  await session.select("run", "a");
  const loading = session.evidence(ref);
  denied = true;
  await session.refresh();
  delayed.resolve(
    json({ evidence: ref, value: "old private", nextOffset: null }),
  );
  await loading;
  expect(records.at(-1)).toMatchObject({
    status: "unavailable",
    reason: REDACTION_REASON,
    snapshot: null,
  });
  expect(session.value("e")).toBeUndefined();
  expect(session.preview("e")).toBeUndefined();
  session.dispose();
});

test("every array page is loadable; missing differs from explicit null and attempts select exact side", async () => {
  const values = Array.from({ length: 5000 }, (_, index) => ({ index }));
  const session = createNativeViewerSession({
    publish: async () => {},
    request: async (path) => {
      if (!path.includes("evidence")) return json(snapshot);
      const offset = Number(
        new URL(path, "http://fixture").searchParams.get("offset"),
      );
      return json({
        evidence: ref,
        value: values.slice(offset, offset + 500),
        nextOffset: offset + 500 < values.length ? offset + 500 : null,
      });
    },
  });
  await session.select("run", "a");
  await session.evidence(ref);
  expect(session.value("e").complete).toBe(false);
  while (session.value("e").nextOffset != null)
    await session.evidence(ref, true);
  expect(session.value("e").value).toEqual(values);
  expect(session.value("e").complete).toBe(true);
  expect(portSelection({ value: null }, "$.value").status).toBe("null");
  expect(portSelection({ value: null }, "$.missing").status).toBe("missing");
  expect(
    latestPortReference(
      { evidence: [{ id: "input", kind: "resolved_input" }, ref] },
      "outputs",
    ).id,
  ).toBe("e");
  expect(summaryOnly(snapshot).steps[0].evidence[0].preview).toBeUndefined();
  session.dispose();
});

test("renderer projects real children and attempts without synthesizing loop executions", () => {
  const definition = {
    steps: [
      {
        logicalKey: "loop",
        children: [{ logicalKey: "loop/emit", children: [] }],
      },
    ],
  };
  const nodes = flattenPipelineNodes(
    pipelineNodes(definition, {
      steps: [
        { id: "2", logicalKey: "loop/emit", attempt: 2 },
        { id: "1", logicalKey: "loop/emit", attempt: 1 },
      ],
    }),
  );
  expect(nodes.map((node) => node.logicalKey)).toEqual(["loop", "loop/emit"]);
  expect(nodes[1].attempts.map((step) => step.id)).toEqual(["1", "2"]);
  expect(
    diagramPorts({ logicalKey: "emit", outputs: [] }, "outputs", [
      {
        sourceStepKey: "emit",
        targetStepKey: "deliver",
        sourceValuePath: "$.metadata",
        targetPath: "$.metadata",
        carriedForward: true,
      },
    ])[0].path,
  ).toBe("$.metadata");
});

test("same-selection refresh is serialized and an old ignored abort cannot block a new run", async () => {
  const delayed = deferred(),
    records = [];
  let calls = 0;
  const session = createNativeViewerSession({
    publish: async (row) => records.push(row),
    request: async (path) => {
      calls++;
      if (calls === 2) return delayed.promise;
      return json(
        path.endsWith("/b")
          ? { ...snapshot, run: { ...snapshot.run, id: "b" }, steps: [] }
          : snapshot,
      );
    },
  });
  await session.select("run", "a");
  const old = session.refresh();
  await session.refresh();
  expect(calls).toBe(2);
  await session.select("run", "b");
  await session.refresh();
  expect(calls).toBe(4);
  delayed.resolve(json(snapshot));
  await old;
  expect(records.at(-1).snapshot.run.id).toBe("b");
  session.dispose();
});

test("mismatched authorized snapshot identities are unavailable rather than displayed", async () => {
  const records = [];
  const session = createNativeViewerSession({
    publish: async (row) => records.push(row),
    request: async () => json(snapshot),
  });
  await session.select("run", "another-run");
  expect(records.at(-1)).toMatchObject({
    status: "unavailable",
    snapshot: null,
    reason: "Viewer selection mismatch",
  });
  session.dispose();
});
