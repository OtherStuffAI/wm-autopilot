function removeDialog(dialog) {
  if (!(dialog instanceof HTMLDialogElement)) {
    return;
  }
  if (dialog.open) {
    dialog.close();
  }
  dialog.remove();
}

function appendDialogToBody(dialog) {
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
    return;
  }
  dialog.setAttribute('open', 'open');
}

function hasDocumentDialogSupport() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function createDialogShell({ title, description, testId }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'wm-dialog wm-dialog-prompt';
  dialog.setAttribute('aria-labelledby', 'wm-dialog-prompt-title');
  if (description) {
    dialog.setAttribute('aria-describedby', 'wm-dialog-prompt-description');
  }
  if (testId) {
    dialog.dataset.testid = testId;
  }

  const form = document.createElement('form');
  form.className = 'wm-dialog__form';
  form.method = 'dialog';

  const header = document.createElement('header');
  header.className = 'wm-dialog__header';

  const heading = document.createElement('h2');
  heading.id = 'wm-dialog-prompt-title';
  heading.textContent = title;
  header.append(heading);

  if (description) {
    const subtitle = document.createElement('p');
    subtitle.id = 'wm-dialog-prompt-description';
    subtitle.className = 'wm-dialog__subtitle';
    subtitle.textContent = description;
    header.append(subtitle);
  }

  const body = document.createElement('section');
  body.className = 'wm-dialog__body';

  const footer = document.createElement('menu');
  footer.className = 'wm-dialog__menu';

  form.append(header, body, footer);
  dialog.append(form);

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      dialog.close('cancel');
    }
  });

  return { dialog, form, body, footer };
}

export async function openTextPromptDialog({
  title,
  description = '',
  label,
  value = '',
  placeholder = '',
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  validate,
  testId,
} = {}) {
  if (!hasDocumentDialogSupport()) {
    if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
      const fallbackValue = window.prompt(title || label || 'Enter value', value);
      return typeof fallbackValue === 'string' ? fallbackValue.trim() : null;
    }
    return null;
  }

  return new Promise((resolve) => {
    const { dialog, form, body, footer } = createDialogShell({ title, description, testId });

    const field = document.createElement('label');
    field.className = 'wm-dialog__field';

    const labelEl = document.createElement('span');
    labelEl.className = 'wm-dialog__field-label';
    labelEl.textContent = label;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wm-dialog__input';
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', label);

    const status = document.createElement('p');
    status.className = 'wm-dialog__status';
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    field.append(labelEl, input);
    body.append(field, status);

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'wm-button secondary';
    cancelButton.value = 'cancel';
    cancelButton.textContent = cancelLabel;
    cancelButton.dataset.testid = 'dialog-cancel';
    cancelButton.addEventListener('click', () => {
      dialog.close('cancel');
    });

    const confirmButton = document.createElement('button');
    confirmButton.type = 'submit';
    confirmButton.className = 'wm-button';
    confirmButton.value = 'confirm';
    confirmButton.textContent = confirmLabel;
    confirmButton.dataset.testid = 'dialog-confirm';

    footer.append(cancelButton, confirmButton);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const nextValue = input.value.trim();
      const validationError = typeof validate === 'function' ? validate(nextValue) : '';
      if (validationError) {
        status.hidden = false;
        status.textContent = validationError;
        input.focus();
        return;
      }
      dialog.close('confirm');
    });

    dialog.addEventListener(
      'close',
      () => {
        const result = dialog.returnValue === 'confirm' ? input.value.trim() : null;
        removeDialog(dialog);
        resolve(result);
      },
      { once: true },
    );

    appendDialogToBody(dialog);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  });
}

export async function openConfirmDialog({
  title,
  description = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  testId,
} = {}) {
  if (!hasDocumentDialogSupport()) {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(description || title || 'Are you sure?');
    }
    return false;
  }

  return new Promise((resolve) => {
    const { dialog, footer } = createDialogShell({ title, description, testId });

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'wm-button secondary';
    cancelButton.value = 'cancel';
    cancelButton.textContent = cancelLabel;
    cancelButton.dataset.testid = 'dialog-cancel';
    cancelButton.addEventListener('click', () => {
      dialog.close('cancel');
    });

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'wm-button';
    confirmButton.value = 'confirm';
    confirmButton.textContent = confirmLabel;
    confirmButton.dataset.testid = 'dialog-confirm';
    confirmButton.addEventListener('click', () => {
      dialog.close('confirm');
    });

    footer.append(cancelButton, confirmButton);

    dialog.addEventListener(
      'close',
      () => {
        const confirmed = dialog.returnValue === 'confirm';
        removeDialog(dialog);
        resolve(confirmed);
      },
      { once: true },
    );

    appendDialogToBody(dialog);
    queueMicrotask(() => {
      confirmButton.focus();
    });
  });
}
