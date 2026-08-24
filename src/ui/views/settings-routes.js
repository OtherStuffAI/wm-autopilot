const SETTINGS_ROUTE = '/settings';
const WORKSPACE_SUBVIEWS = new Set(['overview', 'agent', 'routing', 'advanced']);

export const SETTINGS_PAGE_PATHS = Object.freeze({
  profile: '/settings/profile',
  credentials: '/settings/credentials',
  speech: '/settings/speech',
  workspaces: '/settings/automation/workspaces',
  agentProfiles: '/settings/automation/agent-profiles',
  remote: '/settings/automation/remote-instruct',
  models: '/settings/models',
  hosting: '/settings/app-hosting',
  restart: '/settings/restart',
  system: '/settings/system',
  access: '/settings/access',
  billing: '/settings/billing',
  appearance: '/settings/appearance',
  flags: '/settings/feature-flags',
  starter: '/settings/starter-projects',
});

export const ADMIN_SETTINGS_PAGE_IDS = new Set([
  'agentProfiles',
  'restart',
  'system',
  'access',
  'billing',
  'appearance',
  'flags',
  'starter',
]);

function legacyAdminDestination(hash) {
  const anchor = String(hash || '').replace(/^#/, '').toLowerCase();
  if (anchor.includes('billing')) return 'billing';
  if (anchor.includes('brand') || anchor.includes('appearance')) return 'appearance';
  if (anchor.includes('feature')) return 'flags';
  if (anchor.includes('starter')) return 'starter';
  if (anchor.includes('remote')) return 'remote';
  return 'system';
}

function legacyWorkspaceDestination(hash) {
  const anchor = String(hash || '').replace(/^#/, '').toLowerCase();
  if (anchor.includes('speech') || anchor.includes('voice')) return 'speech';
  if (anchor.includes('host') || anchor.includes('routing') || anchor.includes('port')) return 'hosting';
  return 'credentials';
}

export function getWorkspaceSettingsPath(subscriptionId = '', subview = 'overview') {
  const base = SETTINGS_PAGE_PATHS.workspaces;
  if (!subscriptionId) return base;
  const safeSubview = WORKSPACE_SUBVIEWS.has(subview) ? subview : 'overview';
  return `${base}/${encodeURIComponent(subscriptionId)}/${safeSubview}`;
}

export function resolveSettingsRoute(pathname, { hash = '', isAdmin = false } = {}) {
  const path = String(pathname || SETTINGS_ROUTE).replace(/\/+$/, '') || SETTINGS_ROUTE;
  let pageId = null;
  let canonicalPath = null;
  let subscriptionId = null;
  let subview = 'overview';
  let externalPath = null;

  const workspaceMatch = path.match(/^\/settings\/automation\/workspaces(?:\/([^/]+)(?:\/([^/]+))?)?$/);
  if (workspaceMatch) {
    pageId = 'workspaces';
    subscriptionId = workspaceMatch[1] ? decodeURIComponent(workspaceMatch[1]) : null;
    subview = WORKSPACE_SUBVIEWS.has(workspaceMatch[2]) ? workspaceMatch[2] : 'overview';
    canonicalPath = getWorkspaceSettingsPath(subscriptionId || '', subview);
  } else if (path === SETTINGS_ROUTE || path === '/settings/profile') {
    pageId = 'profile';
    canonicalPath = SETTINGS_PAGE_PATHS.profile;
  } else if (path === '/settings/workspace') {
    pageId = legacyWorkspaceDestination(hash);
    canonicalPath = SETTINGS_PAGE_PATHS[pageId];
  } else if (['/settings/flightdeck', '/settings/flight-deck', '/settings/agents'].includes(path)
    || /^\/settings\/(?:flightdeck|flight-deck|agents)\//.test(path)) {
    const legacyId = path.split('/')[3] || '';
    pageId = 'workspaces';
    subscriptionId = legacyId ? decodeURIComponent(legacyId) : null;
    canonicalPath = getWorkspaceSettingsPath(subscriptionId || '', 'overview');
  } else if (path === '/settings/users') {
    pageId = 'access';
    canonicalPath = SETTINGS_PAGE_PATHS.access;
  } else if (path === '/settings/projects') {
    externalPath = '/projects';
  } else if (path === '/settings/admin') {
    pageId = legacyAdminDestination(hash);
    canonicalPath = SETTINGS_PAGE_PATHS[pageId];
  } else {
    pageId = Object.entries(SETTINGS_PAGE_PATHS).find(([, value]) => value === path)?.[0] || null;
    canonicalPath = pageId ? SETTINGS_PAGE_PATHS[pageId] : SETTINGS_PAGE_PATHS.profile;
    pageId ||= 'profile';
  }

  const accessDenied = Boolean(pageId && ADMIN_SETTINGS_PAGE_IDS.has(pageId) && !isAdmin);
  return { pageId, canonicalPath, subscriptionId, subview, externalPath, accessDenied };
}

export function getSettingsTabIdFromPath(pathname, tabDefs, options = {}) {
  const resolved = resolveSettingsRoute(pathname, options);
  const available = new Set(tabDefs.map((tabDef) => tabDef.id));
  return available.has(resolved.pageId) ? resolved.pageId : null;
}

export function getSettingsPathForTab(tabId) {
  return SETTINGS_PAGE_PATHS[tabId] || SETTINGS_PAGE_PATHS.profile;
}
