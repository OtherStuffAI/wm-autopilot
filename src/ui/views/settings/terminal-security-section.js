import { replaceTerminalPin } from '../../services/terminal-settings.js';

export function createTerminalSecuritySection({ configured, onSaved, notify }) {
  const card = document.createElement('section');
  card.className = 'wm-card';
  card.dataset.testid = 'terminal-security-settings';
  card.setAttribute('aria-labelledby', 'terminal-security-title');

  const title = document.createElement('h2');
  title.id = 'terminal-security-title';
  title.textContent = 'Terminal access';
  const description = document.createElement('p');
  description.textContent = configured
    ? 'Terminal access is enabled. Replace the PIN below to revoke outstanding terminal tickets and stop the old PIN.'
    : 'Terminal access is disabled until an administrator sets a PIN.';

  const form = document.createElement('form');
  form.dataset.testid = 'terminal-pin-settings-form';
  const pinLabel = document.createElement('label');
  pinLabel.htmlFor = 'terminal-settings-pin';
  pinLabel.textContent = configured ? 'New terminal PIN' : 'Terminal PIN';
  const pin = document.createElement('input');
  pin.id = 'terminal-settings-pin';
  pin.type = 'password';
  pin.inputMode = 'numeric';
  pin.autocomplete = 'new-password';
  pin.pattern = '\\d{5}';
  pin.maxLength = 5;
  pin.required = true;
  pin.setAttribute('aria-label', pinLabel.textContent);
  pin.dataset.testid = 'terminal-settings-pin';

  const confirmationLabel = document.createElement('label');
  confirmationLabel.htmlFor = 'terminal-settings-pin-confirmation';
  confirmationLabel.textContent = 'Confirm terminal PIN';
  const confirmation = document.createElement('input');
  confirmation.id = 'terminal-settings-pin-confirmation';
  confirmation.type = 'password';
  confirmation.inputMode = 'numeric';
  confirmation.autocomplete = 'new-password';
  confirmation.pattern = '\\d{5}';
  confirmation.maxLength = 5;
  confirmation.required = true;
  confirmation.setAttribute('aria-label', 'Confirm terminal PIN');
  confirmation.dataset.testid = 'terminal-settings-pin-confirmation';

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'wm-button';
  submit.textContent = configured ? 'Replace PIN' : 'Enable terminal';
  submit.setAttribute('aria-label', submit.textContent);
  submit.dataset.testid = 'terminal-settings-save';

  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.dataset.testid = 'terminal-settings-status';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!/^\d{5}$/.test(pin.value) || pin.value !== confirmation.value) {
      status.textContent = 'Enter the same 5 digit PIN in both fields.';
      pin.focus();
      return;
    }
    submit.disabled = true;
    try {
      await replaceTerminalPin(pin.value, confirmation.value);
      pin.value = '';
      confirmation.value = '';
      status.textContent = 'Terminal PIN saved. Existing terminal tickets were revoked.';
      notify?.('Terminal PIN saved', { type: 'success' });
      await onSaved?.();
    } catch (error) {
      status.textContent = error?.message || 'Failed to save terminal PIN';
    } finally {
      submit.disabled = false;
    }
  });

  form.append(pinLabel, pin, confirmationLabel, confirmation, submit, status);
  card.append(title, description, form);
  return card;
}
