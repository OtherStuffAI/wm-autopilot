import { openConfirmDialog } from '../common/dialog-prompts.js';
import { executeGitAction } from './git-command-api.js';
import { openGitOutputDialog } from './git-dialogs.js';

function isValidBranchName(branch) {
  return /^[a-zA-Z0-9._/-]+$/.test(branch);
}

async function showGitStatus({ sessionsStore, sessionId, showToast }) {
  const result = await executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'status',
    showSuccessToast: false,
  });
  if (!result) {
    return;
  }

  await openGitOutputDialog({
    title: 'Git Status',
    description: 'Current branch and working tree state for this session directory.',
    output: result.stdout,
    testId: 'live-view-git-status-dialog',
  });
}

async function promptSwitchBranch({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
}) {
  const branch = await openTextPromptDialog({
    title: 'Switch Git Branch',
    description: 'Enter the branch name to switch this directory to.',
    label: 'Branch name',
    value: '',
    confirmLabel: 'Switch',
    testId: 'live-view-git-branch-dialog',
    validate: (value) => {
      if (!value) {
        return 'Branch name is required.';
      }
      return isValidBranchName(value)
        ? ''
        : 'Invalid branch name. Use alphanumeric characters, dots, underscores, slashes, and hyphens.';
    },
  });
  if (!branch) {
    return;
  }

  await executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'switchBranch',
    options: { branch },
    successMessage: `Switched to branch "${branch}"`,
    errorLabel: `Git switch branch "${branch}"`,
  });
}

async function confirmGitInit({ sessionsStore, sessionId, showToast }) {
  const confirmed = await openConfirmDialog({
    title: 'Initialize Git Repository',
    description: 'This will run git init in the current session directory. Continue only if this folder is intended to become a repository root.',
    confirmLabel: 'Run Git Init',
    cancelLabel: 'Cancel',
    testId: 'live-view-git-init-confirm-dialog',
  });
  if (!confirmed) {
    return;
  }

  await executeGitAction({
    sessionsStore,
    sessionId,
    showToast,
    action: 'init',
  });
}

export function createGitMenuItems({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
}) {
  return [
    {
      label: 'Status',
      handler: () => showGitStatus({ sessionsStore, sessionId, showToast }),
    },
    {
      label: 'Add All',
      handler: () => executeGitAction({
        sessionsStore,
        sessionId,
        showToast,
        action: 'addAll',
        successMessage: 'Git add all successful',
      }),
    },
    {
      label: 'Switch Branch...',
      handler: () => promptSwitchBranch({ sessionId, sessionsStore, openTextPromptDialog, showToast }),
    },
    {
      label: 'Init',
      handler: () => confirmGitInit({ sessionsStore, sessionId, showToast }),
    },
  ];
}
