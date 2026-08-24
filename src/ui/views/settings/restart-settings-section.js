import { openConfirmDialog } from '../../common/dialog-prompts.js';

function createPolicyRow(label, value) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  row.append(term, description);
  return row;
}

function describeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'Ready to restart.';
  const resumed = Array.isArray(outcome.resumedSessions) ? outcome.resumedSessions.length : 0;
  const fresh = Array.isArray(outcome.freshSessions) ? outcome.freshSessions.length : 0;
  const failed = Array.isArray(outcome.failed) ? outcome.failed.length : 0;
  const parts = [`Last restart: ${resumed} resumed`, `${fresh} started fresh`];
  if (failed > 0) parts.push(`${failed} failed`);
  return `${parts.join(', ')}.`;
}

export function createRestartSettingsSection({ getRestartState, triggerRestart }) {
  const card = document.createElement('section');
  card.className = 'wm-card wm-restart-settings';
  card.dataset.testid = 'restart-settings-section';

  const heading = document.createElement('h2');
  heading.textContent = 'Restart Autopilot';
  const introduction = document.createElement('p');
  introduction.textContent = 'One restart policy is used here, by the API, and by the CLI.';

  const policy = document.createElement('dl');
  policy.className = 'wm-restart-settings__policy';
  policy.append(
    createPolicyRow('Session recovery', 'Resume the native agent session when possible; otherwise start a fresh replacement.'),
    createPolicyRow('Process handling', 'Stop active agent processes before Autopilot restarts.'),
    createPolicyRow('Active turns', 'An in-flight turn may be interrupted and should be checked after restart.'),
  );

  const status = document.createElement('p');
  status.className = 'wm-restart-settings__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.dataset.testid = 'restart-settings-status';

  const actions = document.createElement('div');
  actions.className = 'wm-restart-settings__actions';
  const restartButton = document.createElement('button');
  restartButton.type = 'button';
  restartButton.className = 'wm-button';
  restartButton.textContent = 'Restart Autopilot';
  restartButton.setAttribute('aria-label', 'Restart Autopilot and recover active agent sessions');
  restartButton.dataset.testid = 'restart-autopilot';
  actions.append(restartButton);

  const renderState = () => {
    const restartState = getRestartState?.() ?? {};
    const busy = Boolean(restartState.submitting || restartState.inProgress);
    restartButton.disabled = busy;
    restartButton.textContent = busy ? 'Restarting…' : 'Restart Autopilot';
    if (restartState.error) {
      status.textContent = restartState.error;
      status.dataset.state = 'error';
    } else if (restartState.inProgress) {
      const count = Array.isArray(restartState.marker?.sessionIds)
        ? restartState.marker.sessionIds.length
        : 0;
      status.textContent = `Restart in progress. ${count} session${count === 1 ? '' : 's'} queued for recovery.`;
      status.dataset.state = 'working';
    } else {
      status.textContent = describeOutcome(restartState.outcome);
      status.dataset.state = 'ready';
    }
  };

  restartButton.addEventListener('click', async () => {
    const confirmed = await openConfirmDialog({
      title: 'Restart Autopilot?',
      description: 'Active agent processes will stop. Sessions will resume natively when possible and otherwise start fresh. In-flight turns may be interrupted.',
      confirmLabel: 'Restart Autopilot',
      testId: 'restart-autopilot-confirmation',
    });
    if (!confirmed) return;
    restartButton.disabled = true;
    restartButton.textContent = 'Restarting…';
    status.dataset.state = 'working';
    status.textContent = 'Scheduling restart and session recovery…';
    const success = await triggerRestart();
    renderState();
    if (!success && !getRestartState?.()?.error) {
      status.dataset.state = 'error';
      status.textContent = 'Failed to schedule restart.';
    }
  });

  card.append(heading, introduction, policy, status, actions);
  renderState();
  return card;
}
