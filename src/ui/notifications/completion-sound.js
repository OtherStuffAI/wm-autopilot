export const completionSoundPreferenceKey = "session-completion-sound-enabled";

export function createWebAudioCompletionPing(windowRef = globalThis.window) {
  let audioContext = null;

  async function ensureAudioContext() {
    const AudioContextClass = windowRef?.AudioContext ?? windowRef?.webkitAudioContext;
    if (!AudioContextClass) return null;

    audioContext ??= new AudioContextClass();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext;
  }

  async function playCompletionPing() {
    const audioContext = await ensureAudioContext();
    if (!audioContext) return false;

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const start = audioContext.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, start);
    oscillator.frequency.exponentialRampToValueAtTime(1174.66, start + 0.12);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.3);
    return true;
  }

  playCompletionPing.unlock = async () => Boolean(await ensureAudioContext());
  return playCompletionPing;
}

export function createCompletionSoundController({ preferenceStore, playPing }) {
  let enabled = false;
  let initPromise = null;

  function init() {
    initPromise ??= preferenceStore.get(completionSoundPreferenceKey)
      .then((record) => {
        enabled = record?.value === true;
        return enabled;
      });
    return initPromise;
  }

  async function setEnabled(nextEnabled) {
    const nextValue = nextEnabled === true;
    await preferenceStore.set(completionSoundPreferenceKey, nextValue);
    enabled = nextValue;
    return enabled;
  }

  async function preview() {
    try {
      return await playPing();
    } catch (error) {
      console.warn("[completion-sound] unable to preview completion ping", error);
      return false;
    }
  }

  async function notifyCompletion() {
    await init();
    if (!enabled) return false;
    try {
      return await playPing();
    } catch (error) {
      console.warn("[completion-sound] unable to play completion ping", error);
      return false;
    }
  }

  async function unlock() {
    await init();
    if (!enabled || typeof playPing.unlock !== "function") return false;
    try {
      return await playPing.unlock();
    } catch {
      return false;
    }
  }

  return {
    init,
    isEnabled: () => enabled,
    setEnabled,
    preview,
    notifyCompletion,
    unlock,
  };
}

export function attachCompletionSoundUnlock(controller, target = globalThis.window) {
  if (!target?.addEventListener) return () => {};
  const unlock = () => {
    void controller.unlock();
  };
  target.addEventListener("pointerdown", unlock, { once: true, capture: true });
  target.addEventListener("keydown", unlock, { once: true, capture: true });
  return () => {
    target.removeEventListener("pointerdown", unlock, { capture: true });
    target.removeEventListener("keydown", unlock, { capture: true });
  };
}
