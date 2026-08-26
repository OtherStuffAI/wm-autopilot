function revokePreviewUrl(state) {
  if (state.objectUrl && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = '';
}

export function createAgentProfileMediaPicker(testIdPrefix) {
  const field = document.createElement('fieldset');
  field.style.cssText = 'display:grid;gap:8px;margin:10px 0;padding:12px;border:1px solid var(--wm-border-muted, rgba(255,255,255,0.14));border-radius:8px;';
  field.dataset.testid = `${testIdPrefix}-owned-media`;
  const legend = document.createElement('legend');
  legend.textContent = 'Owned profile image';
  const note = document.createElement('p');
  note.className = 'wm-settings__port-note';
  note.style.margin = '0';
  note.textContent = 'Choose a JPEG, PNG, or static WebP up to 5MB. Autopilot stores verified bytes locally and publishes its immutable public URL.';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.dataset.testid = `${testIdPrefix}-file`;
  input.setAttribute('aria-label', 'Choose an image to store in Autopilot');
  const preview = document.createElement('img');
  preview.alt = 'Agent profile image preview';
  preview.dataset.testid = `${testIdPrefix}-preview`;
  preview.hidden = true;
  preview.style.cssText = 'width:112px;height:112px;object-fit:cover;border-radius:12px;border:1px solid var(--wm-border-muted, rgba(255,255,255,0.14));';
  const status = document.createElement('p');
  status.dataset.testid = `${testIdPrefix}-status`;
  status.setAttribute('aria-live', 'polite');
  status.className = 'wm-settings__port-note';
  status.style.margin = '0';
  const state = { file: null, externalUrl: '', objectUrl: '' };

  function render() {
    revokePreviewUrl(state);
    if (state.file && typeof URL?.createObjectURL === 'function') {
      state.objectUrl = URL.createObjectURL(state.file);
      preview.src = state.objectUrl;
      preview.hidden = false;
      status.textContent = `${state.file.name || 'Selected image'} will be saved locally when the profile is submitted.`;
      return;
    }
    if (state.externalUrl) {
      preview.src = state.externalUrl;
      preview.hidden = false;
      status.textContent = 'Previewing the current URL. It is externally hosted unless you choose a local file.';
      return;
    }
    preview.removeAttribute?.('src');
    preview.hidden = true;
    status.textContent = 'No locally owned image selected.';
  }

  input.addEventListener('change', () => {
    state.file = input.files?.[0] ?? null;
    render();
  });
  field.append(legend, note, input, preview, status);
  render();
  return {
    element: field,
    get file() { return state.file; },
    setExternalUrl(value) {
      state.externalUrl = typeof value === 'string' ? value.trim() : '';
      if (!state.file) render();
    },
    reset(externalUrl = '') {
      state.file = null;
      state.externalUrl = externalUrl;
      input.value = '';
      render();
    },
  };
}
