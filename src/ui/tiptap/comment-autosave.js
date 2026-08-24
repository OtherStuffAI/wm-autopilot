export function createCommentAutosave({
  delayMs = 5000,
  canSave,
  save,
  onSuccess,
  onError,
} = {}) {
  let timer = null;
  let pending = false;
  let activeSave = null;

  function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
  }

  function runSave() {
    pending = false;
    if (canSave?.() === false) return Promise.resolve();
    activeSave = Promise.resolve(save?.())
      .then(() => onSuccess?.())
      .catch((error) => onError?.(error))
      .finally(() => {
        activeSave = null;
      });
    return activeSave;
  }

  function queue() {
    clear();
    pending = true;
    timer = setTimeout(() => {
      timer = null;
      void runSave();
    }, delayMs);
  }

  function flush() {
    if (!pending && timer === null) return activeSave ?? Promise.resolve();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return runSave();
  }

  return { queue, clear, flush };
}
