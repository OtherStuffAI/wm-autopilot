import { HOME_SESSION_GROUPS } from './session-groups.js';

export function createSessionGroupTabs(activeGroup, groupCounts, onGroupChange) {
  const shell = document.createElement('div');
  shell.className = 'wm-home-session-groups';

  const tabList = document.createElement('div');
  tabList.className = 'wm-home-session-groups__list';
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'Session categories');

  const tabButtons = [];
  let currentGroupId = activeGroup;

  function activateTab(groupId, options = {}) {
    currentGroupId = groupId;
    tabButtons.forEach((button) => {
      const isActive = button.dataset.groupId === groupId;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      button.setAttribute('tabindex', isActive ? '0' : '-1');
    });
    if (options.notify !== false) {
      onGroupChange(groupId);
    }
    if (options.focus) {
      const activeButton = tabButtons.find((button) => button.dataset.groupId === groupId);
      activeButton?.focus();
    }
  }

  HOME_SESSION_GROUPS.forEach((group) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wm-home-session-group';
    button.dataset.groupId = group.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `wm-home-session-panel-${group.id}`);
    button.setAttribute('data-testid', `home-session-group-${group.id}`);

    const label = document.createElement('span');
    label.className = 'wm-home-session-group__label';
    label.textContent = group.label;

    const count = document.createElement('span');
    count.className = 'wm-home-session-group__count';
    count.textContent = String(groupCounts[group.id] ?? 0);

    button.append(label, count);
    button.addEventListener('click', () => activateTab(group.id));
    tabList.append(button);
    tabButtons.push(button);
  });

  tabList.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    const currentIndex = tabButtons.findIndex((button) => button.dataset.groupId === currentGroupId);
    if (currentIndex < 0) {
      return;
    }
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (currentIndex + offset + tabButtons.length) % tabButtons.length;
    const nextButton = tabButtons[nextIndex];
    if (!nextButton?.dataset.groupId) {
      return;
    }
    activateTab(nextButton.dataset.groupId, { focus: true });
    event.preventDefault();
  });

  shell.append(tabList);
  activateTab(activeGroup, { notify: false });
  return shell;
}
