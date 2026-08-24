export function createComposerUploadState({ onChange, showToast } = {}) {
  let pendingOperations = 0;

  function notify() {
    onChange?.({
      pendingOperations,
      uploading: pendingOperations > 0,
    });
  }

  function setUploadingState(isUploading) {
    pendingOperations = isUploading
      ? pendingOperations + 1
      : Math.max(0, pendingOperations - 1);
    notify();
  }

  function blockSubmissionIfUploading() {
    if (pendingOperations === 0) {
      return false;
    }
    showToast?.("Wait for the attachment upload to finish before sending.", { type: "info" });
    return true;
  }

  return {
    blockSubmissionIfUploading,
    isUploading: () => pendingOperations > 0,
    setUploadingState,
  };
}
