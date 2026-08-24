import { describe, expect, test } from "bun:test";

import { stopManagedSubprocess, type ManagedSubprocessLike } from "./process-stop";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("stopManagedSubprocess", () => {
  test("returns without force when the child exits after SIGTERM", async () => {
    const exited = createDeferred<number | null>();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const process: ManagedSubprocessLike = {
      exited: exited.promise,
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGTERM") {
          exited.resolve(0);
        }
      },
    };

    const result = await stopManagedSubprocess(process, { gracePeriodMs: 20 });

    expect(result).toEqual({ forced: false });
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("falls back to SIGKILL when the child ignores SIGTERM", async () => {
    const exited = createDeferred<number | null>();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const process: ManagedSubprocessLike = {
      exited: exited.promise,
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGKILL") {
          exited.resolve(137);
        }
      },
    };

    const result = await stopManagedSubprocess(process, { gracePeriodMs: 5 });

    expect(result).toEqual({ forced: true });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("treats an already-exited child as a non-forced stop", async () => {
    const process: ManagedSubprocessLike = {
      exited: Promise.resolve(0),
      kill() {
        throw new Error("process already exited");
      },
    };

    const result = await stopManagedSubprocess(process, { gracePeriodMs: 5 });

    expect(result).toEqual({ forced: false });
  });
});
