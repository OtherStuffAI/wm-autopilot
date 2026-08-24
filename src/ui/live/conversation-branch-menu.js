function getSessionName(session) {
  const name = typeof session?.name === 'string' ? session.name.trim() : '';
  return name || session?.id || 'session';
}

export async function promptConversationBranch({
  sessionId,
  sessionsStore,
  openTextPromptDialog,
  showToast,
  branchConversationApi,
}) {
  const session = sessionsStore().items.find((item) => item.id === sessionId);
  if (!session) {
    showToast('Session not available', { type: 'error' });
    return;
  }

  const sourceName = getSessionName(session);
  const branchName = await openTextPromptDialog({
    title: 'Branch Conversation',
    description: 'Create an independent session with this conversation as context.',
    label: 'Branch name',
    value: `${sourceName} (branch)`,
    confirmLabel: 'Create',
    testId: 'live-view-conversation-branch-dialog',
    validate: (value) => (value ? '' : 'Branch name is required.'),
  });
  if (!branchName) {
    return;
  }

  showToast('Creating conversation branch...', { type: 'info' });

  try {
    const result = await branchConversationApi(sessionId, {
      name: branchName,
    });
    if (!result.session?.id) {
      throw new Error('Branch did not return a new session.');
    }
    window.open(`/live/${result.session.id}`, '_blank', 'noopener');
    showToast('Conversation branch created', { type: 'success', duration: 5000 });
  } catch (error) {
    showToast(`Branch failed: ${error.message}`, { type: 'error', duration: 5000 });
  }
}
