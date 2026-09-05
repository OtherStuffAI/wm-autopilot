import { describe, expect, mock, test } from "bun:test";

import {
  attachCompletionSoundUnlock,
  completionSoundPreferenceKey,
  createCompletionSoundController,
} from "./completion-sound.js";

function createPreferenceStore(initialValue = false) {
  return {
    get: mock(async () => ({ key: completionSoundPreferenceKey, value: initialValue })),
    set: mock(async () => {}),
  };
}

describe("completion sound controller", () => {
  test("stays silent until the browser preference is enabled", async () => {
    const preferenceStore = createPreferenceStore(false);
    const playPing = mock(async () => true);
    const controller = createCompletionSoundController({ preferenceStore, playPing });

    expect(await controller.notifyCompletion()).toBe(false);
    expect(playPing).not.toHaveBeenCalled();
  });

  test("persists the setting and pings for later completions", async () => {
    const preferenceStore = createPreferenceStore(false);
    const playPing = mock(async () => true);
    const controller = createCompletionSoundController({ preferenceStore, playPing });
    await controller.init();

    await controller.setEnabled(true);
    expect(await controller.notifyCompletion()).toBe(true);

    expect(preferenceStore.set).toHaveBeenCalledWith(completionSoundPreferenceKey, true);
    expect(playPing).toHaveBeenCalledTimes(1);
  });

  test("plays a preview independently of the saved setting", async () => {
    const playPing = mock(async () => true);
    const controller = createCompletionSoundController({
      preferenceStore: createPreferenceStore(false),
      playPing,
    });

    expect(await controller.preview()).toBe(true);
    expect(playPing).toHaveBeenCalledTimes(1);
  });

  test("unlocks persisted audio on the first browser interaction", async () => {
    let pointerHandler = null;
    const target = {
      addEventListener(type, handler) {
        if (type === "pointerdown") pointerHandler = handler;
      },
      removeEventListener() {},
    };
    const unlock = mock(async () => true);
    const detach = attachCompletionSoundUnlock({ unlock }, target);

    pointerHandler();
    await Promise.resolve();
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(typeof detach).toBe("function");
  });
});
