import { snapshotDto, definitionDto, evidenceDto } from "./viewer-contract.js";

export const REDACTION_REASON =
  "pipeline-viewer-evidence-redaction-review-required";
export const REDACTION_MESSAGE =
  "Evidence withheld: retained history requires redaction review. No values are available.";

export function summaryOnly(snapshot) {
  return JSON.parse(
    JSON.stringify(snapshot, (key, value) =>
      key === "preview" ? undefined : value,
    ),
  );
}

// Private previews and full values are deliberately session-only. Generation
// guards remain necessary even when a transport ignores AbortSignal.
export function createNativeViewerSession({
  request = fetch,
  publish,
  changed = () => {},
}) {
  let generation = 0,
    controller = new AbortController(),
    disposed = false;
  let selection = null,
    previews = new Map(),
    values = new Map();
  let valueGeneration = 0,
    valueController = new AbortController();
  let refreshingGeneration = null;
  async function read(path, signal) {
    const response = await request(`/api/pipelines/viewer/${path}`, {
      credentials: "include",
      cache: "no-store",
      signal,
      redirect: "error",
    });
    const body = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(body.error || `Viewer unavailable (${response.status})`),
        { status: response.status },
      );
    if (body.version !== 1 || body.serviceId !== "native")
      throw new Error("Viewer contract unavailable");
    if (path.includes("/evidence/")) {
      const evidence = evidenceDto(body.evidence);
      if (
        body.nextOffset !== null &&
        (!Number.isSafeInteger(body.nextOffset) || body.nextOffset < 0)
      )
        throw new Error("Invalid evidence page");
      return { evidence, value: body.value, nextOffset: body.nextOffset };
    }
    const snapshot = path.startsWith("runs/")
      ? snapshotDto(body, "native")
      : { definition: definitionDto(body.definition) };
    const expectedId = decodeURIComponent(path.split("/")[1]);
    if ((snapshot.run?.id ?? snapshot.definition.id) !== expectedId)
      throw new Error("Viewer selection mismatch");
    return snapshot;
  }
  function clearValues() {
    valueGeneration++;
    valueController.abort();
    valueController = new AbortController();
    values.clear();
    changed();
  }
  function clear() {
    generation++;
    controller.abort();
    controller = new AbortController();
    previews.clear();
    refreshingGeneration = null;
    clearValues();
  }
  async function fail(error, ticket) {
    if (disposed || ticket !== generation) return;
    clear();
    await publish({
      status:
        error.status === 401 || error.status === 403 ? "denied" : "unavailable",
      reason: error.message,
      snapshot: null,
    });
  }
  return {
    preview: (id) => previews.get(id),
    value: (id) => values.get(id),
    clearValues,
    async select(mode, id) {
      clear();
      selection = { mode, id };
      const ticket = generation;
      await publish({ status: "loading", snapshot: null, reason: null });
      if (disposed || ticket !== generation) return;
      try {
        const snapshot = await read(
          `${mode === "run" ? "runs" : "definitions"}/${encodeURIComponent(id)}`,
          controller.signal,
        );
        if (disposed || ticket !== generation) return;
        for (const step of snapshot.steps || [])
          for (const ref of step.evidence)
            if (ref.preview) previews.set(ref.id, ref.preview);
        await publish({
          status: "ready",
          snapshot: summaryOnly(snapshot),
          reason: null,
        });
        changed();
      } catch (error) {
        await fail(error, ticket);
      }
    },
    async refresh() {
      if (!selection || disposed || refreshingGeneration === generation) return;
      const ticket = generation;
      refreshingGeneration = ticket;
      try {
        const snapshot = await read(
          `${selection.mode === "run" ? "runs" : "definitions"}/${encodeURIComponent(selection.id)}`,
          controller.signal,
        );
        if (disposed || ticket !== generation) return;
        previews.clear();
        for (const step of snapshot.steps || [])
          for (const ref of step.evidence)
            if (ref.preview) previews.set(ref.id, ref.preview);
        await publish({
          status: "ready",
          snapshot: summaryOnly(snapshot),
          reason: null,
        });
        changed();
      } catch (error) {
        await fail(error, ticket);
      } finally {
        if (refreshingGeneration === ticket) refreshingGeneration = null;
      }
    },
    async evidence(ref, more = false) {
      if (disposed || !selection || selection.mode !== "run") return;
      const ticket = generation,
        valueTicket = valueGeneration;
      const previous = more ? values.get(ref.id) : null;
      if (more && previous?.nextOffset == null) return;
      if (!["complete", "redacted"].includes(ref.availability)) {
        values.set(ref.id, {
          reference: ref,
          status: "unavailable",
          complete: false,
        });
        changed();
        return;
      }
      values.set(ref.id, {
        ...previous,
        reference: ref,
        status: "loading",
        complete: false,
      });
      changed();
      try {
        const offset = previous?.nextOffset || 0;
        const body = await read(
          `runs/${encodeURIComponent(selection.id)}/evidence/${encodeURIComponent(ref.id)}?offset=${offset}&limit=500`,
          valueController.signal,
        );
        if (
          disposed ||
          ticket !== generation ||
          valueTicket !== valueGeneration
        )
          return;
        if (
          body.evidence?.id !== ref.id ||
          body.evidence?.runId !== selection.id
        )
          throw new Error("Evidence reference mismatch");
        const value =
          previous && Array.isArray(previous.value) && Array.isArray(body.value)
            ? [...previous.value, ...body.value]
            : body.value;
        values.set(ref.id, {
          reference: body.evidence,
          value,
          status: "ready",
          nextOffset: body.nextOffset,
          complete: body.nextOffset === null,
        });
        changed();
      } catch (error) {
        if (ticket === generation && valueTicket === valueGeneration)
          await fail(error, ticket);
      }
    },
    dispose() {
      disposed = true;
      clear();
      selection = null;
    },
  };
}
