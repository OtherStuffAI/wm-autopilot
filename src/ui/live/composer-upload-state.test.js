import { describe, expect, mock, test } from "bun:test";

import { createComposerUploadState } from "./composer-upload-state.js";

describe("createComposerUploadState", () => {
  test("keeps sending blocked until every concurrent upload finishes", () => {
    const changes = [];
    const showToast = mock(() => {});
    const state = createComposerUploadState({
      onChange: (change) => changes.push(change),
      showToast,
    });

    state.setUploadingState(true);
    state.setUploadingState(true);
    state.setUploadingState(false);

    expect(state.isUploading()).toBe(true);
    expect(state.blockSubmissionIfUploading()).toBe(true);
    expect(showToast).toHaveBeenCalledTimes(1);

    state.setUploadingState(false);

    expect(state.isUploading()).toBe(false);
    expect(state.blockSubmissionIfUploading()).toBe(false);
    expect(changes.at(-1)).toEqual({ pendingOperations: 0, uploading: false });
  });
});
