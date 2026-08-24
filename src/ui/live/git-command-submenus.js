import { createGitHubMenuItems } from './git-github-menu.js';
import { createGitMenuItems } from './git-local-menu.js';

export function addGitCommandSubmenus({
  addSubmenu,
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
  forkSessionToWorktreeApi,
}) {
  addSubmenu('Git', createGitMenuItems({
    sessionId,
    sessionsStore,
    openTextPromptDialog,
    showToast,
  }));

  addSubmenu('GitHub', createGitHubMenuItems({
    sessionId,
    sessionsStore,
    openTextPromptDialog,
    showToast,
    forkSessionToWorktreeApi,
  }));

}
