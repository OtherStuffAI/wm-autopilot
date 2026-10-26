/** Stop waiting and prevent subsequent startup steps after abort. */
export function awaitAppStartup<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
