import "./identity/index.js";
import { fetchIdentityProfile, fetchAdminUserProfile } from "./identity/profile.js";
import { createProjectFeature } from "./projects/index.js";
import { npubProjectsState, fetchNpubProjects, renderNpubProjectsPanel } from "./npub-projects/index.js";
import "./logging/browser.js";
import {
  sseManager,
  visibilityManager,
  initLiveModule,
  MessageStore,
  PromptQueueStore,
  UiPreferenceStore,
  isAlpineChatEnabled,
  initAlpineChat,
  attachWorkingNotesToggle,
} from "./live/index.js";
import { createLiveRefreshController } from "./live/refresh-controller.js";
import { syncLiveRouteTransport } from "./live/route-transport.js";
import {
  normalizeRuntimeStatus,
  normalizeSessionStatus,
  syncSessionStatusCaches,
} from "./live/session-status-cache.js";
import {
  initLiveMobileRuntime,
  isComposerInteractionActive,
  isMobileKeyboardOpen,
  focusComposerTextarea,
} from "./live/mobile-runtime.js";
import { createUnauthorizedGuard } from "./common/unauthorized-guard.js";
import { showDialogElement } from "./common/dialog-element.js";
import { openConfirmDialog, openTextPromptDialog } from "./common/dialog-prompts.js";
import { populateAgentSelect } from "./common/agent-options.js";
import { createSessionDialogController } from "./common/session-dialog.js";
import { createAutopilotCommandPalette } from "./core/command-palette.js";
import { createCommandPaletteFileActions } from "./core/command-palette-file-actions.js";
import { initAppDialogs } from "./apps/dialog.js";
import { initAppCards } from "./apps/cards.js";
import { initAppsRuntime, APP_STATUS_LABELS, APP_ACTION_LABELS } from "./apps/runtime.js";
import {
  initFeatureFlagsUI,
  ORCHESTRATOR_FLAG_KEY,
} from "./feature-flags/index.js";
import { initNightWatchSettingsPanel } from "./nightwatch/settings-panel.js";
import { initNightWatchPage } from "./nightwatch/page.js";
import { initNightWatchStore } from "./nightwatch/store.js";
import { initSchedulerStore } from "./scheduler/store.js";
import { initSchedulerPage } from "./scheduler/page.js";
import { initPipelinesPage } from "./pipelines/page.js";
import { initSessionsStore } from "./sessions/store.js";
import { initAppsStore } from "./apps/store.js";
import { syncAuthenticatedStartupStores } from "./startup/protected-store-sync.js";
import { restoreStartupIdentity } from "./startup/auth-startup.js";
import { createSessionRuntimeActions } from "./sessions/runtime-actions.js";
import { initSessionRuntimeSync } from "./sessions/runtime-sync.js";
import { startSigningListener, stopSigningListener } from "./nip98/signing-listener.js";
import { startSessionSubscriber, stopSessionSubscriber } from "./sessions/subscriber.js";
import { buildSessionOrigin, createSessionLauncher } from "./helpers/session-launch.js";
import { createSessionStartHandler } from "./helpers/session-post-start.js";
import {
  state,
  createAdminUsersState,
  initFilesPreferences,
  resolveWebAppBase,
  formatWebAppUrl,
  THEME_STORAGE_KEY,
  TABS_VISIBILITY_STORAGE_KEY,
  TASK_DISPATCH_TABS_VISIBILITY_STORAGE_KEY,
  LIVE_HEADER_COLLAPSED_STORAGE_KEY,
  RAW_TERMINAL_OUTPUT_VISIBLE_STORAGE_KEY,
  APP_LOG_PREVIEW_LINES,
  TOAST_DEFAULT_DURATION_MS,
  DEFAULT_CONNECT_RELAYS,
  ADMIN_PICTURE_CACHE_TTL_MS,
} from "./state/index.js";
// encoding utilities used by extracted modules (core/encoding.js)
import {
  createSvgShape,
  createIconSvg,
  FILE_BROWSER_ICON_DEFS,
  setIconButton,
  getSessionDisplayName,
  scrollConversationToBottom,
  getConversationScrollElement as _getConversationScrollElement,
  scrollConversationAreaToBottom as _scrollConversationAreaToBottom,
  isConversationScrolledToBottom as _isConversationScrolledToBottom,
  isMobileFilesLayout,
  escapeHtml,
  escapeAttribute,
  sanitizeLanguageClass,
} from "./core/icons.js";
import {
  renderInlineMarkdown,
  renderMarkdownToHtml,
  renderCodeToHtml,
  buildKeywordPattern,
} from "./rendering/markdown.js";
import { initFileEditor } from "./modals/file-editor.js";
import { initQueueModule } from "./sessions/queue-modal.js";
import { createAppRenderer } from "./core/app-renderer.js";
import { initImageAttachments } from "./core/image-attachments.js";
import { initVoiceNotes } from "./core/voice-notes.js";
import { initAgentIndicators } from "./status/agent-indicators.js";
import { show as scrollPillShow, hide as scrollPillHide, isNearBottom as scrollPillIsNearBottom } from "./live/scroll-pill.js";
import { initAdminUsersApi } from "./api/admin-users.js";
import { showToast } from "./utils/toast.js";
import { collapseNewlines } from "./utils/text.js";
import {
  copyTextToClipboard,
  attachCopyButton,
  attachMarkdownCodeBlockCopyHandler,
  copyConversationToClipboard,
} from "./utils/clipboard.js";
import {
  fetchSessionApi,
  bulkCloseStaleAutoSessionsApi,
  postSessionMessageApi,
  setPinnedArtifactApi,
  updateSessionMetadataApi,
} from "./services/sessions.js";
import {
  stopSession as stopSessionAction,
  deleteSession as deleteSessionAction,
  renameSession as renameSessionAction,
  resumeNativeSession as resumeNativeSessionAction,
} from "./sessions/actions.js";
import { fetchAppLogsApi, importAppDotenvApi } from "./services/apps.js";
import { isChatRoute } from "./chat/index.js";
import { initPrivateChat } from "./chat/private-chat.js";
import { initIdentityPanels } from "./identity/panels.js";
import { initHeaderAvatarMenu } from "./identity/header-avatar-menu.js";
import { initAdminUsersPanels } from "./api/admin-users-panels.js";
import { initPrivacyPolicy } from "./views/privacy-policy.js";
import { initSettingsView } from "./views/settings-view.js";
import { initStarterProjectsPanel } from "./views/starter-projects-panel.js";
import { initAppsView } from "./views/apps-view.js";
import { initHomeView } from "./views/home-view.js";
import { initFilesView } from "./views/files-view.js";
import { initFilesApi } from "./files/api.js";
import {
  FILES_ROUTE_PREFIX,
  getFilesRoutePrefixForPath,
  getFilesSurfaceFromPath,
  isDocsRoutePath,
  isFilesRoutePath,
} from "./files/route-url.js";
import { initLiveView } from "./views/live-view.js";
import { initTerminalView } from "./views/terminal-view.js";
import { initDirectoryBrowser } from "./modals/directory-browser.js";
import { abbreviateNpub, normaliseNpubValue, isFiniteNumber, initIdentityDom } from "./identity/dom.js";
import { initIdentityStateManager } from "./identity/state-manager.js";
import { createNavigation } from "./navigation/navigation.js";
import { createSessionRouting } from "./sessions/session-routing.js";
import { applyInstanceBranding, getInstanceName } from "./branding/instance-branding.js";
import {
  attachCompletionSoundUnlock,
  createCompletionSoundController,
  createWebAudioCompletionPing,
} from "./notifications/completion-sound.js";

// Ace editor is lazy-loaded when the file editor is first opened.
// See loadAceEditor() below and initFileEditor deps.
let aceInstance = null;

async function loadAceEditor() {
  if (aceInstance) return aceInstance;
  await import("/ace-builds/src-noconflict/ace.js");
  await Promise.all([
    import("/ace-builds/src-noconflict/mode-text.js"),
    import("/ace-builds/src-noconflict/theme-chrome.js"),
    import("/ace-builds/src-noconflict/theme-tomorrow_night.js"),
  ]);
  aceInstance = globalThis.ace;
  return aceInstance;
}

/** Lazy accessor for the Dexie-backed sessions Alpine store. */
const sessionsStore = () => window.Alpine?.store("sessions");
/** Lazy accessor for the Dexie-backed apps Alpine store. */
const appsStore = () => window.Alpine?.store("apps");
const completionSoundController = createCompletionSoundController({
  preferenceStore: UiPreferenceStore,
  playPing: createWebAudioCompletionPing(),
});
attachCompletionSoundUnlock(completionSoundController);
const sessionMessageSendInFlight = new Set();
let sessionDialogController = null;
let liveRefreshController = null;
let loadChats = async () => {};
let loadChatMessages = async () => {};
let navigateToChat = () => {};
let openPrivateChatDialog = () => {};
let deleteChat = async () => {};
let renderChat = () => document.createElement("div");
let renderIdentityPanel = () => document.createDocumentFragment();
let renderIdentitySummary = () => document.createDocumentFragment();
let renderMenuIdentitySection = () => {};
let renderAdminUsersPanel = () => document.createDocumentFragment();
let renderPrivacyPolicy = () => document.createElement("div");
let renderSettings = () => document.createElement("div");
let renderHome = () => document.createElement("div");
let renderApps = () => document.createElement("div");
let renderFiles = () => document.createElement("div");
let renderTerminal = () => document.createElement("div");
let disconnectTerminal = () => {};
let renderLive = () => document.createElement("div");
let renderSessionTabs = () => document.createElement("div");
let renderTabs = () => document.createElement("div");
let renderLiveTabsBarContent = () => document.createElement("div");
let updateLivePanelsForSession = () => {};
let reconcileLiveSessionUi = () => false;
let openArtifactPane = () => false;
let captureFocusSnapshot = () => null;
let restoreFocusFromSnapshot = () => {};
let openAppDialog = () => {};
let closeAppDialog = () => {};
let openAppLogsDialog = () => {};
let openDeployDialog = () => {};
let openCaproverDialog = () => {};
let refreshAppLogs = async () => {};
let resetAppDialog = () => {};
let renderAppCard = () => document.createElement("section");
let renderWingmanCard = () => document.createElement("section");
let commandPaletteController = null;
let fetchConfig = async () => {};
let fetchSessions = async () => {};
let buildSessionFilterOptions = () => [];
let fetchLogs = async () => {};
let fetchConversation = async () => {};
let renderConversationForSession = async () => {};
let setupConversationSelectionLock = () => {};
let fetchApps = async () => {};
let refreshApps = async () => {};
let getAppById = () => null;
let formatAppActionLabel = (action) => action ?? "Unknown";
let formatAppTimestamp = () => "—";
let isAppActionDisabled = () => true;
let triggerAppAction = async () => false;
let triggerRestart = async () => false;
let runSystemCleanup = async () => false;
let removeApp = async () => {};
let removeWapp = async () => false;
let deriveAppWindowName = () => "app";
let appendVariableUrlRow = () => {};
let appendVariablePubkeyRow = () => {};
let renderAppLogPreview = () => document.createElement("pre");
let renderFeatureFlagsPanel = () => document.createDocumentFragment();
let ensureFeatureFlagsLoaded = () => {};
let renderStarterProjectsPanel = () => document.createDocumentFragment();
let ensureStarterProjectsLoaded = () => {};
let resolveFeatureFlagForViewer = () => ({ state: "off", effectiveState: "off" });
let isFeatureEnabledForViewer = () => false;
let renderNightWatchSettingsPanel = () => document.createDocumentFragment();
let ensureNightWatchLoaded = () => {};
let renderNightWatchPage = () => document.createDocumentFragment();
let ensureNightWatchPageLoaded = () => {};
let renderSchedulerPage = () => document.createDocumentFragment();
let ensureSchedulerPageLoaded = () => {};
let renderPipelinesPage = () => document.createDocumentFragment();
let ensurePipelinesPageLoaded = () => {};
let projectsFeatureEnabledForViewer = () => true;
let syncFeatureFlagsFromConfig = () => {};
let scheduleDirectorySuggestions = () => {};
let openDirectoryBrowser = async () => null;
let openFileTransferDialogForMode = async () => {};
let updateIdentityState = (partial, options) => state.identity;
let registerIdentityDom = () => {};
let bindIdentityFlows = () => {};
let handleIdentityLogout = async () => {};
let handleIdentityCopy = async () => {};
let handleUnauthorizedAccess = () => {};
let forceIdentityLogoutState = () => {};
let getIdentityWiringContext = () => ({});
let identityDomEntryByNode = new WeakMap();
let IDENTITY_EVENT_NAMES = [];

let projectFeature = null;

let performAuthUiSync = () => {};
let pendingAuthUiSync = false;
const scheduleAuthMicrotask =
  typeof queueMicrotask === "function" ? queueMicrotask : (callback) => Promise.resolve().then(callback);
const requestAuthUiSync = () => {
  if (pendingAuthUiSync) return;
  pendingAuthUiSync = true;
  scheduleAuthMicrotask(() => {
    pendingAuthUiSync = false;
    performAuthUiSync();
  });
};

requestAuthUiSync();

// Initialize files preferences (showHidden, browserShelved, favourites) from localStorage
initFilesPreferences();

const normalisePortList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set();
  value.forEach((entry) => {
    const parsed = typeof entry === "number" ? entry : Number.parseInt(String(entry), 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      unique.add(parsed);
    }
  });
  return Array.from(unique).sort((a, b) => a - b);
};

const matchesAdminUserFilter = (user, filter) => {
  if (!filter) return true;
  const target = filter.toLowerCase();
  const alias = typeof user?.alias === "string" ? user.alias.toLowerCase() : "";
  const nickname = typeof user?.nickname === "string" ? user.nickname.toLowerCase() : "";
  const npub = typeof user?.npub === "string" ? user.npub.toLowerCase() : "";
  const normalized = typeof user?.normalizedNpub === "string" ? user.normalizedNpub.toLowerCase() : npub;
  return (
    alias.startsWith(target) ||
    nickname.startsWith(target) ||
    npub.startsWith(target) ||
    normalized.startsWith(target)
  );
};

let collapsibleIdCounter = 0;
const createCollapsibleCard = ({ title, className = "", collapsed = false, onToggle } = {}) => {
  const card = document.createElement("section");
  card.className = ["wm-card", "wm-collapsible", className].filter(Boolean).join(" ");

  const heading = document.createElement("h2");
  heading.className = "wm-collapsible__title";
  heading.textContent = title;
  heading.tabIndex = 0;
  heading.setAttribute("role", "button");

  const body = document.createElement("div");
  body.className = "wm-collapsible__body";
  const bodyId = `wm-collapsible-${++collapsibleIdCounter}`;
  body.id = bodyId;
  heading.setAttribute("aria-controls", bodyId);

  const applyState = (nextCollapsed) => {
    if (nextCollapsed) {
      card.dataset.collapsed = "true";
      body.hidden = true;
      heading.setAttribute("aria-expanded", "false");
      heading.dataset.state = "collapsed";
    } else {
      delete card.dataset.collapsed;
      body.hidden = false;
      heading.setAttribute("aria-expanded", "true");
      heading.dataset.state = "expanded";
    }
  };

  applyState(collapsed);

  const toggle = () => {
    const currentlyCollapsed = card.dataset.collapsed === "true";
    const nextCollapsed = !currentlyCollapsed;
    applyState(nextCollapsed);
    if (typeof onToggle === "function") {
      onToggle(nextCollapsed);
    }
  };

  heading.addEventListener("click", toggle);
  heading.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });

  card.append(heading, body);
  return { card, body, header: heading };
};
// -- Encoding utilities imported from core/encoding.js --
// -- SVG/icon utilities imported from core/icons.js --

// Thin wrappers closing over state.conversationContainers for scroll utilities
const getConversationScrollElement = (sessionId) =>
  _getConversationScrollElement(sessionId, state.conversationContainers);

const scrollConversationAreaToBottom = (sessionId, options = {}) =>
  _scrollConversationAreaToBottom(sessionId, state.conversationContainers, options);

const scheduleLiveScroll = (sessionId, options = {}) => {
  if (!sessionId || currentRoute !== "live") return;
  if (options.force) {
    scrollConversationAreaToBottom(sessionId, { includeWindow: options.includeWindow === true });
    scrollPillHide();
    return;
  }
  // Never auto-scroll — show the pill if user is scrolled up
  if (!scrollPillIsNearBottom()) {
    scrollPillShow();
    return;
  }
};

const isConversationScrolledToBottom = (sessionId) =>
  _isConversationScrolledToBottom(sessionId, state.conversationContainers);

// -- Files API helpers (populated in bootstrap via initFilesApi) --
let resetFilesPreview = () => {};
let updateFilesUrl = () => {};
let parseFilesPathFromUrl = () => ({ slug: null });
let navigateToFilesSlug = async () => {};
let loadFilesTree = async () => {};
let loadFilesPreview = async () => {};
let showFilesPreviewUnavailable = () => {};
let createFilesDirectory = async () => {};
let createFilesTextFile = async () => {};
let uploadFilesBinary = async () => {};
let deleteFilesEntry = async () => {};
let createDirectoryEntry = async () => {};
let copyFilesEntry = async () => {};
let moveFilesEntry = async () => {};

// -- Markdown / code rendering imported from rendering/markdown.js --

// -- File editor + worktree modal initialized via initFileEditor (see bootstrap) --
let canCreateWorktree = () => false;
let openWorktreeModal = () => {};
let closeWorktreeModal = () => {};
let openFileEditor = async () => {};
let closeFileEditor = () => {};
let getFileEditorDisplayTitle = () => "File Editor";
let resetFileEditorState = () => {};
let renderFileEditorOverlay = () => {};
let renderWorktreeModal = () => {};
let destroyAceEditor = () => {};
let ensureAceEditorMounted = () => {};
let requestFileEditorClose = () => {};
let getAceEditorInstance = () => null;

// -- Session helpers + prompt queue initialized via initQueueModule (see bootstrap) --
let getSessionById = () => undefined;
let isSessionActive = () => false;
let getActiveSessions = () => [];
let isSessionBusy = () => false;
let isStatusRecordBusy = () => false;
let getSessionQueue = () => ({ prompts: [], maxSize: 21 });
let getQueueCount = () => 0;
let isQueueFull = () => false;
let addToPromptQueue = async () => false;
let removeFromPromptQueue = async () => false;
let updatePromptInQueue = async () => false;
let fetchSessionQueue = async () => [];
let sendNextQueuedPrompt = async () => false;
let openPromptQueueModal = async () => {};
let closePromptQueueModal = () => {};

// -- Image attachments initialized via initImageAttachments (see bootstrap) --
let insertTextAtCursor = () => {};
let clearImagePreviews = () => {};
let extractImageFiles = () => [];
let extractAttachmentFiles = () => [];
let handleImageUploads = async () => {};
let handleAttachmentUploads = async () => {};
let cleanupOrphanedMarkers = () => {};
let prepareImagePreviewsForComposer = () => {};
let openVoiceNoteRecorder = async () => {};
let cleanupVoiceNoteDraftState = () => {};
let prepareVoiceNoteDraftForSend = async (_sessionId, draft) => draft;

// -- Agent indicators initialized via initAgentIndicators (see bootstrap) --
let resolveAgentRuntimeStatus = () => null;
let createAgentStatusIndicator = () => document.createElement("div");
let updateAgentStatusIndicators = () => {};
let updateKnightRiderState = () => {};
let updateConversationDOM = () => {};
let updateLogsDOM = () => {};

// -- Admin users API initialized via initAdminUsersApi (see bootstrap) --
let getAdminUserKey = () => null;
let ensureAdminSelectionState = () => new Set();
let setAdminUserSelected = () => {};
let clearAdminSelection = () => {};
let getAdminSelectedUsers = () => [];
let getAdminSelectionCount = () => 0;
let fetchAdminUsers = async () => {};
let replaceAdminUsersList = () => {};
let toggleUserOnboarding = async () => {};
let deleteAdminUser = async () => {};
let deleteSelectedAdminUsers = async () => {};
let updateAdminUserNickname = async () => {};
let primeAdminUserPictures = () => {};
let addAdminUser = async () => {};
let ensureAdminPortsToolState = () => {};
let submitAdminPortsAssignment = async () => {};
let generateAdminPorts = async () => {};

const LIVE_ROUTE_PREFIX = "/live";
const FILES_ROUTE = FILES_ROUTE_PREFIX;
const SETTINGS_ROUTE = "/settings";
const APPS_ROUTE = "/apps";
const PROJECTS_ROUTE = "/projects";
const NIGHTWATCH_ROUTE = "/nightwatch";
const SCHEDULER_ROUTE = "/scheduler";
const TRIGGERS_ROUTE = "/triggers";
const PIPELINES_ROUTE = "/pipelines";
const TERMINAL_ROUTE = "/terminal";
const HOME_ROUTE = "/home";
const PRIVACY_ROUTE = "/privacy";

const getRouteFromPath = (pathname) => {
  if (
    isFilesRoutePath(pathname) ||
    isDocsRoutePath(pathname)
  ) {
    return "files";
  }
  if (pathname === SETTINGS_ROUTE || pathname.startsWith(`${SETTINGS_ROUTE}/`)) {
    return "settings";
  }
  if (pathname === APPS_ROUTE) {
    return "apps";
  }
  if (pathname === PROJECTS_ROUTE) {
    return "projects";
  }
  if (pathname === NIGHTWATCH_ROUTE) {
    return "nightwatch";
  }
  if (pathname === SCHEDULER_ROUTE || pathname === TRIGGERS_ROUTE) {
    return "scheduler";
  }
  if (pathname === PIPELINES_ROUTE || pathname.startsWith(`${PIPELINES_ROUTE}/`)) {
    return "pipelines";
  }
  if (pathname === TERMINAL_ROUTE || pathname.startsWith(`${TERMINAL_ROUTE}/`)) {
    return "terminal";
  }
  if (pathname === LIVE_ROUTE_PREFIX || pathname.startsWith(`${LIVE_ROUTE_PREFIX}/`)) {
    return "live";
  }
  if (isChatRoute(pathname)) {
    return "chat";
  }
  if (pathname === PRIVACY_ROUTE) {
    return "privacy";
  }
  return "home";
};

const getSessionIdFromPath = (pathname) => {
  if (!pathname.startsWith(LIVE_ROUTE_PREFIX)) {
    return null;
  }
  if (pathname === LIVE_ROUTE_PREFIX) {
    return null;
  }
  const segments = pathname.slice(LIVE_ROUTE_PREFIX.length + 1).split("/").filter(Boolean);
  return segments[0] ?? null;
};

function resolveCurrentLiveSessionId() {
  const allSessions = sessionsStore().items;
  const routeSessionId =
    currentRoute === "live"
      ? getSessionIdFromPath(window.location.pathname)
      : null;

  if (routeSessionId && allSessions.some((session) => session.id === routeSessionId)) {
    return routeSessionId;
  }

  const activeId = sessionsStore().activeSessionId;
  if (activeId && allSessions.some((session) => session.id === activeId)) {
    return activeId;
  }

  const lastId = sessionsStore().lastActiveSessionId;
  if (lastId && allSessions.some((session) => session.id === lastId)) {
    return lastId;
  }

  return null;
}

let currentRoute = getRouteFromPath(window.location.pathname);
let authRouteResolved = false;
let currentTheme = "dark";
let tabsVisible = true;
let taskDispatchTabsVisible = true;
let liveHeaderCollapsed = false;
let rawTerminalOutputVisible = false;
let lastLoggedSessionId = null;
let lastFilesMobileLayout = isMobileFilesLayout();

const ACE_LIGHT_THEME = "ace/theme/tomorrow_night";
const ACE_DARK_THEME = "ace/theme/tomorrow_night";

const applyAceTheme = (instance) => {
  const editor = instance ?? getAceEditorInstance();
  if (!editor) return;
  const targetTheme = currentTheme === "dark" ? ACE_DARK_THEME : ACE_LIGHT_THEME;
  if (editor.getTheme() !== targetTheme) {
    editor.setTheme(targetTheme);
  }
};

// Session routing module — extracted from app.js.
// setActiveSession, ensureActiveSession, and applyRouteSessionFromPath live in sessions/session-routing.js.
// updateDocumentTitle is defined later in this file; it is
// referenced via closures inside the module so forward-declaration is fine (the functions are only
// called at runtime, never at module initialisation time).
const {
  setActiveSession,
  ensureActiveSession,
  applyRouteSessionFromPath,
} = createSessionRouting({
  sessionsStore,
  getCurrentRoute: () => currentRoute,
  getLastLoggedSessionId: () => lastLoggedSessionId,
  setLastLoggedSessionId: (id) => { lastLoggedSessionId = id; },
  LIVE_ROUTE_PREFIX,
  getSessionById: (...args) => getSessionById(...args),
  getActiveSessions: (...args) => getActiveSessions(...args),
  getSessionIdFromPath,
  updateDocumentTitle: (...args) => updateDocumentTitle(...args),
  activateLiveSessionRefresh: (...args) => liveRefreshController?.activateSession(...args),
  deactivateLiveSessionRefresh: (...args) => liveRefreshController?.deactivateSession(...args),
  getLiveRefreshSessionId: () => liveRefreshController?.getActiveSessionId?.() ?? null,
  isAlpineChatEnabled,
  scheduleLiveScroll: (...args) => scheduleLiveScroll(...args),
  onSessionVisited: (session) => commandPaletteController?.recordSessionVisit(session),
});

const dialog = document.getElementById("session-dialog");
const agentSelect = document.getElementById("agent-select");
const confirmButton = document.getElementById("confirm-session");
const cancelButton = document.getElementById("cancel-session");
const sessionForm = dialog?.querySelector("form");
const appRoot = document.getElementById("app");
const navLinks = Array.from(document.querySelectorAll("nav a[data-route]"));
const projectsNavLink = navLinks.find((link) => link.dataset.route === "projects");
const nightwatchNavLink = navLinks.find((link) => link.dataset.route === "nightwatch");
const terminalNavLink = navLinks.find((link) => link.dataset.route === "terminal");
const themeToggle = document.getElementById("theme-toggle");
const tabsToggle = document.getElementById("tabs-toggle");
const taskDispatchTabsToggle = document.getElementById("task-dispatch-tabs-toggle");
const rawTerminalOutputToggle = document.getElementById("raw-terminal-output-toggle");
const menuToggle = document.getElementById("menu-toggle");
const menuPanel = document.querySelector(".wm-menu-panel");
const menuTabsContainer = document.getElementById("menu-tabs");
const headerLoginButton = document.getElementById("header-login");
const brandCommandPaletteButton = document.getElementById("brand-command-palette");
performAuthUiSync = () => {
  const authed = Boolean(state.identity.authenticated);
  const isAdmin = Boolean(state.identity.isAdmin);
  if (typeof document !== "undefined" && document.body) {
    document.body.dataset.authenticated = authed ? "true" : "false";
    document.body.dataset.admin = isAdmin ? "true" : "false";
  }
  navLinks.forEach((link) => {
    if (authed) {
      link.removeAttribute("tabindex");
    } else {
      link.setAttribute("tabindex", "-1");
    }
  });
  if (!authed && typeof document !== "undefined" && document.body.dataset.menuOpen === "true") {
    delete document.body.dataset.menuOpen;
    menuToggle?.setAttribute("aria-expanded", "false");
    menuPanel?.setAttribute("aria-hidden", "true");
  }
  if (headerLoginButton) {
    headerLoginButton.disabled = authed;
  }
  syncProjectsNavigationVisibility();
  syncNightWatchNavigationVisibility();
  syncTerminalNavigationVisibility();
};

performAuthUiSync();
const pullRefreshIndicator = document.getElementById("pull-refresh");
const pullRefreshLabel = pullRefreshIndicator?.querySelector(".label");
const identityLoginDialog = document.getElementById("identity-login-dialog");
const identityLoginDialogContent = identityLoginDialog?.querySelector(".wm-identity-dialog__content");
const identityLoginDialogCloseButton = identityLoginDialog?.querySelector('[data-action="identity-dialog-close"]');
const sessionNameInput = document.getElementById("session-name");
const sessionAdvancedToggle = document.getElementById("session-advanced-toggle");
const sessionAdvancedPanel = document.getElementById("session-advanced-panel");
const sessionWorkspaceModeSelect = document.getElementById("session-workspace-mode");
const sessionWorktreeField = document.querySelector('[data-workspace="worktree"]');
const sessionWorktreeNameInput = document.getElementById("session-worktree-name");
const sessionWorktreeHint = document.getElementById("session-worktree-hint");
const sessionGoalInput = document.getElementById("session-goal");
const sessionAcpPermissionPolicySelect = document.getElementById("session-acp-permission-policy");
const sessionNextActionSelect = document.getElementById("session-next-action");
const sessionNextActionTemplateInput = document.getElementById("session-next-action-template");
const sessionWriterModeCheckbox = document.getElementById("session-writer-mode");
const sessionTargetFileInput = document.getElementById("session-target-file");
const sessionTargetFileField = document.getElementById("session-target-file-field");
const sessionModelSelect = document.getElementById("session-model");
const directoryInput = document.getElementById("working-directory");
const directorySuggestions = document.getElementById("directory-suggestions");
const browseDirectoryButton = document.getElementById("browse-directory");
const directoryDialog = document.getElementById("directory-dialog");
const directoryTitle = document.getElementById("directory-title");
const directoryList = document.getElementById("directory-list");
const directoryCurrent = document.getElementById("directory-current");
const directoryUpButton = document.getElementById("directory-up");
const directoryNewFolderButton = document.getElementById("directory-new-folder");
const directoryUseButton = document.getElementById("directory-use");
const fileTransferDialog = document.getElementById("file-transfer-dialog");
const fileTransferTitle = document.getElementById("file-transfer-title");
const fileTransferSource = document.getElementById("file-transfer-source");
const fileTransferCurrent = document.getElementById("file-transfer-current");
const fileTransferList = document.getElementById("file-transfer-list");
const fileTransferSelected = document.getElementById("file-transfer-selected");
const fileTransferNameInput = document.getElementById("file-transfer-name");
const fileTransferNameFeedback = document.getElementById("file-transfer-name-feedback");
const fileTransferUpButton = document.getElementById("file-transfer-up");
const fileTransferNewFolderButton = document.getElementById("file-transfer-new-folder");
const fileTransferCancelButton = document.getElementById("file-transfer-cancel");
const fileTransferConfirmButton = document.getElementById("file-transfer-confirm");

const appDialog = document.getElementById("app-dialog");
const appForm = appDialog?.querySelector("form") ?? null;
const appDialogTitle = document.getElementById("app-dialog-title");
const appLabelInput = document.getElementById("app-label");
const appRootInput = document.getElementById("app-root");
const appRootBrowseButton = document.getElementById("app-root-browse");
const appAdvancedSection = document.getElementById("app-advanced");
const appTmuxInput = document.getElementById("app-tmux-session");
const appTmuxWindowInput = document.getElementById("app-tmux-window");
const appNotesInput = document.getElementById("app-notes");
const appDiscoverToggle = document.getElementById("app-discover-enabled");
const appDiscoverButton = document.getElementById("app-discover");
const appWebAppToggle = document.getElementById("app-web-app");
const appWebAppPortNote = document.getElementById("app-web-app-port");
const appScriptInputs = {
  start: document.getElementById("app-script-start"),
  stop: document.getElementById("app-script-stop"),
  restart: document.getElementById("app-script-restart"),
  setup: document.getElementById("app-script-setup"),
  build: document.getElementById("app-script-build"),
};
const appCancelButton = document.getElementById("app-cancel");
const appSaveButton = document.getElementById("app-save");
const appLogsDialog = document.getElementById("app-logs-dialog");
const appLogsTitle = document.getElementById("app-logs-title");
const appLogsContent = document.getElementById("app-logs-content");
const appLogsRefreshButton = document.getElementById("app-logs-refresh");
const appLogsCloseButton = document.getElementById("app-logs-close");
const appCloneButton = document.getElementById("app-clone");
const appCloneDialog = document.getElementById("app-clone-dialog");
const appCloneForm = appCloneDialog?.querySelector("form") ?? null;
const appCloneUrlInput = document.getElementById("app-clone-url");
const appCloneNameInput = document.getElementById("app-clone-name");
const appCloneCancelButton = document.getElementById("app-clone-cancel");
const appCloneConfirmButton = document.getElementById("app-clone-confirm");
const projectDialog = document.getElementById("project-dialog");
const projectDialogForm = projectDialog?.querySelector("form") ?? null;
const projectDialogNameInput = document.getElementById("project-dialog-name");
const projectDialogRootInput = document.getElementById("project-dialog-root");
const projectDialogRootBrowseButton = document.getElementById("project-dialog-root-browse");
const projectDialogError = document.getElementById("project-dialog-error");
const projectDialogCancel = document.getElementById("project-dialog-cancel");
const projectDialogSubmit = document.getElementById("project-dialog-submit");
const SHARED_TMUX_SESSION = "wingman-apps";

let identityLoginPanelRoot = null;

const ensureIdentityLoginPanel = () => {
  if (!identityLoginDialogContent) return null;
  if (!identityLoginPanelRoot) {
    identityLoginPanelRoot = renderIdentityPanel({ variant: "dialog" });
    identityLoginDialogContent.append(identityLoginPanelRoot);
  }
  return identityLoginPanelRoot;
};

function openIdentityLoginDialog() {
  const panel = ensureIdentityLoginPanel();
  if (!identityLoginDialog || !panel) {
    navigateToSettings();
    return;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("wingman:identity-login-open"));
  }
  if (typeof identityLoginDialog.showModal === "function") {
    identityLoginDialog.showModal();
  } else {
    navigateToSettings();
  }
}

function closeIdentityLoginDialog() {
  if (identityLoginDialog?.open) {
    identityLoginDialog.close();
  }
}

identityLoginDialogCloseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  closeIdentityLoginDialog();
});

identityLoginDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeIdentityLoginDialog();
});

const syncProjectDialogState = () => {
  if (!projectDialog) return;
  const formState = projectFeature?.state?.createForm;
  const nameValue = formState?.name ?? "";
  const rootValue = formState?.rootPath ?? "";
  if (projectDialogNameInput && projectDialogNameInput.value !== nameValue) {
    projectDialogNameInput.value = nameValue;
  }
  if (projectDialogRootInput && projectDialogRootInput.value !== rootValue) {
    projectDialogRootInput.value = rootValue;
  }
  if (projectDialogError) {
    if (formState?.error) {
      projectDialogError.hidden = false;
      projectDialogError.textContent = formState.error;
    } else {
      projectDialogError.hidden = true;
      projectDialogError.textContent = "";
    }
  }
  const submitting = Boolean(formState?.submitting);
  if (projectDialogSubmit) {
    projectDialogSubmit.textContent = submitting ? "Creating…" : "Create Project";
    projectDialogSubmit.disabled = submitting;
  }
  if (projectDialogCancel) {
    projectDialogCancel.disabled = submitting;
  }
  if (projectDialogNameInput) {
    projectDialogNameInput.disabled = submitting;
  }
  if (projectDialogRootInput) {
    projectDialogRootInput.disabled = submitting;
  }
};

function openProjectDialog() {
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  if (!projectsFeatureEnabledForViewer()) {
    showToast?.("Projects are disabled right now", { variant: "info" });
    return;
  }
  syncProjectDialogState();
  if (typeof projectDialog?.showModal === "function") {
    projectDialog.showModal();
    requestAnimationFrame(() => {
      if (projectDialogNameInput) {
        projectDialogNameInput.focus();
        const length = projectDialogNameInput.value.length;
        projectDialogNameInput.setSelectionRange?.(length, length);
      }
    });
  }
}

function closeProjectDialog() {
  if (projectDialog?.open) {
    projectDialog.close();
  }
}

projectDialogCancel?.addEventListener("click", (event) => {
  event.preventDefault();
  closeProjectDialog();
});

projectDialog?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeProjectDialog();
});

projectDialogNameInput?.addEventListener("input", (event) => {
  projectFeature?.setCreateFormValue?.("name", event.target.value);
});

projectDialogRootInput?.addEventListener("input", (event) => {
  projectFeature?.setCreateFormValue?.("rootPath", event.target.value);
  scheduleDirectorySuggestions(event.target.value);
});

projectDialogRootInput?.addEventListener("focus", () => {
  scheduleDirectorySuggestions(projectDialogRootInput.value);
});

projectDialogForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!projectFeature) {
    return;
  }
  if (!projectsFeatureEnabledForViewer()) {
    showToast?.("Projects are disabled right now", { variant: "info" });
    closeProjectDialog();
    return;
  }
  const success = await projectFeature.submitCreateProject();
  syncProjectDialogState();
  if (success) {
    closeProjectDialog();
    showToast("Project created");
  }
});

projectDialogRootBrowseButton?.addEventListener("click", (event) => {
  event.preventDefault();
  const seed =
    projectDialogRootInput?.value?.trim() || state.lastWorkingDirectory || state.config?.defaultDirectory || "";
  void openDirectoryBrowser({
    initialPath: seed,
    title: "Select Project Root",
    confirmLabel: "Use This Directory",
    allowCreate: true,
    onSelect: (path) => {
      if (projectDialogRootInput) {
        projectDialogRootInput.value = path;
      }
      state.lastWorkingDirectory = path;
      projectFeature?.setCreateFormValue?.("rootPath", path);
      scheduleDirectorySuggestions(path);
    },
  });
});

const readProjectApiError = async (response) => {
  const payload = await response.json().catch(() => ({}));
  const message = typeof payload?.error === "string" ? payload.error : response.statusText;
  return message || "Request failed";
};

const linkAppToProject = async (context, app) => {
  if (!context?.projectId || !app?.id) {
    return;
  }
  if (!projectsFeatureEnabledForViewer()) {
    showToast?.("Projects are disabled right now", { variant: "info" });
    return;
  }
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(context.projectId)}/apps`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ appId: app.id }),
    });
    if (!response.ok) {
      throw new Error(await readProjectApiError(response));
    }
    await projectFeature?.refresh();
    showToast(context.projectName ? `Added to ${context.projectName}` : "App linked to project");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to link app to project";
    showToast(message, { type: "error" });
  }
};

const openProjectAppCreation = (project) => {
  if (!project?.id) {
    return;
  }
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  if (!projectsFeatureEnabledForViewer()) {
    showToast?.("Projects are disabled right now", { variant: "info" });
    return;
  }
  const context = {
    projectId: project.id,
    projectName: project.name ?? "",
    rootPath: project.rootPath ?? "",
    defaultLabel: project.name ? `${project.name}` : "",
  };
  openAppDialog(null, { projectContext: context });
};

const resolveProjectAppEntry = (entry) => {
  if (!entry) {
    return null;
  }
  if (entry.appId) {
    const found = getAppById(entry.appId);
    if (found) {
      return found;
    }
  }
  if (entry.folderPath) {
    return appsStore().items.find((app) => app.root === entry.folderPath) ?? null;
  }
  return null;
};

const openProjectAppDetails = (appOrId) => {
  const targetId = typeof appOrId === "string" ? appOrId : appOrId?.id;
  if (!targetId) {
    return;
  }
  navigateToApps({ skipMenuClose: true, focusAppId: targetId });
};

const triggerProjectAppAction = (appId, action) => triggerAppAction(appId, action);

const isProjectActionDisabled = (app, action) => isAppActionDisabled(app, action);

headerLoginButton?.addEventListener("click", (event) => {
  event.preventDefault();
  openIdentityLoginDialog();
});

const applyTheme = (theme, persist = true) => {
  currentTheme = theme;
  document.body.dataset.theme = theme;
  themeToggle?.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  applyAceTheme();
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {
      console.warn("Failed to persist theme preference", error);
    }
  }
};

const getActiveSessionForIndicator = () => {
  const sessionId = resolveCurrentLiveSessionId();
  if (!sessionId) return null;
  return sessionsStore().items.find((session) => session.id === sessionId) ?? null;
};

const getStoredThemePreference = () => {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
};

const detectPreferredTheme = () => {
  const stored = getStoredThemePreference();
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return "light";
};

const toggleTheme = () => {
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
};

const applyTabsVisibility = (visible, persist = true) => {
  tabsVisible = visible;
  document.body.dataset.tabsVisible = visible ? "true" : "false";
  tabsToggle?.setAttribute("aria-pressed", visible ? "false" : "true");
  if (persist) {
    try {
      localStorage.setItem(TABS_VISIBILITY_STORAGE_KEY, visible ? "true" : "false");
    } catch (error) {
      console.warn("Failed to persist tabs visibility preference", error);
    }
  }
};

const detectPreferredTabsVisibility = () => {
  try {
    const stored = localStorage.getItem(TABS_VISIBILITY_STORAGE_KEY);
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
  } catch {
    // ignore storage failures
  }
  return true; // default to visible
};

const toggleTabsVisibility = () => {
  const nextVisible = !tabsVisible;
  applyTabsVisibility(nextVisible);
};

const refreshLiveTabsBar = () => {
  if (currentRoute !== "live" || !tabsVisible) {
    return;
  }
  const tabsBar = document.querySelector(".wm-tabs-bar");
  const existingTabsPanel = tabsBar?.querySelector(".wm-live-tabs-panel");
  if (existingTabsPanel) {
    existingTabsPanel.replaceWith(renderLiveTabsBarContent());
  }
};

const applyTaskDispatchTabsVisibility = (visible, persist = true) => {
  taskDispatchTabsVisible = visible;
  document.body.dataset.taskDispatchTabsVisible = visible ? "true" : "false";
  if (taskDispatchTabsToggle) {
    taskDispatchTabsToggle.setAttribute("aria-pressed", visible ? "false" : "true");
    taskDispatchTabsToggle.title = visible ? "Hide task dispatch tabs" : "Show task dispatch tabs";
    taskDispatchTabsToggle.setAttribute(
      "aria-label",
      visible ? "Hide task dispatch tabs" : "Show task dispatch tabs",
    );
  }
  if (persist) {
    try {
      localStorage.setItem(TASK_DISPATCH_TABS_VISIBILITY_STORAGE_KEY, visible ? "true" : "false");
    } catch (error) {
      console.warn("Failed to persist task dispatch tabs preference", error);
    }
  }
  refreshLiveTabsBar();
};

const detectPreferredTaskDispatchTabsVisibility = () => {
  try {
    const stored = localStorage.getItem(TASK_DISPATCH_TABS_VISIBILITY_STORAGE_KEY);
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
  } catch {
    // ignore storage failures
  }
  return true;
};

const toggleTaskDispatchTabsVisibility = () => {
  const nextVisible = !taskDispatchTabsVisible;
  applyTaskDispatchTabsVisibility(nextVisible);
};

const applyLiveHeaderCollapsed = (collapsed, persist = true) => {
  liveHeaderCollapsed = collapsed;
  document.body.dataset.liveHeaderCollapsed = collapsed ? "true" : "false";
  if (persist) {
    try {
      localStorage.setItem(LIVE_HEADER_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
    } catch (error) {
      console.warn("Failed to persist live header fullscreen preference", error);
    }
  }
  refreshLiveTabsBar();
};

const detectPreferredLiveHeaderCollapsed = () => {
  try {
    const stored = localStorage.getItem(LIVE_HEADER_COLLAPSED_STORAGE_KEY);
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
  } catch {
    // ignore storage failures
  }
  return false;
};

const toggleLiveHeaderCollapsed = () => {
  applyLiveHeaderCollapsed(!liveHeaderCollapsed);
};

const applyRawTerminalOutputVisible = (visible, persist = true) => {
  rawTerminalOutputVisible = visible;
  document.body.dataset.rawTerminalOutputVisible = visible ? "true" : "false";
  if (rawTerminalOutputToggle) {
    rawTerminalOutputToggle.setAttribute("aria-pressed", visible ? "true" : "false");
    rawTerminalOutputToggle.title = visible ? "Hide raw terminal output" : "Show raw terminal output";
    rawTerminalOutputToggle.setAttribute(
      "aria-label",
      visible ? "Hide raw terminal output" : "Show raw terminal output",
    );
  }
  if (persist) {
    try {
      localStorage.setItem(RAW_TERMINAL_OUTPUT_VISIBLE_STORAGE_KEY, visible ? "true" : "false");
    } catch (error) {
      console.warn("Failed to persist raw terminal output preference", error);
    }
    refreshLiveTabsBar();
    if (currentRoute === "live") {
      render();
    }
  }
};

const detectPreferredRawTerminalOutputVisible = () => {
  try {
    const stored = localStorage.getItem(RAW_TERMINAL_OUTPUT_VISIBLE_STORAGE_KEY);
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
  } catch {
    // ignore storage failures
  }
  return false;
};

const toggleRawTerminalOutputVisible = () => {
  applyRawTerminalOutputVisible(!rawTerminalOutputVisible);
};

let menuOpenedAt = 0;

const closeMenu = (options = {}) => {
  const { force = false } = options;
  // Prevent immediate close after open (iOS touch event double-fire issue)
  if (!force && Date.now() - menuOpenedAt < 150) {
    return;
  }
  if (document.body.dataset.menuOpen === "true") {
    delete document.body.dataset.menuOpen;
    menuToggle?.setAttribute("aria-expanded", "false");
    menuPanel?.setAttribute("aria-hidden", "true");
    resetPullRefresh();
  }
};

const toggleMenu = () => {
  const isOpen = document.body.dataset.menuOpen === "true";
  if (isOpen) {
    closeMenu({ force: true });
  } else {
    menuOpenedAt = Date.now();
    document.body.dataset.menuOpen = "true";
    menuToggle?.setAttribute("aria-expanded", "true");
    menuPanel?.setAttribute("aria-hidden", "false");
    resetPullRefresh();
  }
};

const initTheme = () => {
  const preferred = detectPreferredTheme();
  applyTheme(preferred, false);
  if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
  }
};

const initTabsVisibility = () => {
  const preferred = detectPreferredTabsVisibility();
  applyTabsVisibility(preferred, false);
  if (tabsToggle) {
    tabsToggle.addEventListener("click", toggleTabsVisibility);
  }
};

const initTaskDispatchTabsVisibility = () => {
  const preferred = detectPreferredTaskDispatchTabsVisibility();
  applyTaskDispatchTabsVisibility(preferred, false);
  if (taskDispatchTabsToggle) {
    taskDispatchTabsToggle.addEventListener("click", toggleTaskDispatchTabsVisibility);
  }
};

const initLiveHeaderCollapsed = () => {
  applyLiveHeaderCollapsed(detectPreferredLiveHeaderCollapsed(), false);
};

const initRawTerminalOutputVisible = () => {
  applyRawTerminalOutputVisible(detectPreferredRawTerminalOutputVisible(), false);
  if (rawTerminalOutputToggle) {
    rawTerminalOutputToggle.addEventListener("click", toggleRawTerminalOutputVisible);
  }
};

const setActiveNav = () => {
  navLinks.forEach((link) => {
    const route = link.dataset.route;
    if (route === currentRoute) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });
};

const updateDocumentTitle = () => {
  const instanceName = getInstanceName(state.config);
  let title = instanceName;
  if (currentRoute === "live") {
    const currentSessionId = resolveCurrentLiveSessionId();
    const session = currentSessionId
      ? sessionsStore().items.find((s) => s.id === currentSessionId)
      : null;
    if (session) {
      const sessionName = getSessionDisplayName(session);
      title = `${sessionName} - ${instanceName}`;
    } else {
      title = `Agents - ${instanceName}`;
    }
  } else if (currentRoute === "apps") {
    title = `Apps - ${instanceName}`;
  } else if (currentRoute === "files") {
    title = getFilesSurfaceFromPath(window.location.pathname) === "docs"
      ? `Docs - ${instanceName}`
      : `Files - ${instanceName}`;
  } else if (currentRoute === "settings") {
    title = `Settings - ${instanceName}`;
  } else if (currentRoute === "projects") {
    title = `Projects - ${instanceName}`;
  } else if (currentRoute === "nightwatch") {
    title = `Night Watchman - ${instanceName}`;
  } else if (currentRoute === "scheduler") {
    title = `Triggers - ${instanceName}`;
  } else if (currentRoute === "pipelines") {
    title = `Pipelines - ${instanceName}`;
  } else if (currentRoute === "terminal") {
    title = `Terminal - ${instanceName}`;
  } else if (currentRoute === "home") {
    title = `Home - ${instanceName}`;
  }
  document.title = title;
};

function syncProjectsNavigationVisibility() {
  const enabled = projectsFeatureEnabledForViewer();
  if (projectsNavLink) {
    projectsNavLink.hidden = !enabled;
    projectsNavLink.setAttribute("aria-hidden", enabled ? "false" : "true");
    if (!enabled) {
      projectsNavLink.setAttribute("tabindex", "-1");
    } else if (state.identity.authenticated) {
      projectsNavLink.removeAttribute("tabindex");
    }
  }
  return enabled;
}

function syncNightWatchNavigationVisibility() {
  const enabled = isFeatureEnabledForViewer("nightwatch_enabled");
  if (nightwatchNavLink) {
    nightwatchNavLink.hidden = !enabled;
    nightwatchNavLink.setAttribute("aria-hidden", enabled ? "false" : "true");
    if (!enabled) {
      nightwatchNavLink.setAttribute("tabindex", "-1");
    } else if (state.identity.authenticated) {
      nightwatchNavLink.removeAttribute("tabindex");
    }
  }
  return enabled;
}

function syncTerminalNavigationVisibility() {
  const enabled = state.identity.isAdmin && state.config?.terminalConfigured === true;
  if (terminalNavLink) {
    terminalNavLink.hidden = !enabled;
    terminalNavLink.setAttribute("aria-hidden", enabled ? "false" : "true");
    if (enabled) terminalNavLink.removeAttribute("tabindex");
    else terminalNavLink.setAttribute("tabindex", "-1");
  }
  return enabled;
}

const syncMenuTabs = () => {
  if (!menuTabsContainer) return;
  menuTabsContainer.innerHTML = "";
  menuTabsContainer.dataset.state = "ready";

  if (!state.identity.authenticated) {
    menuTabsContainer.dataset.state = "guest";
    return;
  }

  const heading = document.createElement("p");
  heading.className = "wm-menu-heading";
  heading.textContent = "Agents";
  menuTabsContainer.append(heading);

  const sessionsContainer = document.createElement("div");
  sessionsContainer.className = "wm-menu-sessions-container";

  const activeSessions = getActiveSessions();
  if (activeSessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wm-menu-empty";
    empty.textContent = "No live sessions yet.";
    sessionsContainer.append(empty);
  } else {
    const sessionsList = document.createElement("div");
    sessionsList.className = "wm-menu-sessions-list";
    const sessionTabs = renderSessionTabs({ onSelect: closeMenu });
    sessionsList.append(sessionTabs);
    sessionsContainer.append(sessionsList);
  }

  if (state.identity.authenticated) {
    const addButton = document.createElement("div");
    addButton.className = "wm-tab new wm-menu-add-session";
    addButton.textContent = "+";
    addButton.title = "Start new session";
    addButton.addEventListener("click", () => {
      if (typeof commandPaletteController?.openSessionLaunch === "function") {
        commandPaletteController.openSessionLaunch();
      } else {
        openDialog();
      }
      closeMenu();
    });
    sessionsContainer.append(addButton);
  }

  menuTabsContainer.append(sessionsContainer);
};

const PULL_THRESHOLD = 90;
const PULL_MAX = 150;
const PULL_BASE_OFFSET = -120;
let pullStartY = null;
let pullActive = false;
let pullReady = false;
let pullRefreshing = false;

const setPullState = (state, distance = 0) => {
  if (!pullRefreshIndicator) return;
  const clamped = Math.max(0, Math.min(distance, PULL_MAX));
  const translate = state === "hidden"
    ? PULL_BASE_OFFSET
    : Math.min(90, -80 + clamped * 1.1);
  pullRefreshIndicator.dataset.state = state;
  pullRefreshIndicator.style.transform = `translate(-50%, ${translate}px)`;
  if (pullRefreshLabel) {
    if (state === "release") {
      pullRefreshLabel.textContent = "Release to refresh";
    } else if (state === "refresh") {
      pullRefreshLabel.textContent = "Refreshing…";
    } else {
      pullRefreshLabel.textContent = "Pull to refresh";
    }
  }
};

const resetPullRefresh = () => {
  pullStartY = null;
  pullActive = false;
  pullReady = false;
  if (pullRefreshing) return;
  setPullState("hidden", 0);
};

const triggerPullRefresh = () => {
  if (!pullRefreshIndicator || pullRefreshing) return;
  pullRefreshing = true;
  setPullState("refresh", PULL_THRESHOLD);

  const MIN_REFRESH_DURATION = 400;
  pullReady = false;
  pullActive = false;

  setTimeout(() => {
    window.location.reload();
  }, MIN_REFRESH_DURATION);
};


// Apps polling has been replaced by Dexie-backed Alpine store with liveQuery.
// These stubs remain for callers that haven't been updated yet.
const syncAppsPolling = () => {};

const pollSessions = async () => {
  try {
    const allSessions = sessionsStore().items;
    const previousSessionCount = allSessions.length;
    const previousSessionIds = allSessions.map(s => s.id).join(',');

    await fetchSessions();
    syncMenuTabs();

    const updatedSessions = sessionsStore().items;
    const currentSessionCount = updatedSessions.length;
    const currentSessionIds = updatedSessions.map(s => s.id).join(',');
    const sessionsChanged = previousSessionCount !== currentSessionCount || previousSessionIds !== currentSessionIds;

    if (currentRoute === "home") {
      // Only render on home route if sessions actually changed
      if (sessionsChanged) {
        render();
      }
      // Don't update status indicators on home route - they're not visible there
      return;
    }

    if (currentRoute !== "live") {
      return;
    }

    const activeId = sessionsStore().activeSessionId;
    if (!activeId) {
      // On live route with no active session, render to show empty state
      render();
    } else {
      // On live route with active session:
      // - Update menu tabs to reflect current sessions
      syncMenuTabs();
      // - Only replace tabs bar if sessions changed (to preserve event listeners)
      if (sessionsChanged && tabsVisible) {
        refreshLiveTabsBar();
      }
      // - Incremental updates for conversation/logs are handled by fetchConversation and fetchLogs
    }

    updateAgentStatusIndicators();
    
  } catch (error) {
    console.error("Failed to refresh sessions", error);
  }
};

// Session polling has been replaced by Dexie-backed Alpine store with liveQuery.
// These stubs remain for callers that haven't been updated yet.
const startSessionPolling = () => {};
const stopSessionPolling = () => {};
const syncSessionPolling = () => {};

const getSessionFallbackDirectory = () => {
  return (
    directoryInput?.value?.trim() ||
    state.lastWorkingDirectory ||
    state.config?.defaultDirectory ||
    ""
  );
};

const openDialog = () => {
  if (sessionDialogController) {
    sessionDialogController.open();
    return;
  }
  if (!state.identity.authenticated) {
    openIdentityLoginDialog();
    return;
  }
  if (!state.config) return;
  const fallbackDirectory = getSessionFallbackDirectory();
  if (sessionNameInput) {
    sessionNameInput.value = "";
  }
  if (directoryInput) {
    directoryInput.value = fallbackDirectory;
    scheduleDirectorySuggestions(fallbackDirectory);
  }
  showDialogElement(dialog);
  if (sessionNameInput) {
    sessionNameInput.focus();
    sessionNameInput.select();
  } else {
    directoryInput?.focus();
    directoryInput?.select();
  }
};

const closeDialog = () => {
  if (sessionDialogController) {
    sessionDialogController.close();
    return;
  }
  if (dialog.open) {
    dialog.close();
  }
  if (sessionNameInput) {
    sessionNameInput.value = "";
  }
};

const handleSessionStart = createSessionStartHandler({
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (route) => {
    currentRoute = route;
  },
  setActiveSession: (...args) => setActiveSession(...args),
  updateWorkingDirectory: (session) => {
    if (typeof session?.workingDirectory !== "string" || session.workingDirectory.length === 0) {
      return;
    }
    state.lastWorkingDirectory = session.workingDirectory;
    if (directoryInput) {
      directoryInput.value = session.workingDirectory;
      scheduleDirectorySuggestions(session.workingDirectory);
    }
    sessionDialogController?.syncWorktreeHint?.();
  },
  fetchSessions: (...args) => fetchSessions(...args),
  fetchConversation: (...args) => fetchConversation(...args),
  fetchLogs: (...args) => fetchLogs(...args),
  render: () => render(),
});

const launchSession = createSessionLauncher({
  handleSessionStart,
  liveRoutePrefix: LIVE_ROUTE_PREFIX,
  notify: (message, options) => showToast(message, options),
});

sessionDialogController = createSessionDialogController({
  dialog,
  agentSelect,
  sessionNameInput,
  directoryInput,
  advancedToggle: sessionAdvancedToggle,
  advancedPanel: sessionAdvancedPanel,
  workspaceSelect: sessionWorkspaceModeSelect,
  worktreeField: sessionWorktreeField,
  worktreeNameInput: sessionWorktreeNameInput,
  worktreeHint: sessionWorktreeHint,
  goalInput: sessionGoalInput,
  acpPermissionPolicySelect: sessionAcpPermissionPolicySelect,
  nextActionSelect: sessionNextActionSelect,
  nextActionTemplateInput: sessionNextActionTemplateInput,
  writerModeCheckbox: sessionWriterModeCheckbox,
  targetFileInput: sessionTargetFileInput,
  targetFileField: sessionTargetFileField,
  modelSelect: sessionModelSelect,
  isAuthenticated: () => Boolean(state.identity.authenticated),
  getConfig: () => state.config,
  getFallbackDirectory: getSessionFallbackDirectory,
  onRequireAuth: openIdentityLoginDialog,
  onDirectoryPrefill: (...args) => scheduleDirectorySuggestions(...args),
  onSubmit: ({ agentId, workingDirectory, sessionName, workspace, targetFile, metadata, model }) => {
    const options = {};
    if (targetFile) {
      options.targetFile = targetFile;
    }
    if (model) {
      options.model = model;
    }
    if (metadata && typeof metadata === "object") {
      options.metadata = metadata;
    }
    launchSession(agentId, workingDirectory, sessionName, workspace, options);
  },
});
sessionDialogController.resetFormState();

const sessionRuntimeSync = initSessionRuntimeSync({
  state,
  sessionsStore,
  agentSelect,
  directoryInput,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (route) => {
    currentRoute = route;
  },
  homeRoute: HOME_ROUTE,
  getSessionIdFromPath,
  normaliseNpubValue,
  abbreviateNpub,
  syncFeatureFlagsFromConfig,
  updateIdentityState,
  scheduleDirectorySuggestions,
  MessageStore,
  isAlpineChatEnabled,
  scrollPillIsNearBottom,
  scrollPillShow,
  updateLogsDOM: (...args) => updateLogsDOM(...args),
  updateConversationDOM: (...args) => updateConversationDOM(...args),
  fetchSessionQueue: (...args) => fetchSessionQueue(...args),
  applyRouteSessionFromPath: (...args) => applyRouteSessionFromPath(...args),
  ensureActiveSession: (...args) => ensureActiveSession(...args),
  applyBranding: (branding) => {
    applyInstanceBranding(branding);
    updateDocumentTitle();
  },
});
fetchConfig = (...args) => sessionRuntimeSync.fetchConfig(...args);
fetchSessions = (...args) => sessionRuntimeSync.fetchSessions(...args);
buildSessionFilterOptions = (...args) => sessionRuntimeSync.buildSessionFilterOptions(...args);
fetchLogs = (...args) => sessionRuntimeSync.fetchLogs(...args);
renderConversationForSession = (...args) => sessionRuntimeSync.renderConversationForSession(...args);
setupConversationSelectionLock = (...args) => sessionRuntimeSync.setupConversationSelectionLock(...args);
fetchConversation = (...args) => sessionRuntimeSync.fetchConversation(...args);

const sessionRuntimeActions = createSessionRuntimeActions({
  state,
  sessionsStore,
  getSessionById: (...args) => getSessionById(...args),
  getSessionDisplayName,
  fetchSessions: (...args) => fetchSessions(...args),
  fetchSessionApi: (...args) => fetchSessionApi(...args),
  fetchConversation: (...args) => fetchConversation(...args),
  fetchLogs: (...args) => fetchLogs(...args),
  render: () => render(),
  refreshLiveTabsBar: () => refreshLiveTabsBar(),
  syncMenuTabs: () => syncMenuTabs(),
  setCurrentRoute: (route) => {
    currentRoute = route;
  },
  setActiveSession: (...args) => setActiveSession(...args),
  stopSessionAction,
  deleteSessionAction,
  renameSessionAction,
  updateSessionMetadataAction: updateSessionMetadataApi,
  resumeNativeSessionAction,
  openTextPromptDialog,
  showToast,
  postSessionMessageApi,
  updateIdentityState,
  isSessionBusy: (...args) => isSessionBusy(...args),
  addToPromptQueue: (...args) => addToPromptQueue(...args),
  updateAgentStatusIndicators,
  renderConversationForSession: (...args) => renderConversationForSession(...args),
  scrollPillHide,
  scrollConversationAreaToBottom,
  sessionMessageSendInFlight,
  focusComposerTextarea,
  isAlpineChatEnabled,
  MessageStore,
  PromptQueueStore,
  prepareVoiceNoteDraftForSend: (...args) => prepareVoiceNoteDraftForSend(...args),
});

const stopSession = (...args) => sessionRuntimeActions.stopSession(...args);
const deleteSession = (...args) => sessionRuntimeActions.deleteSession(...args);
const updateSessionName = (...args) => sessionRuntimeActions.updateSessionName(...args);
const promptRenameSession = (...args) => sessionRuntimeActions.promptRenameSession(...args);
const resumeSession = (...args) => sessionRuntimeActions.resumeSession(...args);
const resumeNativeSession = (...args) => sessionRuntimeActions.resumeNativeSession(...args);
const postSessionMessage = (...args) => sessionRuntimeActions.postSessionMessage(...args);
const sendMessage = (...args) => sessionRuntimeActions.sendMessage(...args);
const sendControlCommand = (...args) => sessionRuntimeActions.sendControlCommand(...args);

const appsRuntime = initAppsRuntime({
  state,
  appsStore,
  getCurrentRoute: () => currentRoute,
  render: () => render(),
  showToast,
  fetchSessions,
  logPreviewLines: APP_LOG_PREVIEW_LINES,
  onAppActionSuccess: ({ app, action }) => {
    if (action === "restart") {
      commandPaletteController?.recordAppRestart(app);
    }
  },
});
fetchApps = (...args) => appsRuntime.fetchApps(...args);
refreshApps = (...args) => appsRuntime.refreshApps(...args);
getAppById = (...args) => appsRuntime.getAppById(...args);
formatAppActionLabel = (...args) => appsRuntime.formatAppActionLabel(...args);
formatAppTimestamp = (...args) => appsRuntime.formatAppTimestamp(...args);
isAppActionDisabled = (...args) => appsRuntime.isAppActionDisabled(...args);
triggerAppAction = (...args) => appsRuntime.triggerAppAction(...args);
triggerRestart = (...args) => appsRuntime.triggerRestart(...args);
runSystemCleanup = (...args) => appsRuntime.runSystemCleanup(...args);
removeApp = (...args) => appsRuntime.removeApp(...args);
removeWapp = (...args) => appsRuntime.removeWapp(...args);
deriveAppWindowName = (...args) => appsRuntime.deriveAppWindowName(...args);
appendVariableUrlRow = (...args) => appsRuntime.appendVariableUrlRow(...args);
appendVariablePubkeyRow = (...args) => appsRuntime.appendVariablePubkeyRow(...args);
renderAppLogPreview = (...args) => appsRuntime.renderAppLogPreview(...args);

const renderProjects = () => {
  if (!projectsFeatureEnabledForViewer()) {
    const container = document.createElement("div");
    container.className = "wm-projects-page";
    return container;
  }
  if (!state.identity.authenticated) {
    const guestContainer = document.createElement("div");
    guestContainer.className = "wm-projects-page";
    const guestCard = document.createElement("section");
    guestCard.className = "wm-card wm-project-card";
    const guestMessage = document.createElement("p");
    guestMessage.textContent = "Sign in to manage projects.";
    guestCard.append(guestMessage);
    guestContainer.append(guestCard);
    return guestContainer;
  }
  // void ensureAppsLoaded(); // DISABLED
  if (projectFeature) {
    void projectFeature.ensureLoaded();
    return projectFeature.renderPage();
  }
  const container = document.createElement("div");
  container.className = "wm-projects-page";
  return container;
};

const appRenderer = createAppRenderer({
  appRoot,
  sessionsStore,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (route) => {
    currentRoute = route;
  },
  sseManager,
  getLiveRefreshController: () => liveRefreshController,
  syncLiveRouteTransport,
  syncProjectsNavigationVisibility,
  syncNightWatchNavigationVisibility,
  syncTerminalNavigationVisibility,
  homeRoute: HOME_ROUTE,
  projectsRoute: PROJECTS_ROUTE,
  nightwatchRoute: NIGHTWATCH_ROUTE,
  terminalRoute: TERMINAL_ROUTE,
  captureFocusSnapshot: (...args) => captureFocusSnapshot(...args),
  restoreFocusFromSnapshot: (...args) => restoreFocusFromSnapshot(...args),
  renderRouteView: (route) => {
    if (route === "live") {
      disconnectTerminal();
      return renderLive();
    }
    if (route === "apps") {
      disconnectTerminal();
      return renderApps();
    }
    if (route === "projects") {
      disconnectTerminal();
      return renderProjects();
    }
    if (route === "nightwatch") {
      disconnectTerminal();
      return renderNightWatchPage();
    }
    if (route === "scheduler") {
      disconnectTerminal();
      return renderSchedulerPage();
    }
    if (route === "pipelines") {
      disconnectTerminal();
      return renderPipelinesPage();
    }
    if (route === "terminal") {
      return renderTerminal();
    }
    if (route === "files") {
      disconnectTerminal();
      return renderFiles();
    }
    if (route === "settings") {
      disconnectTerminal();
      return renderSettings();
    }
    if (route === "chat") {
      disconnectTerminal();
      return renderChat();
    }
    if (route === "privacy") {
      disconnectTerminal();
      return renderPrivacyPolicy();
    }
    disconnectTerminal();
    return renderHome();
  },
  renderFileEditorOverlay: (...args) => renderFileEditorOverlay(...args),
  renderWorktreeModal: (...args) => renderWorktreeModal(...args),
  focusComposerTextarea,
  setActiveNav,
  syncMenuTabs,
  updateAgentStatusIndicators: (...args) => updateAgentStatusIndicators(...args),
  reconcileLiveSessionUi: (...args) => reconcileLiveSessionUi(...args),
  updateDocumentTitle,
  isAuthenticated: () => Boolean(state.identity.authenticated),
  isAuthResolved: () => authRouteResolved,
});
const render = (...args) => appRenderer.render(...args);
const handleSessionsStoreItemsChanged = (...args) => appRenderer.handleSessionsStoreItemsChanged(...args);

projectFeature = createProjectFeature({
  onRenderRequested: () => {
    if (currentRoute === "projects") {
      render();
    }
    syncProjectDialogState();
  },
  onCreateRequested: () => {
    openProjectDialog();
  },
  onProjectAppRequested: (project) => {
    openProjectAppCreation(project);
  },
  resolveApp: (entry) => resolveProjectAppEntry(entry),
  openAppDetails: (app) => {
    if (!app) return;
    openProjectAppDetails(app.id ?? app);
  },
  triggerAppAction: (appId, action) => triggerProjectAppAction(appId, action),
  isActionDisabled: (app, action) => isProjectActionDisabled(app, action),
});
state.projects = projectFeature.state;

const queueModule = initQueueModule({
  state,
  sessionsStore,
  showToast,
  updateAgentStatusIndicators: (...args) => updateAgentStatusIndicators(...args),
  updateConversationDOM: (...args) => updateConversationDOM(...args),
  scrollConversationAreaToBottom,
});
getSessionById = queueModule.getSessionById;
isSessionActive = queueModule.isSessionActive;
getActiveSessions = queueModule.getActiveSessions;
isSessionBusy = queueModule.isSessionBusy;
isStatusRecordBusy = queueModule.isStatusRecordBusy;
getSessionQueue = queueModule.getSessionQueue;
getQueueCount = queueModule.getQueueCount;
isQueueFull = queueModule.isQueueFull;
addToPromptQueue = queueModule.addToPromptQueue;
removeFromPromptQueue = queueModule.removeFromPromptQueue;
updatePromptInQueue = queueModule.updatePromptInQueue;
fetchSessionQueue = queueModule.fetchSessionQueue;
sendNextQueuedPrompt = queueModule.sendNextQueuedPrompt;
openPromptQueueModal = queueModule.openPromptQueueModal;
closePromptQueueModal = queueModule.closePromptQueueModal;

liveRefreshController = createLiveRefreshController({
  sseManager,
  getCurrentRoute: () => currentRoute,
  getActiveSessionId: () => sessionsStore().activeSessionId,
  getSessionRuntimeStatus: (sessionId) => {
    const session = sessionsStore().items.find((item) => item.id === sessionId);
    if (!session) {
      return null;
    }
    return session.agentRuntimeStatus ?? session.status ?? null;
  },
  fetchConversation: (...args) => fetchConversation(...args),
  fetchLogs: (...args) => fetchLogs(...args),
  fetchSessionQueue: (...args) => fetchSessionQueue(...args),
  fetchSessionDetails: (...args) => fetchSessionApi(...args),
  applySessionDetails: (sessionId, sessionData) => {
    const nextSessionStatus = normalizeSessionStatus(sessionData?.status ?? null);
    const nextRuntimeStatus = normalizeRuntimeStatus(sessionData?.agentRuntimeStatus ?? null);
    const session = sessionsStore().items.find((item) => item.id === sessionId);
    if (session) {
      if (nextSessionStatus !== null) {
        session.status = nextSessionStatus;
      }
      session.agentRuntimeStatus = nextRuntimeStatus;
    }
    void syncSessionStatusCaches(sessionId, {
      status: nextSessionStatus,
      agentRuntimeStatus: nextRuntimeStatus,
    });
    updateAgentStatusIndicators();
  },
  isComposerInteractionActive,
  isMobileKeyboardOpen,
});

const imageAttachmentsModule = initImageAttachments({ state, getSessionById, showToast });
insertTextAtCursor = imageAttachmentsModule.insertTextAtCursor;
clearImagePreviews = imageAttachmentsModule.clearImagePreviews;
extractImageFiles = imageAttachmentsModule.extractImageFiles;
extractAttachmentFiles = imageAttachmentsModule.extractAttachmentFiles;
handleImageUploads = imageAttachmentsModule.handleImageUploads;
handleAttachmentUploads = imageAttachmentsModule.handleAttachmentUploads;
cleanupOrphanedMarkers = imageAttachmentsModule.cleanupOrphanedMarkers;
prepareImagePreviewsForComposer = imageAttachmentsModule.prepareImagePreviewsForComposer;
imageAttachmentsModule.bindInlineImagePreviewLinks();

const voiceNotesModule = initVoiceNotes({
  state,
  getSessionById,
  insertTextAtCursor,
  showToast,
});
openVoiceNoteRecorder = voiceNotesModule.openVoiceNoteRecorder;
cleanupVoiceNoteDraftState = voiceNotesModule.cleanupOrphanedVoiceNotes;
prepareVoiceNoteDraftForSend = voiceNotesModule.prepareDraftForSend;

const imageMarkerCleanup = cleanupOrphanedMarkers;
cleanupOrphanedMarkers = (sessionId, text) => {
  imageMarkerCleanup(sessionId, text);
  cleanupVoiceNoteDraftState(sessionId, text);
};

const agentIndicatorsModule = initAgentIndicators({
  state,
  sessionsStore,
  getCurrentRoute: () => currentRoute,
  getQueueCount,
  isSessionBusy,
  openPromptQueueModal,
});
resolveAgentRuntimeStatus = agentIndicatorsModule.resolveAgentRuntimeStatus;
createAgentStatusIndicator = agentIndicatorsModule.createAgentStatusIndicator;
updateAgentStatusIndicators = agentIndicatorsModule.updateAgentStatusIndicators;
updateKnightRiderState = agentIndicatorsModule.updateKnightRiderState;
updateConversationDOM = agentIndicatorsModule.updateConversationDOM;
updateLogsDOM = agentIndicatorsModule.updateLogsDOM;

const adminUsersModule = initAdminUsersApi({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  normaliseNpubValue,
  isFiniteNumber,
  ADMIN_PICTURE_CACHE_TTL_MS,
});
getAdminUserKey = adminUsersModule.getAdminUserKey;
ensureAdminSelectionState = adminUsersModule.ensureAdminSelectionState;
setAdminUserSelected = adminUsersModule.setAdminUserSelected;
clearAdminSelection = adminUsersModule.clearAdminSelection;
getAdminSelectedUsers = adminUsersModule.getAdminSelectedUsers;
getAdminSelectionCount = adminUsersModule.getAdminSelectionCount;
fetchAdminUsers = adminUsersModule.fetchAdminUsers;
replaceAdminUsersList = adminUsersModule.replaceAdminUsersList;
toggleUserOnboarding = adminUsersModule.toggleUserOnboarding;
deleteAdminUser = adminUsersModule.deleteAdminUser;
deleteSelectedAdminUsers = adminUsersModule.deleteSelectedAdminUsers;
updateAdminUserNickname = adminUsersModule.updateAdminUserNickname;
primeAdminUserPictures = adminUsersModule.primeAdminUserPictures;
addAdminUser = adminUsersModule.addAdminUser;
ensureAdminPortsToolState = adminUsersModule.ensureAdminPortsToolState;
submitAdminPortsAssignment = adminUsersModule.submitAdminPortsAssignment;
generateAdminPorts = adminUsersModule.generateAdminPorts;

const adminUsersPanelsModule = initAdminUsersPanels({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  createCollapsibleCard,
  abbreviateNpub,
  normaliseNpubValue,
  matchesAdminUserFilter,
  ensureAdminPortsToolState,
  submitAdminPortsAssignment,
  ensureAdminSelectionState,
  getAdminUserKey,
  setAdminUserSelected,
  clearAdminSelection,
  fetchAdminUsers,
  toggleUserOnboarding,
  deleteAdminUser,
  deleteSelectedAdminUsers,
  updateAdminUserNickname,
  addAdminUser,
});
renderAdminUsersPanel = adminUsersPanelsModule.renderAdminUsersPanel;

const privacyPolicyModule = initPrivacyPolicy({
  HOME_ROUTE,
  setCurrentRoute: (r) => { currentRoute = r; },
  render,
});
renderPrivacyPolicy = privacyPolicyModule.renderPrivacyPolicy;

const appCardsModule = initAppCards({
  appsStore,
  APP_STATUS_LABELS,
  renderLogPreview: (...args) => renderAppLogPreview(...args),
  launchSession: (...args) => launchSession(...args),
  fetchAppLogsApi,
  importAppDotenvApi,
  removeApp: (...args) => removeApp(...args),
  removeWapp: (...args) => removeWapp(...args),
  state,
  formatAppTimestamp,
  formatAppActionLabel,
  formatWebAppUrl,
  deriveAppWindowName,
  appendVariableUrlRow,
  appendVariablePubkeyRow,
  isAppActionDisabled,
  triggerAppAction: (...args) => triggerAppAction(...args),
  triggerRestart: (...args) => triggerRestart(...args),
  runSystemCleanup: (...args) => runSystemCleanup(...args),
  openIdentityLoginDialog,
  showToast,
  buildSessionOrigin,
  openAppLogsDialog: (...args) => openAppLogsDialog(...args),
  openDeployDialog: (...args) => openDeployDialog(...args),
  openCaproverDialog: (...args) => openCaproverDialog(...args),
  openAppDialog: (...args) => openAppDialog(...args),
  refreshApps: (...args) => refreshApps(...args),
});
renderAppCard = appCardsModule.renderAppCard;
renderWingmanCard = appCardsModule.renderWingmanCard;

const starterProjectsPanelModule = initStarterProjectsPanel({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  showToast,
});
ensureStarterProjectsLoaded = starterProjectsPanelModule.ensureStarterProjectsLoaded;
renderStarterProjectsPanel = starterProjectsPanelModule.renderStarterProjectsPanel;

const settingsViewModule = initSettingsView({
  state,
  appsStore,
  getCurrentRoute: () => currentRoute,
  render,
  normalisePortList,
  generateAdminPorts: (...args) => generateAdminPorts(...args),
  renderIdentityPanel: (...args) => renderIdentityPanel(...args),
  renderFeatureFlagsPanel: (...args) => renderFeatureFlagsPanel(...args),
  ensureFeatureFlagsLoaded: (...args) => ensureFeatureFlagsLoaded(...args),
  renderAdminUsersPanel: (...args) => renderAdminUsersPanel(...args),
  fetchAdminUsers: (...args) => fetchAdminUsers(...args),
  renderWingmanCard: (...args) => renderWingmanCard(...args),
  ensureStarterProjectsLoaded: (...args) => ensureStarterProjectsLoaded(...args),
  renderStarterProjectsPanel: (...args) => renderStarterProjectsPanel(...args),
  npubProjectsState,
  fetchNpubProjects,
  renderNpubProjectsPanel,
  openDirectoryBrowser: (...args) => openDirectoryBrowser(...args),
  refreshBranding: async (branding) => {
    state.config = { ...state.config, branding };
    applyInstanceBranding(branding);
    updateDocumentTitle();
    render();
  },
  refreshConfig: async () => {
    await fetchConfig();
    sessionDialogController?.syncModelOptions?.();
  },
  triggerRestart: (...args) => triggerRestart(...args),
  completionSoundController,
  showToast,
});
renderSettings = settingsViewModule.renderSettings;

const homeViewModule = initHomeView({
  state,
  sessionsStore,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (r) => { currentRoute = r; },
  render,
  openIdentityLoginDialog,
  renderApps: (...args) => renderApps(...args),
  navigateToChat: (...args) => navigateToChat(...args),
  openDialog,
  ensureFeatureFlagsLoaded: (...args) => ensureFeatureFlagsLoaded(...args),
  isFeatureEnabledForViewer: (...args) => isFeatureEnabledForViewer(...args),
  isSessionActive,
  resumeSession,
  resumeNativeSession,
  stopSession,
  deleteSession,
  promptRenameSession,
  getSessionDisplayName,
  createAgentStatusIndicator,
  buildSessionFilterOptions,
  fetchSessions,
  bulkCloseStaleAutoSessions: bulkCloseStaleAutoSessionsApi,
  openConfirmDialog,
  syncMenuTabs,
  showToast,
  escapeHtml,
  PRIVACY_ROUTE,
  LIVE_ROUTE_PREFIX,
});
renderHome = homeViewModule.renderHome;

// Files API module — must init before dirBrowser and filesView which depend on these
const filesApiModule = initFilesApi({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  FILES_ROUTE,
  getFilesRoutePrefix: () => getFilesRoutePrefixForPath(window.location.pathname),
});
resetFilesPreview = filesApiModule.resetFilesPreview;
updateFilesUrl = filesApiModule.updateFilesUrl;
parseFilesPathFromUrl = filesApiModule.parseFilesPathFromUrl;
navigateToFilesSlug = filesApiModule.navigateToFilesSlug;
loadFilesTree = filesApiModule.loadFilesTree;
loadFilesPreview = filesApiModule.loadFilesPreview;
showFilesPreviewUnavailable = filesApiModule.showFilesPreviewUnavailable;
createFilesDirectory = filesApiModule.createFilesDirectory;
createFilesTextFile = filesApiModule.createFilesTextFile;
uploadFilesBinary = filesApiModule.uploadFilesBinary;
deleteFilesEntry = filesApiModule.deleteFilesEntry;
createDirectoryEntry = filesApiModule.createDirectoryEntry;
copyFilesEntry = filesApiModule.copyFilesEntry;
moveFilesEntry = filesApiModule.moveFilesEntry;

const dirBrowserModule = initDirectoryBrowser({
  state,
  directoryInput,
  directorySuggestions,
  directoryDialog,
  directoryTitle,
  directoryList,
  directoryCurrent,
  directoryUpButton,
  directoryNewFolderButton,
  directoryUseButton,
  browseDirectoryButton,
  fileTransferDialog,
  fileTransferTitle,
  fileTransferSource,
  fileTransferCurrent,
  fileTransferList,
  fileTransferSelected,
  fileTransferNameInput,
  fileTransferNameFeedback,
  fileTransferUpButton,
  fileTransferNewFolderButton,
  fileTransferConfirmButton,
  fileTransferCancelButton,
  createDirectoryEntry,
  moveFilesEntry,
  copyFilesEntry,
  resetFilesPreview,
  loadFilesTree,
  fetchConfig: (...args) => fetchConfig(...args),
  getSessionDialogController: () => sessionDialogController,
  showToast,
});
scheduleDirectorySuggestions = dirBrowserModule.scheduleDirectorySuggestions;
openDirectoryBrowser = dirBrowserModule.openDirectoryBrowser;
openFileTransferDialogForMode = dirBrowserModule.openFileTransferDialogForMode;

const filesViewModule = initFilesView({
  state,
  getCurrentRoute: () => currentRoute,
  getFilesSurface: () => getFilesSurfaceFromPath(window.location.pathname),
  render,
  loadFilesTree,
  loadFilesPreview,
  resetFilesPreview,
  showFilesPreviewUnavailable,
  createFilesDirectory,
  createFilesTextFile,
  uploadFilesBinary,
  deleteFilesEntry,
  openFileEditor: (...args) => openFileEditor(...args),
  canCreateWorktree: (...args) => canCreateWorktree(...args),
  openWorktreeModal: (...args) => openWorktreeModal(...args),
  openFileTransferDialogForMode,
  moveFilesEntry,
  launchSession: (...args) => launchSession(...args),
  getConfig: () => state.config,
  showToast,
  initFilesFromUrl: () => {
    const parsed = parseFilesPathFromUrl();
    if (parsed.slug) {
      void navigateToFilesSlug(parsed.slug);
    } else {
      void loadFilesTree();
    }
  },
});
renderFiles = filesViewModule.renderFiles;

const terminalViewModule = initTerminalView({
  state,
  render,
});
renderTerminal = terminalViewModule.renderTerminal;
disconnectTerminal = terminalViewModule.disconnectTerminal;

const liveViewModule = initLiveView({
  sessionsStore,
  appsStore,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (r) => { currentRoute = r; },
  getTabsVisible: () => tabsVisible,
  getTaskDispatchTabsVisible: () => taskDispatchTabsVisible,
  getLiveHeaderCollapsed: () => liveHeaderCollapsed,
  toggleLiveHeaderCollapsed,
  getRawTerminalOutputVisible: () => rawTerminalOutputVisible,
  toggleRawTerminalOutputVisible,
  appRoot,
  render,
  getActiveSessions,
  setActiveSession,
  stopSession,
  fetchLogs,
  fetchConversation,
  sendMessage,
  getSessionIdFromPath,
  ensureActiveSession,
  promptRenameSession,
  resumeNativeSession,
  sendControlCommand,
  scheduleLiveScroll,
  scrollConversationAreaToBottom,
  createAgentStatusIndicator,
  extractImageFiles,
  extractAttachmentFiles,
  handleImageUploads,
  handleAttachmentUploads,
  cleanupOrphanedMarkers,
  clearImagePreviews,
  prepareImagePreviewsForComposer,
  openVoiceNoteRecorder,
  openDialog,
  openSessionLaunchPalette: () => commandPaletteController?.openSessionLaunch?.(),
  navigateToApps: (...args) => navigateToApps(...args),
  isFeatureEnabledForViewer: (...args) => isFeatureEnabledForViewer(...args),
  showToast,
  renderAppCard: (...args) => renderAppCard(...args),
  refreshApps: (...args) => refreshApps(...args),
  triggerAppAction: (...args) => triggerAppAction(...args),
});
renderLive = liveViewModule.renderLive;
renderSessionTabs = liveViewModule.renderSessionTabs;
renderTabs = liveViewModule.renderTabs;
renderLiveTabsBarContent = liveViewModule.renderLiveTabsBarContent;
updateLivePanelsForSession = liveViewModule.updateLivePanelsForSession;
reconcileLiveSessionUi = liveViewModule.reconcileLiveSessionUi;
openArtifactPane = liveViewModule.openArtifactPane;
captureFocusSnapshot = liveViewModule.captureFocusSnapshot;
restoreFocusFromSnapshot = liveViewModule.restoreFocusFromSnapshot;

const fileEditorModule = initFileEditor({
  state,
  render,
  loadFilesTree,
  applyAceTheme,
  appRoot,
  loadAceEditor,
});
canCreateWorktree = fileEditorModule.canCreateWorktree;
openWorktreeModal = fileEditorModule.openWorktreeModal;
closeWorktreeModal = fileEditorModule.closeWorktreeModal;
openFileEditor = fileEditorModule.openFileEditor;
closeFileEditor = fileEditorModule.closeFileEditor;
getFileEditorDisplayTitle = fileEditorModule.getFileEditorDisplayTitle;
resetFileEditorState = fileEditorModule.resetFileEditorState;
renderFileEditorOverlay = fileEditorModule.renderFileEditorOverlay;
renderWorktreeModal = fileEditorModule.renderWorktreeModal;
destroyAceEditor = fileEditorModule.destroyAceEditor;
ensureAceEditorMounted = fileEditorModule.ensureAceEditorMounted;
requestFileEditorClose = fileEditorModule.requestFileEditorClose;
getAceEditorInstance = fileEditorModule.getAceEditorInstance;

// Identity DOM module (pure helpers + shared data structures)
const identityDomModule = initIdentityDom({ state, requestAuthUiSync });
identityDomEntryByNode = identityDomModule.identityDomEntryByNode;
IDENTITY_EVENT_NAMES = identityDomModule.IDENTITY_EVENT_NAMES;

initHeaderAvatarMenu({
  button: menuToggle,
  state,
  identityEventNames: IDENTITY_EVENT_NAMES,
});

// Identity state manager (handlers, event bridges, persistence)
const identityStateModule = initIdentityStateManager({
  state,
  dom: identityDomModule,
  sessionsStore,
  appsStore,
  render,
  fetchSessions,
  fetchApps,
  fetchConfig: (...args) => fetchConfig(...args),
  normalisePortList,
  closeIdentityLoginDialog,
  navigateToHome: (...args) => navigateToHome(...args),
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (r) => { currentRoute = r; },
  HOME_ROUTE,
  APP_LOG_PREVIEW_LINES,
});
updateIdentityState = identityStateModule.updateIdentityState;
handleIdentityCopy = identityStateModule.handleIdentityCopy;
handleIdentityLogout = identityStateModule.handleIdentityLogout;
handleUnauthorizedAccess = identityStateModule.handleUnauthorizedAccess;
forceIdentityLogoutState = identityStateModule.forceIdentityLogoutState;
registerIdentityDom = identityStateModule.registerIdentityDom;
bindIdentityFlows = identityStateModule.bindIdentityFlows;
getIdentityWiringContext = identityStateModule.getIdentityWiringContext;

const identityPanelsModule = initIdentityPanels({
  state,
  registerIdentityDom,
  bindIdentityFlows,
  navigateToSettings: (...args) => navigateToSettings(...args),
  IDENTITY_EVENT_NAMES,
});
renderIdentityPanel = identityPanelsModule.renderIdentityPanel;
renderIdentitySummary = identityPanelsModule.renderIdentitySummary;
renderMenuIdentitySection = identityPanelsModule.renderMenuIdentitySection;

const privateChatModule = initPrivateChat({
  state,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (r) => { currentRoute = r; },
  render,
  showToast,
});
loadChats = privateChatModule.loadChats;
loadChatMessages = privateChatModule.loadChatMessages;
navigateToChat = privateChatModule.navigateToChat;
openPrivateChatDialog = privateChatModule.openPrivateChatDialog;
deleteChat = privateChatModule.deleteChat;
renderChat = privateChatModule.renderChat;

const appDialogs = initAppDialogs({
  state,
  getCurrentRoute: () => currentRoute,
  render,
  refreshApps,
  getAppById,
  openDirectoryBrowser,
  formatWebAppUrl,
  linkAppToProject,
  deriveAppWindowName,
  sharedTmuxSession: SHARED_TMUX_SESSION,
  showToast,
});

openAppDialog = appDialogs.openAppDialog;
closeAppDialog = appDialogs.closeAppDialog;
openAppLogsDialog = appDialogs.openAppLogsDialog;
refreshAppLogs = appDialogs.refreshAppLogs;
resetAppDialog = appDialogs.resetAppDialog;
openDeployDialog = appDialogs.openDeployDialog;
openCaproverDialog = appDialogs.openCaproverDialog;

const appsViewModule = initAppsView({
  state,
  appsStore,
  getCurrentRoute: () => currentRoute,
  render,
  openAppDialog: (...args) => openAppDialog(...args),
  renderAppCard: (...args) => renderAppCard(...args),
  renderWingmanCard: (...args) => renderWingmanCard(...args),
  refreshApps: (...args) => refreshApps(...args),
  fetchApps: (...args) => fetchApps(...args),
  logPreviewLines: APP_LOG_PREVIEW_LINES,
  appStatusLabels: APP_STATUS_LABELS,
  formatAppTimestamp: (...args) => formatAppTimestamp(...args),
  normaliseNpubValue,
  abbreviateNpub,
});
renderApps = appsViewModule.renderApps;

const featureFlagsUI = initFeatureFlagsUI({
  state,
  render,
  showToast,
  abbreviateNpub,
});
ensureFeatureFlagsLoaded = featureFlagsUI.ensureLoaded;
renderFeatureFlagsPanel = featureFlagsUI.renderPanel;
syncFeatureFlagsFromConfig = featureFlagsUI.syncFromConfig;
resolveFeatureFlagForViewer = featureFlagsUI.resolveFlag;
isFeatureEnabledForViewer = featureFlagsUI.isEnabled;
projectsFeatureEnabledForViewer = featureFlagsUI.projectsEnabled;

const nightWatchUI = initNightWatchSettingsPanel({ state, render, showToast, createCollapsibleCard });
renderNightWatchSettingsPanel = nightWatchUI.renderPanel;
ensureNightWatchLoaded = nightWatchUI.ensureLoaded;

const nightWatchPageUI = initNightWatchPage({ state, showToast });
renderNightWatchPage = nightWatchPageUI.renderPage;
ensureNightWatchPageLoaded = nightWatchPageUI.ensureLoaded;

const schedulerPageUI = initSchedulerPage({ showToast, openDirectoryBrowser });
renderSchedulerPage = schedulerPageUI.renderPage;
ensureSchedulerPageLoaded = schedulerPageUI.ensureLoaded;

const pipelinesPageUI = initPipelinesPage({
  showToast,
  isFeatureEnabledForViewer: (...args) => isFeatureEnabledForViewer(...args),
});
renderPipelinesPage = pipelinesPageUI.renderPage;
ensurePipelinesPageLoaded = pipelinesPageUI.ensureLoaded;

renderMenuIdentitySection();

const handleTouchStart = (event) => {
  if (!pullRefreshIndicator || pullRefreshing) return;
  if (document.body.dataset.menuOpen === "true") return;

  const touch = event.touches?.[0];
  if (!touch) return;

  // Only allow pull-to-refresh if touch starts in header area
  const header = document.querySelector('.wm-header');
  if (!header) return;

  const headerRect = header.getBoundingClientRect();
  if (touch.clientY < headerRect.top || touch.clientY > headerRect.bottom) {
    return;
  }

  pullStartY = touch.clientY;
  pullActive = true;
  pullReady = false;
};

const handleTouchMove = (event) => {
  if (!pullActive || pullRefreshing || !pullRefreshIndicator) return;
  const touch = event.touches?.[0];
  if (!touch) return;

  const delta = touch.clientY - (pullStartY ?? touch.clientY);
  if (delta <= 0) {
    pullReady = false;
    setPullState("pull", 0);
    return;
  }
  const distance = Math.min(delta, PULL_MAX);
  if (distance > 0) {
    try {
      event.preventDefault();
    } catch {
      // ignore
    }
  }
  if (distance >= PULL_THRESHOLD) {
    pullReady = true;
    setPullState("release", distance);
  } else {
    pullReady = false;
    setPullState("pull", distance);
  }
};

const finishPull = () => {
  if (!pullActive) return;
  pullActive = false;
  if (pullReady && !pullRefreshing) {
    triggerPullRefresh();
  } else {
    resetPullRefresh();
  }
};

// Navigation module — extracted from app.js.
// All six navigateTo* functions and the nav event listeners live in navigation.js.
const {
  navigateToHome,
  navigateToApps,
  navigateToProjects,
  navigateToNightWatch,
  navigateToScheduler,
  navigateToTerminal,
  navigateToSettings,
  setupNavListeners,
} = createNavigation({
  closeMenu,
  closeIdentityLoginDialog,
  openIdentityLoginDialog,
  deactivateLiveSessionRefresh: (...args) => liveRefreshController?.deactivateSession(...args),
  render,
  getCurrentRoute: () => currentRoute,
  setCurrentRoute: (r) => { currentRoute = r; },
  setLastLoggedSessionId: (id) => { lastLoggedSessionId = id; },
  appsStore,
  sessionsStore,
  setActiveSession,
  state,
  showToast,
  projectsFeatureEnabledForViewer: (...args) => projectsFeatureEnabledForViewer(...args),
  isFeatureEnabledForViewer: (...args) => isFeatureEnabledForViewer(...args),
  get projectFeature() { return projectFeature; },
  ensureNightWatchPageLoaded: (...args) => ensureNightWatchPageLoaded(...args),
  ensureSchedulerPageLoaded: (...args) => ensureSchedulerPageLoaded(...args),
  ensurePipelinesPageLoaded: (...args) => ensurePipelinesPageLoaded(...args),
  loadFilesTree: (...args) => loadFilesTree(...args),
  updateFilesUrl: (...args) => updateFilesUrl(...args),
  getActiveSessionForIndicator,
  HOME_ROUTE,
  APPS_ROUTE,
  PROJECTS_ROUTE,
  NIGHTWATCH_ROUTE,
  TRIGGERS_ROUTE,
  SCHEDULER_ROUTE,
  PIPELINES_ROUTE,
  TERMINAL_ROUTE,
  SETTINGS_ROUTE,
  PRIVACY_ROUTE,
  navLinks,
  menuToggle,
  menuPanel,
  toggleMenu,
  getHandleIdentityLogout: () => handleIdentityLogout,
  getHandleIdentityCopy: () => handleIdentityCopy,
  getIdentityDomEntryByNode: () => identityDomEntryByNode,
});

setupNavListeners();

const commandPaletteFileActions = createCommandPaletteFileActions({
  state,
  sessionsStore,
  getCurrentRoute: () => currentRoute,
  getPathname: () => window.location.pathname,
  getSessionIdFromPath,
  setPinnedArtifact: setPinnedArtifactApi,
  setActiveSession,
  setCurrentRoute(nextRoute) {
    currentRoute = nextRoute;
  },
  render,
});

commandPaletteController = createAutopilotCommandPalette({
  brandButton: brandCommandPaletteButton,
  appsStore,
  sessionsStore,
  openDialog,
  openIdentityLoginDialog,
  isAuthenticated: () => state.identity.authenticated,
  state,
  launchSession,
  npubProjectsState,
  fetchNpubProjects,
  navigateHome: () => navigateToHome({ skipMenuClose: true }),
  navigateToApps: (...args) => navigateToApps(...args),
  getFileBrowserInitialPath: commandPaletteFileActions.getFileBrowserInitialPath,
  getFileBrowserSession: commandPaletteFileActions.getFileBrowserSession,
  pinFileToSession: commandPaletteFileActions.pinFileToSession,
  openSession(session) {
    if (!session?.id) return;
    currentRoute = "live";
    setActiveSession(session.id, { updateHistory: true, forceLog: true });
    render();
    requestAnimationFrame(() => {
      scrollConversationAreaToBottom(session.id, { includeWindow: true });
    });
  },
  renderAppCard: (...args) => renderAppCard(...args),
  refreshApps: (...args) => refreshApps(...args),
  triggerAppAction: (...args) => triggerAppAction(...args),
  resumeNativeSession,
  showToast,
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 720) {
    closeMenu();
  }
  const mobileLayout = isMobileFilesLayout();
  if (currentRoute === "files" && mobileLayout !== lastFilesMobileLayout) {
    lastFilesMobileLayout = mobileLayout;
    render();
  } else {
    lastFilesMobileLayout = mobileLayout;
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
  }
});

window.addEventListener("touchstart", handleTouchStart, { passive: true });
window.addEventListener("touchmove", handleTouchMove, { passive: false });
window.addEventListener("touchend", finishPull, { passive: true });
window.addEventListener("touchcancel", finishPull, { passive: true });

const scrollLiveViewIfVisible = () => {
  if (currentRoute !== "live") {
    return;
  }
  if (isComposerInteractionActive() || isMobileKeyboardOpen()) {
    return;
  }
  const scrollActiveId = sessionsStore().activeSessionId;
  if (!scrollActiveId) {
    return;
  }
  scheduleLiveScroll(scrollActiveId, { includeWindow: true });
};

window.addEventListener("focus", scrollLiveViewIfVisible);

// Initialize visibility manager for SSE reconnection on tab return
visibilityManager.init({
  getSessionId: () => sessionsStore().activeSessionId,
  checkHealth: (sessionId) => sseManager.isConnectionHealthy(sessionId),
  reconnect: (sessionId) => sseManager.reconnect(sessionId),
});

// Subscribe to visibility changes for scroll behavior
visibilityManager.onVisibilityChange((isVisible) => {
  if (isVisible) {
    scrollLiveViewIfVisible();
  }
});

window.addEventListener("popstate", () => {
  currentRoute = getRouteFromPath(window.location.pathname);
  if (currentRoute !== "live") {
    lastLoggedSessionId = null;
  }
  applyRouteSessionFromPath({ allowHistoryUpdate: false });
  if (currentRoute === "files") {
    const parsed = parseFilesPathFromUrl();
    if (!state.files.initialized) {
      state.files.initialized = true;
      if (parsed.slug) {
        void navigateToFilesSlug(parsed.slug);
      } else {
        void loadFilesTree();
      }
    } else if (parsed.slug) {
      void navigateToFilesSlug(parsed.slug);
    } else if (!state.files.loading && !state.files.currentPath) {
      void loadFilesTree();
    }
  } else if (currentRoute === "apps") {
    // void ensureAppsLoaded(); // DISABLED
  } else if (currentRoute === "projects") {
    if (!projectsFeatureEnabledForViewer()) {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    } else if (projectFeature) {
      void projectFeature.ensureLoaded();
    }
  } else if (currentRoute === "nightwatch") {
    if (!state.identity.isAdmin || !isFeatureEnabledForViewer("nightwatch_enabled")) {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    } else {
      void ensureNightWatchPageLoaded();
    }
  } else if (currentRoute === "scheduler") {
    if (!state.identity.isAdmin) {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    } else {
      void ensureSchedulerPageLoaded();
    }
  } else if (currentRoute === "pipelines") {
    void ensurePipelinesPageLoaded();
  } else if (currentRoute === "terminal") {
    if (!syncTerminalNavigationVisibility()) {
      currentRoute = "home";
      if (window.location.pathname !== HOME_ROUTE) {
        window.history.replaceState({ route: "home" }, "", HOME_ROUTE);
      }
    }
  }
  render();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.fileEditor.open) {
    event.preventDefault();
    requestFileEditorClose();
  }
});

const handleSessionLaunchRequest = () => {
  if (sessionDialogController) {
    sessionDialogController.handleSubmit();
    return;
  }
  const agentId = agentSelect?.value ?? "";
  const workingDirectory = directoryInput?.value ?? "";
  const sessionName = sessionNameInput?.value ?? "";
  const model = sessionModelSelect?.value ?? "";
  closeDialog();
  launchSession(agentId, workingDirectory, sessionName, null, {
    model: model.trim() || null,
  });
};

sessionForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  handleSessionLaunchRequest();
});

confirmButton.addEventListener("click", (event) => {
  event.preventDefault();
  handleSessionLaunchRequest();
});

cancelButton.addEventListener("click", (event) => {
  event.preventDefault();
  closeDialog();
});

dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});

(async () => {
  initTheme();
  initTabsVisibility();
  initTaskDispatchTabsVisibility();
  initLiveHeaderCollapsed();
  initRawTerminalOutputVisible();
  setupConversationSelectionLock();
  initLiveMobileRuntime();
  attachWorkingNotesToggle();
  attachMarkdownCodeBlockCopyHandler();
  // Initialize live module (Dexie database for SSE updates)
  initLiveModule().catch((err) => console.warn("[app] Live module init failed:", err));

  // Initialize Night Watch Alpine store (Dexie-backed, must register before Alpine.start)
  initNightWatchStore({ showToast, syncOnInit: false });
  initSchedulerStore({ showToast, syncOnInit: false });

  // Initialize Sessions Alpine store (Dexie-backed, must register before Alpine.start)
  initSessionsStore({
    showToast,
    getIdentity: () => state.identity,
    onUnauthorized: () => handleUnauthorizedAccess(),
    onIdentityUpdate: (update) => {
      if (update.ports) {
        update.ports = normalisePortList(update.ports);
      }
      updateIdentityState(update, { persist: true, emit: true });
    },
    onItemsChanged: () => {
      handleSessionsStoreItemsChanged();
    },
    onSessionCompleted: () => {
      void completionSoundController.notifyCompletion();
    },
    // The main bootstrap restores auth first, then performs the initial fetch.
    syncOnInit: false,
  });

  // Initialize Apps Alpine store (Dexie-backed, must register before Alpine.start)
  initAppsStore({
    showToast,
    getIdentity: () => state.identity,
    onUnauthorized: () => handleUnauthorizedAccess(),
    formatWebAppUrl,
    // Avoid protected app fetches before auth restoration completes.
    syncOnInit: false,
  });

  // Initialize Alpine.js chat component if enabled
  if (isAlpineChatEnabled()) {
    initAlpineChat();
    console.log("[app] Alpine.js chat component enabled");
  }

  // Ensure Alpine.js is started (chat-component may have started it already)
  if (!window.Alpine) {
    const { default: Alpine } = await import("/vendor/alpinejs/module.esm.js");
    window.Alpine = Alpine;
    Alpine.start();
    console.log("[app] Alpine.js started");
  }

  // Pre-populate active session from URL path (must run after Alpine.start)
  const initialRouteSessionId = getSessionIdFromPath(window.location.pathname);
  if (initialRouteSessionId) {
    const ss = sessionsStore();
    ss.activeSessionId = initialRouteSessionId;
    ss.lastActiveSessionId = initialRouteSessionId;
  }

  // Wire SSE status events to knight rider and status indicators
  sseManager.onStatusChange((sessionId, status) => {
    const nextRuntimeStatus = normalizeRuntimeStatus(status);
    const session = sessionsStore().items.find((s) => s.id === sessionId);
    if (session) {
      session.agentRuntimeStatus = nextRuntimeStatus;
    }
    void syncSessionStatusCaches(sessionId, { agentRuntimeStatus: nextRuntimeStatus });
    updateAgentStatusIndicators();
  });

  // SSE manager writes incoming messages into Dexie. The DOM then hydrates from
  // the canonical MessageStore path instead of maintaining a legacy mirror.
  sseManager.onMessage((sessionId, _message, meta = {}) => {
    void renderConversationForSession(sessionId, { isStreamingUpdate: meta.isStreamingUpdate });
  });

  // Render immediately from Dexie cache so the UI is visible while
  // network requests are in flight.
  render();

  // ── Sequential auth chain (each step depends on the previous) ──
  try {
    await fetchConfig();
  } catch (err) {
    console.warn("[app] Config fetch failed:", err);
    showToast("Failed to load app configuration", { type: "error" });
  }

  try {
    await restoreStartupIdentity({
      identityApi: wingmanIdentity,
      getIdentityWiringContext,
      isAuthenticated: () => state.identity.authenticated,
    });
  } finally {
    authRouteResolved = true;
    ensureFeatureFlagsLoaded();
    render();
  }

  // ── Parallel data fetches (independent of each other) ──
  const dataFetches = [];
  if (state.identity.authenticated) {
    dataFetches.push(fetchSessions({ waitForActiveSessionDetails: false }));
    dataFetches.push(fetchApps({ tail: APP_LOG_PREVIEW_LINES }));
    dataFetches.push(fetchNpubProjects().catch(() => {}));
    dataFetches.push(syncAuthenticatedStartupStores());
  }
  await Promise.all(dataFetches);

  // Start NIP-98 signing listener after auth + data are settled
  if (state.identity.authenticated && state.identity.npub) {
    startSigningListener(state.identity.npub);
  }

  // Live-refresh sessions via SSE so home page / nav update without reload
  if (state.identity.authenticated) {
    startSessionSubscriber({
      onConnect: () => {
        void fetchSessions({ waitForActiveSessionDetails: false });
      },
      onEvent: (event) => {
        void fetchSessions({ waitForActiveSessionDetails: false }).then(() => {
          if (event?.artifactIntent?.action === "open" && event.sessionId) {
            openArtifactPane(event.sessionId);
          }
        });
      },
    });
    window.addEventListener("wingman:identity-logout", () => stopSessionSubscriber(), { once: true });
  }

  // Re-render with fresh server data
  render();
})();
