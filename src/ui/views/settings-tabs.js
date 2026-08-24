function createNavigationItem(tabDef, currentTabId, activatePage) {
  const button = document.createElement('button');
  const isActive = tabDef.id === currentTabId;
  button.type = 'button';
  button.className = `wm-settings-nav__item${isActive ? ' is-active' : ''}`;
  button.dataset.tabId = tabDef.id;
  button.dataset.testid = `settings-nav-${tabDef.id}`;
  button.textContent = tabDef.label;
  button.setAttribute('aria-current', isActive ? 'page' : 'false');
  button.setAttribute('aria-label', `Open ${tabDef.label} settings`);
  button.addEventListener('click', () => activatePage(tabDef.id, { focusContent: true }));
  return button;
}

export function createSettingsTabs({ tabDefs, activeTabId, onTabChange }) {
  const shell = document.createElement('div');
  shell.className = 'wm-settings-shell';

  const available = new Map(tabDefs.map((tabDef) => [tabDef.id, tabDef]));
  let currentTabId = available.has(activeTabId) ? activeTabId : tabDefs[0]?.id;

  const desktopNav = document.createElement('nav');
  desktopNav.className = 'wm-settings-nav';
  desktopNav.setAttribute('aria-label', 'Settings navigation');
  desktopNav.dataset.testid = 'settings-navigation';

  const desktopTitle = document.createElement('p');
  desktopTitle.className = 'wm-settings-nav__title';
  desktopTitle.textContent = 'Settings';

  const mobileLabel = document.createElement('label');
  mobileLabel.className = 'wm-settings-mobile-nav';
  const mobileLabelText = document.createElement('span');
  mobileLabelText.textContent = 'Settings section';
  const mobileSelect = document.createElement('select');
  mobileSelect.className = 'wm-input';
  mobileSelect.setAttribute('aria-label', 'Settings section');
  mobileSelect.dataset.testid = 'settings-mobile-navigation';
  tabDefs.filter((tabDef) => !tabDef.hidden).forEach((tabDef) => {
    const option = document.createElement('option');
    option.value = tabDef.id;
    option.textContent = `${tabDef.group}: ${tabDef.label}`;
    mobileSelect.append(option);
  });
  mobileLabel.append(mobileLabelText, mobileSelect);

  const panel = document.createElement('section');
  panel.className = 'wm-settings-shell__content';
  panel.dataset.testid = 'settings-page-content';
  panel.setAttribute('aria-live', 'polite');

  function renderNavigation() {
    desktopNav.replaceChildren(desktopTitle);
    const groups = new Map();
    tabDefs.filter((tabDef) => !tabDef.hidden).forEach((tabDef) => {
      const list = groups.get(tabDef.group) || [];
      list.push(tabDef);
      groups.set(tabDef.group, list);
    });
    groups.forEach((items, group) => {
      const section = document.createElement('section');
      section.className = 'wm-settings-nav__group';
      const heading = document.createElement('h2');
      heading.className = 'wm-settings-nav__group-label';
      heading.textContent = group;
      section.append(heading, ...items.map((item) => createNavigationItem(item, currentTabId, activatePage)));
      desktopNav.append(section);
    });
    mobileSelect.value = currentTabId;
  }

  function activatePage(tabId, { focusContent = false } = {}) {
    const tabDef = available.get(tabId) || tabDefs[0];
    if (!tabDef) return;
    currentTabId = tabDef.id;
    panel.replaceChildren(tabDef.render());
    renderNavigation();
    onTabChange?.(tabDef.id);
    if (focusContent) {
      const heading = panel.querySelector?.('h1');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }
  }

  mobileSelect.addEventListener('change', () => activatePage(mobileSelect.value, { focusContent: true }));
  shell.append(desktopNav, mobileLabel, panel);
  activatePage(currentTabId);
  return shell;
}
