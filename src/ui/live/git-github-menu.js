import { deriveGitHubWebUrl, executeGitAction, executeGitHubAction, parseGitRemoteList } from './git-command-api.js';
import { openGitCommitDialog, openGitRemoteDialog } from './git-dialogs.js';

function isValidBranchName(branch) {
  return /^[a-zA-Z0-9._/-]+$/.test(branch);
}

function isGitHubHttpsRemoteUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }

  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}

async function promptGitHubRemote({
  sessionsStore,
  sessionId,
  showToast,
}) {
  const listResult = await executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'listRemotes',
    showSuccessToast: false,
    errorLabel: 'GitHub remote lookup',
  });
  if (!listResult) {
    return;
  }

  const remoteInput = await openGitRemoteDialog({
    remotes: parseGitRemoteList(listResult.stdout),
    initialRemoteName: 'origin',
    title: 'GitHub Remote',
    description: 'Set the GitHub HTTPS remote used by PAT-authenticated pull and push actions.',
    confirmLabel: 'Save GitHub Remote',
    testId: 'live-view-github-remote-dialog',
  });
  if (!remoteInput) {
    return;
  }

  if (!isGitHubHttpsRemoteUrl(remoteInput.url)) {
    showToast('GitHub remote must use an HTTPS github.com URL so the personal access token helper can authenticate push and pull.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  await executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'setRemote',
    options: {
      remote: remoteInput.remote,
      remoteUrl: remoteInput.url,
    },
    successMessage: `GitHub remote "${remoteInput.remote}" saved`,
    errorLabel: `GitHub remote "${remoteInput.remote}"`,
  });
}

async function openGitHubRepo({ sessionsStore, sessionId, showToast }) {
  const listResult = await executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'listRemotes',
    showSuccessToast: false,
    errorLabel: 'GitHub remote lookup',
  });
  if (!listResult) {
    return;
  }

  const remotes = parseGitRemoteList(listResult.stdout);
  const origin = remotes.find((remote) => remote.name === 'origin') ?? remotes[0] ?? null;
  const remoteUrl = origin?.fetchUrl || origin?.pushUrl || '';
  const webUrl = deriveGitHubWebUrl(remoteUrl);

  if (!webUrl) {
    showToast('No GitHub remote configured. Set an origin remote first.', { type: 'warning', duration: 4000 });
    return;
  }

  window.open(webUrl, '_blank', 'noopener');
}

async function promptGitHubCommit({
  sessionId,
  sessionsStore,
  showToast,
}) {
  const commitInput = await openGitCommitDialog({
    title: 'GitHub Commit',
    description: 'Enter the commit message to use for all staged changes.',
    label: 'Commit message',
    testId: 'live-view-github-commit-dialog',
  });
  if (!commitInput) {
    return;
  }

  const addResult = await executeGitHubAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'addAll',
    showSuccessToast: false,
  });
  if (!addResult) {
    return;
  }

  const commitResult = await executeGitHubAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'commit',
    options: { message: commitInput.message },
  });
  if (!commitResult || commitInput.action !== 'commit-and-push') {
    return;
  }

  await executeGitHubAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'push',
  });
}

async function promptWorktreeFork({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
  forkSessionToWorktreeApi,
}) {
  const session = sessionsStore().items.find((item) => item.id === sessionId);
  const directory = session?.workingDirectory ?? null;
  if (!directory) {
    showToast('No working directory set for this session', { type: 'error' });
    return;
  }

  const trimmedBranch = await openTextPromptDialog({
    title: 'Fork To Worktree',
    description: 'Create a new worktree and session with the last 5 messages as context.',
    label: 'Branch name',
    value: '',
    confirmLabel: 'Create',
    testId: 'live-view-worktree-branch-dialog',
    validate: (value) => (value ? '' : 'Branch name is required.'),
  });
  if (!trimmedBranch) {
    return;
  }
  if (!isValidBranchName(trimmedBranch)) {
    showToast('Invalid branch name. Use alphanumeric characters, dots, underscores, and hyphens.', { type: 'error' });
    return;
  }

  showToast(`Creating worktree "${trimmedBranch}"...`, { type: 'info' });

  try {
    const result = await forkSessionToWorktreeApi(sessionId, trimmedBranch, 5);
    if (result.session?.id) {
      if (result.initialPrompt) {
        try {
          localStorage.setItem(`session-draft-${result.session.id}`, result.initialPrompt);
          localStorage.setItem(`session-autosubmit-${result.session.id}`, 'true');
        } catch {
          // Ignore localStorage errors.
        }
      }

      window.open(`/live/${result.session.id}`, '_blank', 'noopener');
      showToast(`Forked to worktree: ${result.worktreePath}`, { type: 'success', duration: 5000 });
    }
  } catch (error) {
    showToast(`Fork failed: ${error.message}`, { type: 'error', duration: 5000 });
  }
}

export function createGitHubMenuItems({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
  forkSessionToWorktreeApi,
}) {
  return [
    {
      label: 'Go to repo',
      handler: () => openGitHubRepo({ sessionsStore, sessionId, showToast }),
    },
    {
      label: 'Remote...',
      handler: () => promptGitHubRemote({ sessionsStore, sessionId, showToast }),
    },
    {
      label: 'Pull',
      handler: () => executeGitHubAction({ sessionsStore, sessionId, showToast, action: 'pull' }),
    },
    {
      label: 'Push',
      handler: () => executeGitHubAction({ sessionsStore, sessionId, showToast, action: 'push' }),
    },
    {
      label: 'Commit...',
      handler: () => promptGitHubCommit({ sessionId, sessionsStore, showToast }),
    },
    {
      label: 'Fork to Worktree...',
      handler: () => promptWorktreeFork({
        sessionId,
        sessionsStore,
        openTextPromptDialog,
        showToast,
        forkSessionToWorktreeApi,
      }),
    },
  ];
}
