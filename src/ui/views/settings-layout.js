export function createSettingsGrid(name, ...content) {
  const grid = document.createElement('div');
  grid.className = `wm-settings-grid wm-settings-grid--${name}`;
  grid.dataset.testid = `settings-grid-${name}`;
  grid.append(...content.filter(Boolean));
  return grid;
}

export function createSettingsCard(content, { className = '', testId = '' } = {}) {
  const card = document.createElement('section');
  card.className = `wm-card wm-settings-card${className ? ` ${className}` : ''}`;
  if (testId) card.dataset.testid = testId;
  card.append(content);
  return card;
}
