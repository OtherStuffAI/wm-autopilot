import { spyOn } from "bun:test";
import * as runner from "./pipeline-runner";

/** Observe detached children without changing their start, timeout or cancellation. */
export function observeChildRunnerLifecycle() {
  const completions: Promise<unknown>[] = [];
  let pendingCount = 0;
  const start = runner.startDeclarativePipeline;
  const resume = runner.resumeDeclarativePipeline;
  const startSpy = spyOn(runner, "startDeclarativePipeline").mockImplementation(input => {
    let finished!: () => void;
    completions.push(new Promise<void>(resolve => { finished = resolve; }));
    pendingCount++;
    try {
      return start({ ...input, onRunCompleted: run => {
        try { input.onRunCompleted?.(run); }
        finally { pendingCount--; finished(); }
      } });
    } catch (error) {
      pendingCount--;
      finished();
      throw error;
    }
  });
  const resumeSpy = spyOn(runner, "resumeDeclarativePipeline").mockImplementation((input, id) => {
    const completion = resume(input, id);
    completions.push(completion);
    return completion;
  });
  return {
    get pendingCount() { return pendingCount; },
    async drain() {
      // A completion callback runs immediately before the runner's synchronous
      // finally. Awaiting it lets that finally finish before fixture deletion.
      // New descendants may start while an earlier batch is being awaited.
      let cursor = 0;
      while (cursor < completions.length) {
        const batch = completions.slice(cursor);
        cursor = completions.length;
        await Promise.all(batch);
      }
    },
    restore() { startSpy.mockRestore(); resumeSpy.mockRestore(); },
  };
}
