import {
  backupEnvFile,
  cleanupEnvFile,
  deleteInstanceSetting,
  fetchInstanceSettings,
  importInstanceSettings,
  saveInstanceSetting,
} from '../../services/instance-settings.js';
import {
  createButton,
  createCleanupNotice,
  createHeader,
  createImportPanel,
  createSettingsPanel,
  createStatus,
} from './instance-settings-elements.js';

export function createInstanceSettingsSection() {
  const card = document.createElement('section');
  card.className = 'wm-card wm-instance-settings';
  card.setAttribute('data-testid', 'instance-settings-section');

  const status = createStatus();
  status.textContent = 'Loading settings...';

  const actions = document.createElement('div');
  actions.className = 'wm-instance-settings__actions';
  const reloadButton = createButton('Reload');
  reloadButton.setAttribute('aria-label', 'Reload instance settings');
  reloadButton.setAttribute('data-testid', 'instance-settings-reload');
  const importButton = createButton('Import selected', 'wm-button');
  importButton.setAttribute('aria-label', 'Import selected environment settings');
  importButton.setAttribute('data-testid', 'instance-settings-import-selected');
  const backupButton = createButton('Back up env');
  backupButton.setAttribute('aria-label', 'Back up env file');
  backupButton.setAttribute('data-testid', 'instance-settings-backup-env');
  const cleanupButton = createButton('Clean up env');
  cleanupButton.setAttribute('aria-label', 'Remove selected imported keys from env file');
  cleanupButton.setAttribute('data-testid', 'instance-settings-cleanup-env');
  actions.append(reloadButton, importButton, backupButton, cleanupButton);

  const body = document.createElement('div');
  body.className = 'wm-instance-settings__body';
  const selectedKeys = new Set();
  let latestPayload = null;
  let editingKey = null;
  let selectionInitialized = false;

  const setStatus = (message) => {
    status.textContent = message;
  };

  const renderPayload = (payload, options = {}) => {
    latestPayload = payload;
    if (!options.preserveSelection) {
      selectedKeys.clear();
      selectionInitialized = false;
    }
    body.replaceChildren();
    body.append(createCleanupNotice(payload));

    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    if (candidates.length > 0) {
      body.append(createImportPanel(candidates, selectedKeys, !selectionInitialized));
      selectionInitialized = true;
    }

    const settings = Array.isArray(payload.settings)
      ? payload.settings.filter((setting) => (
        setting.category !== 'branding' && setting.key !== 'models.providers'
      ))
      : [];
    body.append(createSettingsPanel(settings, {
      editingKey,
      onEdit: (key) => {
        editingKey = key;
        if (latestPayload) renderPayload(latestPayload, { preserveSelection: true });
      },
      onSave: async (setting, nextValue) => {
        try {
          await saveInstanceSetting(setting.key, nextValue);
          editingKey = null;
          setStatus(`${setting.label} saved`);
          await load();
        } catch (error) {
          setStatus(error?.message || 'Save failed');
        }
      },
      onDelete: async (setting) => {
        try {
          await deleteInstanceSetting(setting.key);
          setStatus(`${setting.label} deleted`);
          await load();
        } catch (error) {
          setStatus(error?.message || 'Delete failed');
        }
      },
    }));

    cleanupButton.disabled = payload.cleanupStatus !== 'cleanupSupported';
    backupButton.disabled = payload.cleanupStatus !== 'cleanupSupported';
    importButton.disabled = candidates.length === 0;
  };

  async function load() {
    reloadButton.disabled = true;
    try {
      const payload = await fetchInstanceSettings();
      editingKey = null;
      renderPayload(payload);
      setStatus('Settings loaded');
    } catch (error) {
      body.replaceChildren();
      setStatus(error?.message || 'Failed to load settings');
    } finally {
      reloadButton.disabled = false;
    }
  }

  reloadButton.addEventListener('click', () => {
    void load();
  });

  importButton.addEventListener('click', async () => {
    const keys = Array.from(selectedKeys);
    if (keys.length === 0) {
      setStatus('Select at least one setting to import');
      return;
    }
    importButton.disabled = true;
    try {
      const result = await importInstanceSettings(keys);
      setStatus(`Imported ${result.imported?.length || 0} setting(s)`);
      await load();
    } catch (error) {
      setStatus(error?.message || 'Import failed');
    } finally {
      importButton.disabled = false;
    }
  });

  backupButton.addEventListener('click', async () => {
    backupButton.disabled = true;
    try {
      const result = await backupEnvFile();
      setStatus(`Env backed up to ${result.backupPath}`);
      await load();
    } catch (error) {
      setStatus(error?.message || 'Backup failed');
    } finally {
      backupButton.disabled = latestPayload?.cleanupStatus !== 'cleanupSupported';
    }
  });

  cleanupButton.addEventListener('click', async () => {
    const keys = Array.from(selectedKeys);
    if (keys.length === 0) {
      setStatus('Select imported settings before cleanup');
      return;
    }
    cleanupButton.disabled = true;
    try {
      const result = await cleanupEnvFile(keys);
      setStatus(`Removed ${result.removedKeys?.length || 0} env key(s); backup ${result.backupPath}`);
      await load();
    } catch (error) {
      setStatus(error?.message || 'Cleanup failed');
    } finally {
      cleanupButton.disabled = latestPayload?.cleanupStatus !== 'cleanupSupported';
    }
  });

  card.append(createHeader(actions, status), body);
  void load();
  return card;
}
