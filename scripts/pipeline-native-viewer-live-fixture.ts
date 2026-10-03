import { startDeclarativePipeline } from "../src/pipelines/pipeline-runner";
import type { PipelineStore } from "../src/pipelines/pipeline-store";
import type { PipelineDefinitionRecord } from "../src/pipelines/pipeline-loader";

// A real runner remains active across authorized viewer reads, then completes.
export function createNativeLiveFixture(
  store: PipelineStore,
  ownerNpub: string,
) {
  const pending = new Map<
    string,
    { release: () => void; done: Promise<void> }
  >();
  return {
    start() {
      let release!: () => void, finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const definition = {
        id: "synthetic-live",
        name: "Synthetic live run",
        scope: "shared",
        ownerAlias: null,
        path: "/synthetic/live.json",
        spec: {
          name: "Synthetic live run",
          version: 1,
          steps: [
            {
              id: "wait",
              name: "wait",
              title: "Await synthetic result",
              description:
                "Actual live execution; no provider or external delivery",
              type: "code",
              function: "wait",
              input: "$",
              display: {
                in: [{ label: "Request", path: "$.request" }],
                out: [{ label: "Answer", path: "$.answer" }],
              },
            },
          ],
        },
      } as PipelineDefinitionRecord;
      const run = startDeclarativePipeline({
        store,
        definition,
        ownerNpub,
        ownerAlias: null,
        input: { request: "Live request" },
        callbackOrigin: "http://synthetic.test",
        sessionApiContext: {} as never,
        registry: {
          wait: async () => {
            await gate;
            return { answer: "Exact live completion" };
          },
        },
        onRunCompleted: () => finish(),
      });
      pending.set(run.id, { release, done });
      return run.id;
    },
    async complete(id: string) {
      const run = pending.get(id);
      if (!run) throw new Error("Missing live fixture");
      run.release();
      await run.done;
      pending.delete(id);
    },
    async close() {
      for (const id of pending.keys()) await this.complete(id);
    },
  };
}
