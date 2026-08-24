import { showDialogElement } from '../common/dialog-element.js';

function removeDialog(dialog) {
  if (!(dialog instanceof HTMLDialogElement)) {
    return;
  }
  if (dialog.open) {
    dialog.close();
  }
  dialog.remove();
}

function createGitDialogShell({ title, description, testId }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'wm-dialog wm-dialog-prompt';
  dialog.setAttribute('aria-labelledby', 'wm-git-dialog-title');
  if (description) {
    dialog.setAttribute('aria-describedby', 'wm-git-dialog-description');
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
  heading.id = 'wm-git-dialog-title';
  heading.textContent = title;
  header.append(heading);

  if (description) {
    const subtitle = document.createElement('p');
    subtitle.id = 'wm-git-dialog-description';
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

function createButton({ label, variant = 'primary', testId, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = variant === 'secondary' ? 'wm-button secondary' : 'wm-button';
  button.textContent = label;
  if (testId) {
    button.dataset.testid = testId;
  }
  if (typeof onClick === 'function') {
    button.addEventListener('click', onClick);
  }
  return button;
}

function createField({ label, value = '', placeholder = '', type = 'text' }) {
  const field = document.createElement('label');
  field.className = 'wm-dialog__field';

  const labelEl = document.createElement('span');
  labelEl.className = 'wm-dialog__field-label';
  labelEl.textContent = label;

  const input = document.createElement('input');
  input.type = type;
  input.className = 'wm-dialog__input';
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', label);

  field.append(labelEl, input);
  return { field, input };
}

function buildRemoteSummary(remotes) {
  if (!Array.isArray(remotes) || remotes.length === 0) {
    return 'No remotes configured yet.';
  }

  return remotes
    .map((remote) => {
      const fetchUrl = remote.fetchUrl || '(not set)';
      const pushUrl = remote.pushUrl || '(not set)';
      return `${remote.name}\n  fetch: ${fetchUrl}\n  push:  ${pushUrl}`;
    })
    .join('\n\n');
}

export async function openGitOutputDialog({
  title,
  description = '',
  output = '',
  testId,
}) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return;
  }

  return new Promise((resolve) => {
    const { dialog, body, footer } = createGitDialogShell({ title, description, testId });

    const pre = document.createElement('pre');
    pre.className = 'wm-git-dialog__output';
    pre.textContent = output || 'No output.';
    pre.setAttribute('aria-label', `${title} output`);
    body.append(pre);

    const closeButton = createButton({
      label: 'Close',
      testId: 'dialog-close',
      onClick: () => dialog.close('close'),
    });
    footer.append(closeButton);

    dialog.addEventListener(
      'close',
      () => {
        removeDialog(dialog);
        resolve();
      },
      { once: true },
    );

    document.body.append(dialog);
    showDialogElement(dialog);
    queueMicrotask(() => closeButton.focus());
  });
}

export async function openGitRemoteDialog({
  remotes = [],
  initialRemoteName = 'origin',
  title = 'Git Remote',
  description = 'Check the current remote and add or update a remote URL for this directory.',
  confirmLabel = 'Save Remote',
  testId,
}) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null;
  }

  return new Promise((resolve) => {
    const existingRemote =
      remotes.find((remote) => remote.name === initialRemoteName) ??
      remotes[0] ??
      null;

    const { dialog, form, body, footer } = createGitDialogShell({
      title,
      description,
      testId,
    });

    const summary = document.createElement('pre');
    summary.className = 'wm-git-dialog__output wm-git-dialog__summary';
    summary.textContent = buildRemoteSummary(remotes);
    summary.setAttribute('aria-label', 'Configured git remotes');

    const help = document.createElement('p');
    help.className = 'wm-dialog__status';
    help.textContent = 'If the remote exists, Wingman updates the URL. If it does not, Wingman adds it.';

    const status = document.createElement('p');
    status.className = 'wm-dialog__status';
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const { field: remoteField, input: remoteInput } = createField({
      label: 'Remote name',
      value: existingRemote?.name || initialRemoteName,
      placeholder: 'origin',
    });
    const { field: urlField, input: urlInput } = createField({
      label: 'Remote URL',
      value: existingRemote?.fetchUrl || existingRemote?.pushUrl || '',
      placeholder: 'https://github.com/org/repo.git',
      type: 'url',
    });

    function syncUrlForRemoteName() {
      const match = remotes.find((remote) => remote.name === remoteInput.value.trim());
      if (!match) {
        return;
      }
      const nextUrl = match.fetchUrl || match.pushUrl || '';
      if (nextUrl) {
        urlInput.value = nextUrl;
      }
    }

    remoteInput.addEventListener('change', syncUrlForRemoteName);
    remoteInput.addEventListener('blur', syncUrlForRemoteName);

    body.append(summary, remoteField, urlField, help, status);

    const cancelButton = createButton({
      label: 'Cancel',
      variant: 'secondary',
      testId: 'dialog-cancel',
      onClick: () => dialog.close('cancel'),
    });
    const confirmButton = document.createElement('button');
    confirmButton.type = 'submit';
    confirmButton.className = 'wm-button';
    confirmButton.textContent = confirmLabel;
    confirmButton.dataset.testid = 'dialog-confirm';
    footer.append(cancelButton, confirmButton);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const remote = remoteInput.value.trim();
      const url = urlInput.value.trim();

      if (!remote) {
        status.hidden = false;
        status.textContent = 'Remote name is required.';
        remoteInput.focus();
        return;
      }
      if (!url) {
        status.hidden = false;
        status.textContent = 'Remote URL is required.';
        urlInput.focus();
        return;
      }

      status.hidden = true;
      dialog.close('confirm');
    });

    dialog.addEventListener(
      'close',
      () => {
        const result =
          dialog.returnValue === 'confirm'
            ? {
                remote: remoteInput.value.trim(),
                url: urlInput.value.trim(),
              }
            : null;
        removeDialog(dialog);
        resolve(result);
      },
      { once: true },
    );

    document.body.append(dialog);
    showDialogElement(dialog);
    queueMicrotask(() => {
      remoteInput.focus();
      remoteInput.select();
    });
  });
}

export async function openGitCommitDialog({
  title = 'GitHub Commit',
  description = 'Enter the commit message to use for all staged changes.',
  label = 'Commit message',
  value = '',
  placeholder = '',
  confirmLabel = 'Commit',
  confirmAndPushLabel = 'Commit + Push',
  cancelLabel = 'Cancel',
  testId,
}) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null;
  }

  return new Promise((resolve) => {
    const { dialog, form, body, footer } = createGitDialogShell({
      title,
      description,
      testId,
    });

    const { field, input } = createField({
      label,
      value,
      placeholder,
    });

    const status = document.createElement('p');
    status.className = 'wm-dialog__status';
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    body.append(field, status);

    const cancelButton = createButton({
      label: cancelLabel,
      variant: 'secondary',
      testId: 'dialog-cancel',
      onClick: () => dialog.close('cancel'),
    });

    const confirmAndPushButton = createButton({
      label: confirmAndPushLabel,
      variant: 'secondary',
      testId: 'dialog-confirm-and-push',
      onClick: () => {
        const message = input.value.trim();
        if (!message) {
          status.hidden = false;
          status.textContent = 'Commit message is required.';
          input.focus();
          return;
        }
        status.hidden = true;
        dialog.close('confirm-and-push');
      },
    });

    const confirmButton = document.createElement('button');
    confirmButton.type = 'submit';
    confirmButton.className = 'wm-button';
    confirmButton.textContent = confirmLabel;
    confirmButton.dataset.testid = 'dialog-confirm';

    footer.append(cancelButton, confirmAndPushButton, confirmButton);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) {
        status.hidden = false;
        status.textContent = 'Commit message is required.';
        input.focus();
        return;
      }

      status.hidden = true;
      dialog.close('confirm');
    });

    dialog.addEventListener(
      'close',
      () => {
        const message = input.value.trim();
        const result =
          dialog.returnValue === 'confirm' || dialog.returnValue === 'confirm-and-push'
            ? {
                action: dialog.returnValue === 'confirm-and-push' ? 'commit-and-push' : 'commit',
                message,
              }
            : null;
        removeDialog(dialog);
        resolve(result);
      },
      { once: true },
    );

    document.body.append(dialog);
    showDialogElement(dialog);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  });
}
