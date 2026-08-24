function getSessionWorkingDirectory(sessionsStore, sessionId) {
  const session = sessionsStore().items.find((item) => item.id === sessionId);
  return session?.workingDirectory ?? null;
}

function buildGitActionLabel(action) {
  switch (action) {
    case 'addAll':
      return 'add all';
    case 'listRemotes':
      return 'list remotes';
    case 'setRemote':
      return 'set remote';
    case 'switchBranch':
      return 'switch branch';
    default:
      return action;
  }
}

async function postGitAction({ directory, action, options = {} }) {
  const response = await fetch('/api/docs/git', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      directory,
      action,
      ...options,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : 'Unknown error';
    throw new Error(message);
  }
  return data;
}

export async function executeGitAction({
  sessionsStore,
  sessionId,
  showToast,
  action,
  options = {},
  successMessage = null,
  errorLabel = null,
  showSuccessToast = true,
}) {
  const directory = getSessionWorkingDirectory(sessionsStore, sessionId);
  if (!directory) {
    showToast('No working directory set for this session', { type: 'error' });
    return null;
  }

  const actionLabel = buildGitActionLabel(action);
  const resolvedErrorLabel = errorLabel || `Git ${actionLabel}`;

  try {
    const data = await postGitAction({ directory, action, options });
    if (showSuccessToast) {
      showToast(successMessage || `Git ${actionLabel} successful`, { type: 'success' });
    }
    return data;
  } catch (error) {
    showToast(`${resolvedErrorLabel} failed: ${error.message}`, { type: 'error', duration: 5000 });
    return null;
  }
}

export async function executeGitHubAction({
  sessionsStore,
  sessionId,
  showToast,
  action,
  options = {},
  showSuccessToast = true,
}) {
  const actionLabel = buildGitActionLabel(action);
  return executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action,
    options: {
      remote: 'origin',
      expectedRemoteHost: 'github.com',
      ...options,
    },
    successMessage: `GitHub ${actionLabel} successful`,
    errorLabel: `GitHub ${actionLabel}`,
    showSuccessToast,
  });
}

export function parseGitRemoteList(stdout) {
  const remotes = [];
  const remoteMap = new Map();

  const lines = typeof stdout === 'string' ? stdout.split(/\r?\n/) : [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) {
      continue;
    }

    const [, name, url, role] = match;
    let remote = remoteMap.get(name);
    if (!remote) {
      remote = { name, fetchUrl: '', pushUrl: '' };
      remoteMap.set(name, remote);
      remotes.push(remote);
    }

    if (role === 'fetch') {
      remote.fetchUrl = url;
    } else {
      remote.pushUrl = url;
    }
  }

  return remotes;
}

export function deriveGitHubWebUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string') {
    return null;
  }

  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('https://github.com/')) {
    return trimmed.replace(/\.git$/i, '');
  }

  const sshMatch = trimmed.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
  if (sshMatch?.[1]) {
    return `https://github.com/${sshMatch[1]}`;
  }

  return null;
}
