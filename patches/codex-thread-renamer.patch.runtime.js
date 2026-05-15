'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');

const PATCH_NS = '__codexThreadRenamerPatchRuntime__';
const RUNTIME_VERSION = '0.1.0';
const TRACE_FILE = path.join(os.tmpdir(), 'codex-thread-renamer-runtime.log');

function installRuntimePatch() {
  const parent = module.parent;
  if (!parent || !parent.exports || typeof parent.exports.activate !== 'function') {
    return;
  }

  if (globalThis[PATCH_NS]?.installed) {
    return;
  }

  const vscode = require('vscode');
  const state = {
    installed: true,
    provider: null,
    commandRegistered: false,
    commandDisposable: null,
    output: null,
    patchedActivate: false,
    patchedRegistrations: false,
    webviewMessageHooked: false,
    hookedWebviews: new WeakSet(),
    currentThreadRequestSeq: 0,
    pendingCurrentThreadRequests: new Map(),
    inlineRenameRequestSeq: 0,
    pendingInlineRenameRequests: new Map(),
    lastContextThread: null,
  };
  globalThis[PATCH_NS] = state;

  patchProviderCapture(vscode, state);
  // Register the command immediately so it exists even if activate wrapping misses.
  try {
    ensureOutput(vscode, state);
    registerRenameCommand(vscode, null, state);
    state.output.appendLine('[codex-thread-renamer-patch] command registered (early)');
  } catch (error) {
    try {
      ensureOutput(vscode, state);
      state.output.appendLine(`[codex-thread-renamer-patch] early command registration failed: ${formatError(error)}`);
    } catch {
      // ignore
    }
  }
  tryWrapActivate(parent, vscode, state);
}

function patchProviderCapture(vscode, state) {
  if (state.patchedRegistrations) {
    return;
  }
  state.patchedRegistrations = true;

  const originalRegisterWebviewViewProvider = vscode.window.registerWebviewViewProvider.bind(vscode.window);
  vscode.window.registerWebviewViewProvider = function patchedRegisterWebviewViewProvider(viewType, provider, options) {
    if ((viewType === 'chatgpt.sidebarView' || viewType === 'chatgpt.sidebarSecondaryView') && provider) {
      state.provider = provider;
    }
    return originalRegisterWebviewViewProvider(viewType, provider, options);
  };

  const originalRegisterCustomEditorProvider = vscode.window.registerCustomEditorProvider.bind(vscode.window);
  vscode.window.registerCustomEditorProvider = function patchedRegisterCustomEditorProvider(viewType, provider, options) {
    if (viewType === 'chatgpt.conversationEditor' && provider && !state.provider) {
      state.provider = provider;
    }
    return originalRegisterCustomEditorProvider(viewType, provider, options);
  };
}

function tryWrapActivate(parent, vscode, state) {
  if (state.patchedActivate) {
    return;
  }

  const exportsObject = parent.exports;
  if (!exportsObject) {
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(exportsObject, 'activate');
  const originalActivate = descriptor && typeof descriptor.get === 'function'
    ? descriptor.get.call(exportsObject)
    : exportsObject.activate;
  if (typeof originalActivate !== 'function') {
    return;
  }

  const patchedActivate = async function patchedActivate(context) {
    const result = await originalActivate.apply(this, arguments);
    try {
      ensureOutput(vscode, state);
      registerRenameCommand(vscode, context, state);
      state.output.appendLine('[codex-thread-renamer-patch] runtime patch active');
    } catch (error) {
      try {
        ensureOutput(vscode, state);
        state.output.appendLine(`[codex-thread-renamer-patch] failed to register command: ${formatError(error)}`);
      } catch {
        // ignore
      }
    }
    return result;
  };

  if (descriptor && descriptor.configurable) {
    Object.defineProperty(exportsObject, 'activate', {
      configurable: true,
      enumerable: descriptor.enumerable !== false,
      writable: true,
      value: patchedActivate,
    });
    state.patchedActivate = true;
    return;
  }

  if (!descriptor || descriptor.writable) {
    exportsObject.activate = patchedActivate;
    state.patchedActivate = true;
  }
}

function ensureOutput(vscode, state) {
  if (!state.output) {
    state.output = vscode.window.createOutputChannel('Codex Thread Renamer Patch');
  }
  return state.output;
}

function registerRenameCommand(vscode, context, state) {
  if (state.commandRegistered) {
    return;
  }
  state.commandRegistered = true;

  const renameCommands = [
    ['chatgpt.renameThread', { mode: 'smart' }],
    ['chatgpt.renameThreadInline', { mode: 'inline' }],
  ].map(([commandId, options]) => vscode.commands.registerCommand(commandId, async (args) => {
    const output = ensureOutput(vscode, state);
    try {
      await runRenameCommand(vscode, context, state, args, options);
    } catch (error) {
      output.appendLine(`[error] ${formatError(error)}`);
      vscode.window.showErrorMessage(`Codex rename patch: ${formatError(error)}`);
    }
  }));

  const rememberContextCommand = vscode.commands.registerCommand('chatgpt.renameThreadRememberContext', (args) => {
    const output = ensureOutput(vscode, state);
    const contextThread = normalizeContextThreadArgs(args);
    state.lastContextThread = contextThread ? { ...contextThread, at: Date.now() } : null;
    trace(output, 'remember-context-thread', state.lastContextThread);
  });

  const disposables = [...renameCommands, rememberContextCommand];

  state.commandDisposable = disposables;
  if (context && context.subscriptions && Array.isArray(context.subscriptions)) {
    for (const disposable of disposables) {
      context.subscriptions.push(disposable);
    }
    if (state.output) {
      context.subscriptions.push(state.output);
    }
  }
}

async function runRenameCommand(vscode, context, state, args, options = { mode: 'picker' }) {
  const output = ensureOutput(vscode, state);
  ensureBinaryAvailable('sqlite3', '--version');
  ensureWebviewMessageHook(vscode, state);

  const normalized = normalizeCommandArgs(args);
  const workspaceFolder = pickWorkspaceFolder(vscode);
  const codeUserDir = getVsCodeUserDir();
  const workspaceStorageDir = findWorkspaceStorageDirForFolder(codeUserDir, workspaceFolder.uri.toString());
  const workspaceDb = path.join(workspaceStorageDir, 'state.vscdb');
  assertFileExists(workspaceDb, 'Workspace state DB not found');
  trace(output, 'runRenameCommand:start', {
    workspaceFolder: workspaceFolder.uri.toString(),
    workspaceStorageDir,
    normalized,
  });

  let threads = readCodexThreadsFromWorkspaceCache(workspaceDb);
  if (threads.length === 0 && normalized.threadId) {
    threads = [{ threadId: normalized.threadId, kind: 'local', label: normalized.threadId, resource: '' }];
  }
  if (threads.length === 0) {
    throw new Error('No Codex threads found in workspace cache.');
  }
  trace(output, 'runRenameCommand:threads', {
    count: threads.length,
    active: threads.filter((thread) => Number(thread.status) === 2).map((thread) => ({
      threadId: thread.threadId,
      label: thread.label,
      status: thread.status,
    })),
  });

  let resolved = null;
  if (normalized.threadId) {
    resolved = {
      source: 'explicit',
      thread: threads.find((thread) => thread.threadId === normalized.threadId) || {
        threadId: normalized.threadId,
        kind: 'local',
        label: normalized.threadId,
        resource: '',
      },
    };
  } else if (options.mode === 'inline' || options.mode === 'smart') {
    resolved = await resolveThreadForRename(vscode, state, normalized, threads, output);
  } else {
    resolved = {
      source: 'picker',
      thread: await pickThread(vscode, threads),
    };
  }

  const thread = resolved.thread;
  if (!thread) {
    output.appendLine('[info] rename cancelled');
    return;
  }
  trace(output, 'runRenameCommand:resolved', {
    mode: options.mode || 'picker',
    source: resolved.source,
    threadId: thread?.threadId || null,
    label: thread?.label || null,
    status: thread?.status ?? null,
  });

  let newName = normalized.name;
  const shouldStartInlineRename = !newName && resolved.source !== 'picker' && (options.mode === 'inline' || options.mode === 'smart');
  if (shouldStartInlineRename) {
    const startedInlineRename = await requestInlineRename(vscode, state, {
      threadId: thread.threadId,
      title: thread.label || '',
    }, output);
    if (startedInlineRename) {
      output.appendLine('[info] inline rename started in Codex webview');
      return;
    }
    throw new Error('Could not start inline rename for the selected Codex thread.');
  }
  if (!newName) {
    newName = await promptForThreadName(vscode, thread.label || '');
    if (newName == null) {
      return;
    }
  }
  newName = String(newName).trim();
  if (!newName) {
    throw new Error('Thread name cannot be empty.');
  }

  output.appendLine(`[info] workspace=${workspaceFolder.uri.fsPath}`);
  output.appendLine(`[info] threadId=${thread.threadId}`);
  output.appendLine(`[info] name=${newName}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Renaming Codex thread',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Calling Codex backend...' });
      await backendRename(context, output, thread.threadId, newName);

      progress.report({ message: 'Patching title caches...' });
      const cacheSummary = patchKnownCaches(output, workspaceStorageDir, workspaceDb, thread.threadId, newName);

      progress.report({ message: 'Updating live Codex UI...' });
      const liveUpdated = broadcastLiveTitleUpdate(state.provider, thread.threadId, newName, output);

      const parts = [];
      if (cacheSummary.workspace) parts.push('workspace cache');
      if (cacheSummary.global) parts.push('global cache');
      if (cacheSummary.codex) parts.push('codex cache');
      const cacheMsg = parts.length ? ` Patched ${parts.join(', ')}.` : '';
      const liveMsg = liveUpdated ? ' UI updated live.' : ' UI may need a refresh.';
      vscode.window.showInformationMessage(`Renamed thread to "${newName}".${cacheMsg}${liveMsg}`);
    }
  );
}

function normalizeCommandArgs(args) {
  if (args == null) return { threadId: null, name: null };

  if (Array.isArray(args)) {
    const [a, b] = args;
    if (isObject(a)) {
      return {
        threadId: typeof a.threadId === 'string' ? a.threadId : null,
        name: typeof a.name === 'string' ? a.name : (typeof b === 'string' ? b : null),
      };
    }
    return {
      threadId: typeof a === 'string' ? a : null,
      name: typeof b === 'string' ? b : null,
    };
  }

  if (isObject(args)) {
    return {
      threadId: typeof args.threadId === 'string' ? args.threadId : null,
      name: typeof args.name === 'string' ? args.name : null,
    };
  }

  return { threadId: null, name: null };
}

function normalizeContextThreadArgs(args) {
  const value = Array.isArray(args) ? args[0] : args;
  if (!isObject(value)) return null;
  const threadId = typeof value.threadId === 'string' ? normalizeThreadId(value.threadId, value.kind) : null;
  if (!threadId) return null;
  return {
    threadId,
    kind: typeof value.kind === 'string' && value.kind ? value.kind : 'local',
    label: typeof value.title === 'string' && value.title ? value.title : threadId,
    resource: typeof value.resource === 'string' ? value.resource : '',
  };
}

function normalizeThreadId(value, kind) {
  if (!value) return null;
  const id = String(value).trim();
  if (!id) return null;
  if (kind === 'local' && id.startsWith('local:')) return id.slice('local:'.length);
  if (kind === 'remote' && id.startsWith('remote:')) return id.slice('remote:'.length);
  if (kind === 'pending-worktree' && id.startsWith('pending-worktree:')) return id.slice('pending-worktree:'.length);
  if (id.startsWith('local:')) return id.slice('local:'.length);
  if (id.startsWith('remote:')) return id.slice('remote:'.length);
  return id;
}

async function resolveThreadForRename(vscode, state, normalized, threads, output) {
  if (normalized.threadId) {
    return {
      source: 'explicit',
      thread: threads.find((t) => t.threadId === normalized.threadId) || {
        threadId: normalized.threadId,
        kind: 'local',
        label: normalized.threadId,
        resource: '',
      },
    };
  }

  const contextThread = consumeRecentContextThread(state, threads, output);
  if (contextThread) {
    return { source: 'context-menu', thread: contextThread };
  }

  const sidebarThread = await queryCurrentSidebarThread(vscode, state, output);
  trace(output, 'resolveThreadForRename:sidebarThread', sidebarThread);
  if (sidebarThread) {
    if (sidebarThread.threadId) {
      const known = threads.find((thread) => thread.threadId === sidebarThread.threadId);
      if (known) {
        return { source: 'sidebar-current', thread: known };
      }
      return {
        source: 'sidebar-current',
        thread: {
          threadId: sidebarThread.threadId,
          kind: sidebarThread.kind || 'local',
          label: sidebarThread.title || sidebarThread.threadId,
          resource: sidebarThread.resource || '',
        },
      };
    }

    const matchedByTitle = matchSidebarThreadByTitle(sidebarThread.title, threads);
    if (matchedByTitle) {
      return { source: 'sidebar-current', thread: matchedByTitle };
    }
  }

  const activeThread = findActiveThreadForRename(vscode, threads);
  if (activeThread) {
    trace(output, 'resolveThreadForRename:active-tab', {
      threadId: activeThread.threadId,
      label: activeThread.label,
    });
    return { source: 'active-tab', thread: activeThread };
  }

  trace(output, 'resolveThreadForRename:picker', { threadCount: threads.length });
  return { source: 'picker', thread: await pickThread(vscode, threads) };
}

function consumeRecentContextThread(state, threads, output) {
  const contextThread = state.lastContextThread;
  state.lastContextThread = null;
  if (!contextThread || !contextThread.threadId) {
    return null;
  }
  const ageMs = Date.now() - Number(contextThread.at || 0);
  if (ageMs < 0 || ageMs > 15000) {
    trace(output, 'context-thread:expired', { threadId: contextThread.threadId, ageMs });
    return null;
  }
  const known = threads.find((thread) => thread.threadId === contextThread.threadId);
  if (known) {
    trace(output, 'context-thread:known', { threadId: known.threadId, label: known.label, ageMs });
    return known;
  }
  trace(output, 'context-thread:synthetic', { threadId: contextThread.threadId, label: contextThread.label, ageMs });
  return {
    threadId: contextThread.threadId,
    kind: contextThread.kind || 'local',
    label: contextThread.label || contextThread.threadId,
    resource: contextThread.resource || '',
  };
}

function matchSidebarThreadByTitle(title, threads) {
  const normalizedTitle = normalizeThreadTitle(title);
  if (!normalizedTitle) {
    return null;
  }

  const exact = threads.filter((thread) => normalizeThreadTitle(thread.label) === normalizedTitle);
  if (exact.length === 1) {
    return exact[0];
  }

  const contains = threads.filter((thread) => {
    const label = normalizeThreadTitle(thread.label);
    return label && (label.includes(normalizedTitle) || normalizedTitle.includes(label));
  });
  if (contains.length === 1) {
    return contains[0];
  }

  return null;
}

function normalizeThreadTitle(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function findSingleInProgressThread(threads) {
  const active = threads.filter((thread) => Number(thread.status) === 2);
  return active.length === 1 ? active[0] : null;
}

function findMostRecentThread(threads) {
  const ranked = threads
    .filter((thread) => Number(thread.lastActivity || 0) > 0)
    .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0));
  if (ranked.length === 0) {
    return null;
  }
  if (ranked.length === 1) {
    return ranked[0];
  }

  const first = Number(ranked[0].lastActivity || 0);
  const second = Number(ranked[1].lastActivity || 0);
  if (first > second) {
    return ranked[0];
  }
  return null;
}

function findActiveThreadForRename(vscode, threads) {
  const activeTab = vscode.window?.tabGroups?.activeTabGroup?.activeTab || null;
  const activeRef = extractThreadRefFromTab(activeTab);
  if (activeRef) {
    const known = threads.find((thread) => thread.threadId === activeRef.threadId);
    if (known) {
      return known;
    }
    return {
      threadId: activeRef.threadId,
      kind: activeRef.kind || 'local',
      label: activeTab?.label || activeRef.threadId,
      resource: activeRef.resource || '',
    };
  }

  return null;
}

function extractThreadRefFromTab(tab) {
  if (!tab || !tab.input) return null;
  const input = tab.input;
  if (typeof input.viewType === 'string' && input.viewType !== 'chatgpt.conversationEditor') {
    return null;
  }

  const inputs = [];
  if (input.uri) inputs.push(input.uri);
  if (input.modified) inputs.push(input.modified);
  if (input.original) inputs.push(input.original);

  for (const candidate of inputs) {
    const ref = extractThreadRefFromUri(candidate);
    if (ref) {
      return ref;
    }
  }

  return null;
}

function extractThreadRefFromUri(uri) {
  if (!uri) return null;

  let value = '';
  if (typeof uri === 'string') {
    value = uri;
  } else if (typeof uri.toString === 'function') {
    try {
      value = uri.toString(true);
    } catch {
      value = uri.toString();
    }
  }

  if (!value) return null;

  const match = value.match(/\/(local|remote)\/([^/?#]+)/);
  if (!match) return null;
  return {
    kind: match[1],
    threadId: decodeURIComponent(match[2]),
    resource: value,
  };
}

function ensureWebviewMessageHook(vscode, state) {
  const provider = state.provider;
  if (!provider) {
    return;
  }

  const webviews = [];
  if (provider.sidebarView?.webview) {
    webviews.push(provider.sidebarView.webview);
  }
  if (provider.editorPanels && typeof provider.getWebviewForPanel === 'function') {
    for (const panel of Array.from(provider.editorPanels.keys())) {
      const webview = provider.getWebviewForPanel(panel);
      if (webview) webviews.push(webview);
    }
  }

  for (const webview of webviews) {
    if (!webview || typeof webview.onDidReceiveMessage !== 'function') continue;
    if (state.hookedWebviews.has(webview)) continue;
    webview.onDidReceiveMessage((message) => {
      handleRuntimeWebviewMessage(state, message);
    });
    state.hookedWebviews.add(webview);
    state.webviewMessageHooked = true;
  }
}

function handleRuntimeWebviewMessage(state, message) {
  if (!message) {
    return;
  }
  if (message.type === 'codex-thread-renamer/current-thread-response') {
    const requestId = typeof message.requestId === 'number' ? message.requestId : null;
    if (requestId == null) {
      return;
    }
    const pending = state.pendingCurrentThreadRequests.get(requestId);
    if (!pending) {
      return;
    }
    state.pendingCurrentThreadRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(message.payload || null);
    return;
  }
  if (message.type === 'codex-thread-renamer/inline-rename-response') {
    const requestId = typeof message.requestId === 'number' ? message.requestId : null;
    if (requestId == null) {
      return;
    }
    const pending = state.pendingInlineRenameRequests.get(requestId);
    if (!pending) {
      return;
    }
    if (message.ok === true) {
      state.pendingInlineRenameRequests.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(true);
    }
  }
}

async function requestInlineRename(vscode, state, thread, output) {
  ensureWebviewMessageHook(vscode, state);
  const provider = state.provider;
  if (!provider || typeof provider.postMessageToWebview !== 'function') {
    return false;
  }

  const requestId = ++state.inlineRenameRequestSeq;
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pendingInlineRenameRequests.delete(requestId);
      resolve(false);
    }, 1000);
    state.pendingInlineRenameRequests.set(requestId, { resolve, timer });
    try {
      const sent = postMessageToKnownWebviews(provider, {
        type: 'codex-thread-renamer/start-inline-rename',
        requestId,
        payload: thread,
      }, output);
      if (!sent) {
        clearTimeout(timer);
        state.pendingInlineRenameRequests.delete(requestId);
        resolve(false);
      }
    } catch (error) {
      clearTimeout(timer);
      state.pendingInlineRenameRequests.delete(requestId);
      if (output) {
        output.appendLine(`[warn] inline-rename request failed: ${formatError(error)}`);
      }
      resolve(false);
    }
  });

  if (output) {
    output.appendLine(`[info] inline-rename-response=${result ? 'started' : 'not-started'}`);
  }
  return result;
}

function postMessageToKnownWebviews(provider, message, output) {
  let sent = false;
  try {
    if (provider.sidebarView && provider.sidebarView.webview && typeof provider.postMessageToWebview === 'function') {
      provider.postMessageToWebview(provider.sidebarView.webview, message);
      sent = true;
    }
  } catch (error) {
    if (output) output.appendLine(`[warn] sidebar webview post failed: ${formatError(error)}`);
  }

  try {
    if (provider.editorPanels && typeof provider.getWebviewForPanel === 'function' && typeof provider.postMessageToWebview === 'function') {
      for (const panel of Array.from(provider.editorPanels.keys())) {
        const webview = provider.getWebviewForPanel(panel);
        if (!webview) continue;
        provider.postMessageToWebview(webview, message);
        sent = true;
      }
    }
  } catch (error) {
    if (output) output.appendLine(`[warn] editor webview post failed: ${formatError(error)}`);
  }

  return sent;
}

async function queryCurrentSidebarThread(vscode, state, output) {
  ensureWebviewMessageHook(vscode, state);
  const provider = state.provider;
  if (!provider || !provider.sidebarView || !provider.sidebarView.webview || typeof provider.postMessageToWebview !== 'function') {
    return null;
  }

  const requestId = ++state.currentThreadRequestSeq;
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pendingCurrentThreadRequests.delete(requestId);
      resolve(null);
    }, 700);
    state.pendingCurrentThreadRequests.set(requestId, { resolve, timer });
    try {
      provider.postMessageToWebview(provider.sidebarView.webview, {
        type: 'codex-thread-renamer/get-current-thread',
        requestId,
      });
    } catch (error) {
      clearTimeout(timer);
      state.pendingCurrentThreadRequests.delete(requestId);
      if (output) {
        output.appendLine(`[warn] current-thread request failed: ${formatError(error)}`);
      }
      resolve(null);
    }
  });

  if (result && output) {
    output.appendLine(`[info] current-thread-from-sidebar=${result.threadId || 'none'}`);
  }
  trace(output, 'queryCurrentSidebarThread:result', result);
  return result;
}

function pickWorkspaceFolder(vscode) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('Open a workspace folder first.');
  }
  return folders[0];
}

function getVsCodeUserDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  }
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) {
      throw new Error('APPDATA is not set.');
    }
    return path.join(process.env.APPDATA, 'Code', 'User');
  }
  return path.join(home, '.config', 'Code', 'User');
}

function findWorkspaceStorageDirForFolder(codeUserDir, folderUri) {
  const workspaceStorageDir = path.join(codeUserDir, 'workspaceStorage');
  assertDirExists(workspaceStorageDir, 'workspaceStorage directory not found');

  const matches = [];
  for (const entry of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(workspaceStorageDir, entry.name);
    const workspaceJson = path.join(dir, 'workspace.json');
    if (!fs.existsSync(workspaceJson)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(workspaceJson, 'utf8'));
      if (data && data.folder === folderUri) {
        matches.push({
          dir,
          mtimeMs: fs.statSync(dir).mtimeMs,
          score: scoreWorkspaceStorageDir(dir),
        });
      }
    } catch {
      // ignore
    }
  }

  if (matches.length === 0) {
    throw new Error(`No workspaceStorage entry found for ${folderUri}`);
  }
  matches.sort((a, b) => {
    if (b.score.activeCount !== a.score.activeCount) {
      return b.score.activeCount - a.score.activeCount;
    }
    if (b.score.latestActivity !== a.score.latestActivity) {
      return b.score.latestActivity - a.score.latestActivity;
    }
    return b.mtimeMs - a.mtimeMs;
  });
  return matches[0].dir;
}

function scoreWorkspaceStorageDir(dir) {
  try {
    const dbPath = path.join(dir, 'state.vscdb');
    if (!fs.existsSync(dbPath)) {
      return { activeCount: 0, latestActivity: 0 };
    }
    const raw = readItemTableValue(dbPath, 'agentSessions.model.cache');
    if (!raw) {
      return { activeCount: 0, latestActivity: 0 };
    }
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) {
      return { activeCount: 0, latestActivity: 0 };
    }

    let activeCount = 0;
    let latestActivity = 0;
    for (const item of items) {
      if (!item || item.providerType !== 'openai-codex') continue;
      if (Number(item.status) === 2) {
        activeCount += 1;
      }
      latestActivity = Math.max(
        latestActivity,
        Number(item?.timing?.lastRequestStarted || 0),
        Number(item?.timing?.created || 0)
      );
    }
    return { activeCount, latestActivity };
  } catch {
    return { activeCount: 0, latestActivity: 0 };
  }
}

function readCodexThreadsFromWorkspaceCache(workspaceDb) {
  const raw = readItemTableValue(workspaceDb, 'agentSessions.model.cache');
  if (!raw) {
    return [];
  }
  let items;
  try {
    items = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse agentSessions.model.cache: ${formatError(error)}`);
  }
  if (!Array.isArray(items)) return [];

  const threads = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || item.providerType !== 'openai-codex') continue;
    const resource = typeof item.resource === 'string' ? item.resource : '';
    const match = resource.match(/\/(local|remote)\/([^/?#]+)$/);
    if (!match) continue;
    const kind = match[1];
    const threadId = match[2];
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    threads.push({
      threadId,
      kind,
      resource,
      label: typeof item.label === 'string' && item.label ? item.label : threadId,
      status: typeof item.status === 'number' ? item.status : null,
      lastActivity: Math.max(
        Number(item?.timing?.lastRequestStarted || 0),
        Number(item?.timing?.created || 0)
      ),
    });
  }
  return threads;
}

async function pickThread(vscode, threads) {
  if (threads.length === 1) return threads[0];
  const picked = await vscode.window.showQuickPick(
    threads.map((thread) => ({
      label: thread.label,
      description: `${thread.kind} • ${thread.threadId}`,
      detail: thread.resource || '',
      thread,
    })),
    {
      title: 'Choose Codex thread to rename',
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );
  if (!picked) {
    return null;
  }
  return picked.thread;
}

async function promptForThreadName(vscode, current) {
  const value = await vscode.window.showInputBox({
    title: 'New Codex thread name',
    value: current || '',
    prompt: 'Enter a new thread title',
    validateInput: (v) => (String(v || '').trim() ? null : 'Thread name cannot be empty.'),
  });
  if (value === undefined) return null;
  return String(value).trim();
}

async function backendRename(context, output, threadId, newName) {
  const codexBin = findCodexBinary(context);
  output.appendLine(`[info] codexBin=${codexBin}`);
  const client = new RpcClient(codexBin, output);
  try {
    await client.renameThread(threadId, newName);
  } finally {
    await client.dispose();
  }
}

function findCodexBinary(context) {
  const candidates = [];
  const suffix = process.platform === 'win32' ? 'codex.exe' : 'codex';
  if (context && context.extensionUri && context.extensionUri.fsPath) {
    const extBin = path.join(context.extensionUri.fsPath, 'bin');
    if (fs.existsSync(extBin)) {
      for (const entry of fs.readdirSync(extBin, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(extBin, entry.name, suffix);
        if (fs.existsSync(file)) {
          candidates.push(file);
        }
      }
    }
  }
  const userExtDir = path.join(os.homedir(), '.vscode', 'extensions');
  if (fs.existsSync(userExtDir)) {
    for (const entry of fs.readdirSync(userExtDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('openai.chatgpt-')) continue;
      const binRoot = path.join(userExtDir, entry.name, 'bin');
      if (!fs.existsSync(binRoot)) continue;
      for (const pd of fs.readdirSync(binRoot, { withFileTypes: true })) {
        if (!pd.isDirectory()) continue;
        const file = path.join(binRoot, pd.name, suffix);
        if (fs.existsSync(file)) candidates.push(file);
      }
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0];
  }
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const found = cp.spawnSync(whichCmd, ['codex'], { encoding: 'utf8' });
  if (found.status === 0 && found.stdout.trim()) {
    return found.stdout.trim().split(/\r?\n/)[0];
  }
  throw new Error('Could not find codex binary.');
}

function patchKnownCaches(output, workspaceStorageDir, workspaceDb, threadId, newName) {
  const codeUserDir = getVsCodeUserDir();
  const workspaceDbBackup = path.join(workspaceStorageDir, 'state.vscdb.backup');
  const globalDb = path.join(codeUserDir, 'globalStorage', 'state.vscdb');
  const globalDbBackup = path.join(codeUserDir, 'globalStorage', 'state.vscdb.backup');
  const codexGlobalStateJson = path.join(os.homedir(), '.codex', '.codex-global-state.json');

  for (const file of [workspaceDb, workspaceDbBackup, globalDb, globalDbBackup, codexGlobalStateJson]) {
    backupFile(file, output);
  }

  let workspace = false;
  try {
    workspace = patchWorkspaceAgentSessionsCache(workspaceDb, threadId, newName) || workspace;
  } catch (error) {
    output.appendLine(`[warn] workspace cache patch failed: ${formatError(error)}`);
  }
  try {
    if (fs.existsSync(workspaceDbBackup)) patchWorkspaceAgentSessionsCache(workspaceDbBackup, threadId, newName);
  } catch (error) {
    output.appendLine(`[warn] workspace backup cache patch failed: ${formatError(error)}`);
  }

  let global = false;
  try {
    if (fs.existsSync(globalDb)) global = patchGlobalOpenAiStateDb(globalDb, threadId, newName) || global;
  } catch (error) {
    output.appendLine(`[warn] global cache patch failed: ${formatError(error)}`);
  }
  try {
    if (fs.existsSync(globalDbBackup)) patchGlobalOpenAiStateDb(globalDbBackup, threadId, newName);
  } catch (error) {
    output.appendLine(`[warn] global backup cache patch failed: ${formatError(error)}`);
  }

  let codex = false;
  try {
    if (fs.existsSync(codexGlobalStateJson)) codex = patchCodexGlobalStateJson(codexGlobalStateJson, threadId, newName) || codex;
  } catch (error) {
    output.appendLine(`[warn] codex global state patch failed: ${formatError(error)}`);
  }

  return { workspace, global, codex };
}

function backupFile(filePath, output) {
  if (!fs.existsSync(filePath)) return null;
  const out = `${filePath}.pre-thread-rename-${stamp()}.bak`;
  try {
    fs.copyFileSync(filePath, out);
    if (output) output.appendLine(`[info] backup ${out}`);
    return out;
  } catch (error) {
    if (output) output.appendLine(`[warn] backup failed ${filePath}: ${formatError(error)}`);
    return null;
  }
}

function patchWorkspaceAgentSessionsCache(dbPath, threadId, newName) {
  const raw = readItemTableValue(dbPath, 'agentSessions.model.cache');
  if (!raw) return false;
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) return false;
  let changed = false;
  for (const item of items) {
    if (!item || item.providerType !== 'openai-codex') continue;
    const resource = typeof item.resource === 'string' ? item.resource : '';
    if (resource.endsWith(threadId) && item.label !== newName) {
      item.label = newName;
      changed = true;
    }
  }
  if (changed) {
    writeItemTableValue(dbPath, 'agentSessions.model.cache', JSON.stringify(items));
  }
  return changed;
}

function patchGlobalOpenAiStateDb(dbPath, threadId, newName) {
  const raw = readItemTableValue(dbPath, 'openai.chatgpt');
  if (!raw) return false;
  const obj = JSON.parse(raw);
  if (!isObject(obj)) return false;
  const changed = patchThreadTitlesMapInObject(obj, threadId, newName);
  if (changed) {
    writeItemTableValue(dbPath, 'openai.chatgpt', JSON.stringify(obj));
  }
  return changed;
}

function patchCodexGlobalStateJson(filePath, threadId, newName) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const obj = JSON.parse(raw);
  if (!isObject(obj)) return false;
  const changed = patchThreadTitlesMapInObject(obj, threadId, newName);
  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
  }
  return changed;
}

function patchThreadTitlesMapInObject(obj, threadId, newName) {
  let changed = false;
  if (!isObject(obj['thread-titles'])) {
    obj['thread-titles'] = {};
    changed = true;
  }
  const threadTitles = obj['thread-titles'];
  if (!isObject(threadTitles.titles)) {
    threadTitles.titles = {};
    changed = true;
  }
  if (!Array.isArray(threadTitles.order)) {
    threadTitles.order = [];
    changed = true;
  }
  if (threadTitles.titles[threadId] !== newName) {
    threadTitles.titles[threadId] = newName;
    changed = true;
  }
  if (!threadTitles.order.includes(threadId)) {
    threadTitles.order.unshift(threadId);
    changed = true;
  }
  return changed;
}

function broadcastLiveTitleUpdate(provider, threadId, newName, output) {
  const msg = { type: 'thread-title-updated', conversationId: threadId, title: newName };
  let sent = false;
  try {
    if (provider && typeof provider.broadcastToAllViews === 'function') {
      provider.broadcastToAllViews(msg);
      sent = true;
    }
  } catch (error) {
    output.appendLine(`[warn] broadcastToAllViews failed: ${formatError(error)}`);
  }

  try {
    if (!provider) return sent;
    if (provider.sidebarView && provider.sidebarView.webview && typeof provider.postMessageToWebview === 'function') {
      provider.postMessageToWebview(provider.sidebarView.webview, msg);
      sent = true;
    }
    if (provider.editorPanels && typeof provider.getWebviewForPanel === 'function' && typeof provider.postMessageToWebview === 'function') {
      for (const panel of Array.from(provider.editorPanels.keys())) {
        const webview = provider.getWebviewForPanel(panel);
        if (webview) {
          provider.postMessageToWebview(webview, msg);
          sent = true;
        }
      }
    }
  } catch (error) {
    output.appendLine(`[warn] direct webview post failed: ${formatError(error)}`);
  }
  return sent;
}

function readItemTableValue(dbPath, key) {
  const sql = `SELECT quote(value) FROM ItemTable WHERE key = ${sqlString(key)};`;
  const out = runSqlite(dbPath, sql).trim();
  if (!out || out === 'NULL') return null;
  return parseSqliteQuotedString(out);
}

function writeItemTableValue(dbPath, key, value) {
  const sql = `UPDATE ItemTable SET value = ${sqlString(value)} WHERE key = ${sqlString(key)};`;
  runSqlite(dbPath, sql);
}

function runSqlite(dbPath, sql) {
  const res = cp.spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error((res.stderr || `sqlite3 exit ${res.status}`).trim());
  }
  return res.stdout || '';
}

function sqlString(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function parseSqliteQuotedString(s) {
  if (!(s.startsWith("'") && s.endsWith("'"))) {
    throw new Error(`Unexpected sqlite quote() output: ${s.slice(0, 80)}`);
  }
  return s.slice(1, -1).replace(/''/g, "'");
}

function ensureBinaryAvailable(bin, arg) {
  const res = cp.spawnSync(bin, [arg || '--version'], { encoding: 'utf8' });
  if (res.error) {
    throw new Error(`${bin} is required but not found in PATH.`);
  }
}

function assertFileExists(filePath, msg) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${msg}: ${filePath}`);
  }
}

function assertDirExists(dirPath, msg) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`${msg}: ${dirPath}`);
  }
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function trace(output, message, payload) {
  const line = `[trace] ${message}${payload === undefined ? '' : ` ${safeJson(payload)}`}`;
  if (output) {
    output.appendLine(line);
  }
  try {
    fs.appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

class RpcClient {
  constructor(codexBin, output) {
    this.output = output;
    this.proc = cp.spawn(codexBin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.nextId = 1;
    this.pending = new Map();
    this.disposed = false;

    this.proc.on('error', (err) => this.rejectAll(new Error(`Failed to start codex app-server: ${err.message}`)));
    this.proc.on('exit', (code, signal) => {
      if (!this.disposed) {
        this.rejectAll(new Error(`codex app-server exited (code=${code}, signal=${signal || 'none'})`));
      }
    });

    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this._onStdoutLine(line));
    readline.createInterface({ input: this.proc.stderr }).on('line', (line) => {
      if (line && line.trim()) this.output.appendLine(`[codex stderr] ${line}`);
    });
  }

  async renameThread(threadId, newName) {
    const init = await this.request('initialize', {
      clientInfo: { name: 'codex-thread-renamer-patch', title: 'Codex Thread Renamer Patch', version: RUNTIME_VERSION },
      capabilities: { experimentalApi: true },
    }, 10000);
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);

    const resume = await this.request('thread/resume', { threadId, persistExtendedHistory: false }, 30000);
    if (resume.error) throw new Error(`thread/resume failed: ${JSON.stringify(resume.error)}`);

    const rename = await this.request('thread/name/set', { threadId, name: newName }, 10000);
    if (rename.error) throw new Error(`thread/name/set failed: ${JSON.stringify(rename.error)}`);
  }

  request(method, params, timeoutMs) {
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.proc.stdin.write(payload + '\n', 'utf8', (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(new Error(`Failed to write ${method}: ${err.message}`));
        }
      });
    });
  }

  _onStdoutLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const id = msg && msg.id != null ? String(msg.id) : null;
    if (!id) return;
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timeout);
    this.pending.delete(id);
    p.resolve(msg);
  }

  rejectAll(err) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error('RPC client disposed'));
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { this.proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 1000);
      this.proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try { this.proc.kill('SIGTERM'); } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }
}

module.exports = { installRuntimePatch };
