import "./style.css";
import "./components/diff.css";
import "./git/git.css";
import "highlight.js/styles/github-dark.css";
import { createApiClient } from "./app/api.js";
import { getAppElements, initAppHeightSync } from "./app/elements.js";
import { initSwAutoReload } from "./app/sw-update.js";
import { setIcon } from "./app/icons.js";
import { initKeyboardShortcuts } from "./app/shortcuts.js";
import { createAppState, readActiveSessionIdFromUrl, readDashboardViewFromUrl } from "./app/types.js";
import { createComposer, type ComposerController } from "./composer/composer.js";
import { createContextMeter, type ContextMeterController } from "./composer/contextMeter.js";
import { createDashboard, type DashboardController } from "./dashboard/dashboard.js";
import { createWebHeaderActions } from "./extensions/webHeaderActions.js";
import { renderWebFooters } from "./extensions/webFooter.js";
import { initGitPanel } from "./git/panel.js";
import { createMarkdownRenderer } from "./markdown/render.js";
import { createMessageList } from "./messages/messageList.js";
import { createModelSettings, modelKey, modelLabel, type ModelSettings } from "./models/modelSettings.js";
import { createRealtime } from "./realtime/realtime.js";
import { createSessions, type SessionsController } from "./sessions/sessionDrawer.js";
import { createSettings, type SettingsController } from "./settings/settings.js";
import { createStatusBar, type StatusBar } from "./status/statusBar.js";
import { createToolCards } from "./tools/toolCards.js";
import { createConversationTree, type ConversationTreeController } from "./tree/conversationTree.js";

initAppHeightSync();
initSwAutoReload();

const elements = getAppElements();
const state = createAppState();
const api = createApiClient(state);
const markdown = createMarkdownRenderer(elements.messagesEl);
const messages = createMessageList({ messagesEl: elements.messagesEl, markdown });
const tools = createToolCards(elements.messagesEl, messages.scrollToBottom, api.headers);

let composer: ComposerController;
let contextMeter: ContextMeterController;
let modelSettings: ModelSettings;
let sessions: SessionsController;
let settings: SettingsController;
let statusBar: StatusBar;
let conversationTree: ConversationTreeController;
let dashboard: DashboardController;
const webHeaderActions = createWebHeaderActions({
  container: elements.headerActionsEl,
  headers: api.headers,
  getSessionId: () => state.currentSessionId,
  markdown,
});

function showSystemError(error: unknown) {
  messages.addMessage("system", error instanceof Error ? error.message : String(error), "error");
}

function updateMeta(data: any) {
  state.currentModelKey = modelKey(data.model);
  state.currentModelDisplay = data.model ? modelLabel(data.model) : "No model";
  state.currentThinkingLevel = data.thinkingLevel || "off";
  state.currentSessionId = data.sessionId || state.currentSessionId;
  state.currentCwd = data.cwd || state.currentCwd;
  if ("stats" in data) contextMeter.update(data.stats);
  if ("webFooters" in data) renderWebFooters(elements.extensionFooterEl, data.webFooters);
  if ("webHeaderActions" in data) webHeaderActions.render(data.webHeaderActions);
  if ("sessionTitle" in data) statusBar.setStatusTitle(data.sessionTitle?.trim() || "New session");
  else if ("sessionName" in data) statusBar.setStatusTitle(data.sessionName?.trim() || "New session");
  elements.statusPathEl.textContent = state.currentCwd;
  elements.statusPathEl.title = state.currentCwd
    ? `Working directory: ${state.currentCwd}. Click to change.`
    : "Set working directory";
  modelSettings.updateSummary();
  if (sessions) {
    if (data.sessionUiState) sessions.applySessionUiState(data.sessionUiState);
    else {
      sessions.renderSessionBar();
      sessions.renderCurrentSessionBucketButton();
    }
  }
}

function updateSessionStats(stats: any) {
  contextMeter.update(stats);
}

async function refreshMessages() {
  await messages.refreshMessages({
    sessionId: state.currentSessionId,
    headers: api.headers,
    addToolHistoryCard: tools.addToolHistoryCard,
    addPendingToolCard: tools.startTool,
    addRuntimeErrorCard: tools.addRuntimeErrorCard,
    clearActiveToolCards: tools.clearActiveToolCards,
    isStreaming: state.isStreaming,
    updateEmptyCwdChooser: () => sessions.updateEmptyCwdChooser(),
  });
}

async function refreshState() {
  const query = state.currentSessionId ? `?sessionId=${encodeURIComponent(state.currentSessionId)}` : "";
  const res = await fetch(`/api/state${query}`, { headers: api.headers() });
  if (res.status === 401) {
    elements.tokenOverlay.hidden = false;
    elements.tokenInput.focus();
    return;
  }
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  updateMeta(data);
  state.isStreaming = Boolean(data.isStreaming);
  state.isCompacting = Boolean(data.isCompacting);
  if (state.isStreaming || state.isCompacting) statusBar.markActivityStart(
    state.isCompacting ? "compacting" : "active",
    data.runtimeStartedAt || data.runtime?.startedAt,
    data.runtimeLastActivityAt || data.runtime?.lastActivityAt,
  );
  else statusBar.markActivityEnd();
  contextMeter.update(state.stats);
  composer.updatePrimaryAction();
  const [settingsResult, modelsResult, messagesResult] = await Promise.allSettled([
    settings.refreshSettings(),
    modelSettings.refreshModels(),
    refreshMessages(),
  ]);
  for (const result of [settingsResult, modelsResult, messagesResult]) {
    if (result.status === "rejected") messages.addMessage("system", result.reason instanceof Error ? result.reason.message : String(result.reason), "error");
  }
  state.initialSyncComplete = messagesResult.status === "fulfilled";
  if (messagesResult.status === "fulfilled") sessions.markSessionRead().catch((error) => messages.addMessage("system", error instanceof Error ? error.message : String(error), "error"));
  composer.updatePrimaryAction();
}

function initStaticIcons() {
  setIcon(elements.sessionButton, "menu");
  setIcon(elements.newSessionHeaderButton, "square-pen");
  setIcon(elements.conversationTreeButton, "git-fork");
  setIcon(elements.attachButton, "paperclip");
  setIcon(elements.primaryButton, "send-horizontal");
  setIcon(elements.expandButton, "maximize-2");
  setIcon(elements.gitButton, "git-branch");
  setIcon(elements.currentSessionBucketButton, "flag");
  setIcon(elements.settingsButton, "settings");
  setIcon(elements.dashboardButton, "layout-dashboard");
  setIcon(elements.dashboardCloseButton, "x");
  setIcon(elements.stopButton, "square");
}

modelSettings = createModelSettings({
  state,
  elements,
  api,
  updateMeta,
  addMessage: messages.addMessage,
});

statusBar = createStatusBar({
  state,
  elements,
  api,
  updateMeta,
  addMessage: messages.addMessage,
  refreshSessions: () => sessions.refreshSessions(),
  refreshState,
});

settings = createSettings({
  state,
  elements,
  api,
  addMessage: messages.addMessage,
});

contextMeter = createContextMeter({ state, elements });

sessions = createSessions({
  state,
  elements,
  api,
  updateMeta,
  updateThinkingOptions: (levels) => modelSettings.updateThinkingOptions(levels),
  refreshModels: () => modelSettings.refreshModels(),
  refreshMessages,
  refreshState,
  refreshSessionTitle: () => statusBar.refreshSessionTitle(),
  clearMessages: () => {
    tools.clearActiveToolCards();
    messages.clear();
  },
  addMessage: messages.addMessage,
});

dashboard = createDashboard({
  elements,
  api,
  sessions,
  addMessage: messages.addMessage,
  getSessionId: () => state.currentSessionId,
});

composer = createComposer({
  state,
  elements,
  api,
  addMessage: messages.addMessage,
  updateMeta,
  updateThinkingOptions: (levels) => modelSettings.updateThinkingOptions(levels),
  refreshModels: () => modelSettings.refreshModels(),
  refreshMessages,
  refreshState,
  beginStreamFollow: messages.beginStreamFollow,
  endStreamFollow: messages.endStreamFollow,
});

conversationTree = createConversationTree({
  state,
  elements,
  api,
  composer,
  updateMeta,
  refreshMessages,
  addMessage: messages.addMessage,
});

const realtime = createRealtime({
  state,
  elements,
  api,
  composer,
  messages,
  models: modelSettings,
  sessions,
  status: statusBar,
  tools,
  settings,
  conversationTree,
  dashboard,
  updateMeta,
  updateSessionStats,
  refreshMessages,
  refreshState,
  addMessage: messages.addMessage,
});

initStaticIcons();
statusBar.init();
sessions.init();
contextMeter.init();
composer.init();
conversationTree.init();
modelSettings.init();
settings.init();
dashboard.init();
elements.dashboardButton.addEventListener("click", () => dashboard.open());
// The status-bar cwd path is a button: clicking it opens the folder picker to change the
// working directory at any time (an empty session switches in place; a session with messages
// starts a new one in the chosen folder — pi pins a session to its cwd after the first message).
elements.statusPathEl.setAttribute("role", "button");
elements.statusPathEl.tabIndex = 0;
elements.statusPathEl.addEventListener("click", () => sessions.changeWorkingDirectory());
elements.statusPathEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  sessions.changeWorkingDirectory();
});
initKeyboardShortcuts([
  {
    id: "sessions.toggleDrawer",
    key: "b",
    scope: "global",
    mod: true,
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden,
    run: () => sessions.setSessionDrawerOpen(elements.sessionDrawer.hidden),
  },
  {
    id: "dashboard.toggle",
    key: "h",
    scope: "global",
    mod: true,
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden,
    run: () => dashboard.toggle(),
  },
  {
    id: "dashboard.close",
    key: "Escape",
    scope: "dashboard",
    allowInEditable: true,
    when: () => dashboard.isOpen(),
    run: () => dashboard.close(),
  },
  {
    id: "session.stopFromPrompt",
    key: "Escape",
    scope: "composer",
    allowInEditable: true,
    when: () => elements.tokenOverlay.hidden
      && elements.slashCommandsEl.hidden
      && state.isStreaming,
    run: () => composer.stopStreaming(),
  },
], {
  getScopes: () => {
    const scopes: string[] = [];
    if (!elements.tokenOverlay.hidden) scopes.push("token");
    if (!elements.settingsPanel.hidden) scopes.push("settings");
    if (!elements.modelSettingsPopover.hidden) scopes.push("modelSettings");
    if (conversationTree.isOpen()) scopes.push("conversationTree");
    if (document.activeElement === elements.promptEl) scopes.push("composer");
    if (!elements.sessionDrawer.hidden) scopes.push("sessions");
    if (!elements.gitPanel.hidden) scopes.push("git");
    if (dashboard.isOpen()) scopes.push("dashboard");
    return scopes;
  },
  onError: showSystemError,
});
composer.updateQueueToggle();
initGitPanel({ button: elements.gitButton, panel: elements.gitPanel, apiHeaders: api.headers, getSessionId: () => state.currentSessionId });
window.addEventListener("popstate", () => {
  // Reconcile the `/dashboard` route first, independent of the session change below — Back/Forward
  // must open/close the route on its own.
  dashboard.reconcileFromUrl();
  // On the `/dashboard` route the URL carries no `?sessionId=`, but the conversation underneath
  // must be preserved (closing returns to it). Skip the session reconcile here so navigating onto
  // the route doesn't clobber state.currentSessionId to "" and lose the session.
  if (readDashboardViewFromUrl()) return;
  const nextSessionId = readActiveSessionIdFromUrl();
  if (nextSessionId === state.currentSessionId) return;
  state.currentSessionId = nextSessionId;
  tools.clearActiveToolCards();
  messages.clear();
  sessions.renderSessionBar();
  sessions.refreshSessions().catch(() => undefined);
  refreshState().catch(showSystemError);
});
composer.updatePrimaryAction();

// Route: a hard load of `/dashboard` renders the dashboard as the PRIMARY view. Use `replace` so
// reload doesn't push a spurious history entry (the path is already `/dashboard`). This fires
// before the settings-driven launch default so an explicit route always wins.
const dashboardDeepLinked = readDashboardViewFromUrl();
if (dashboardDeepLinked) dashboard.open({ mode: "replace" });

// Whether the user deep-linked a SPECIFIC session via `?sessionId=` at load. Captured from the
// URL up front (before refreshState's updateMeta overwrites state.currentSessionId with the
// server's default/mock session), so the launch default means "no session was explicitly
// requested" — not "the server happened to have no current session".
const sessionDeepLinkedAtLaunch = Boolean(readActiveSessionIdFromUrl());

refreshState()
  .then(() => {
    // Launch default (Settings → "Open dashboard on launch"): open the dashboard when the app
    // loads WITHOUT a specific session in the URL and WITHOUT the deep-link already having opened
    // it. Guard on the current overlay state so a session the user opened meanwhile isn't clobbered.
    if (!dashboardDeepLinked && !sessionDeepLinkedAtLaunch && state.settings.dashboard.openOnLaunch && !dashboard.isOpen()) {
      dashboard.open({ mode: "replace" });
    }
  })
  .catch(showSystemError);
realtime.connect();
