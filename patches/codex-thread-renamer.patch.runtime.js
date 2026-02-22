'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');

const PATCH_NS = '__codexThreadRenamerPatchRuntime__';
const RUNTIME_VERSION = '0.1.0';

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
  wrapActivate(parent, vscode, state);
}

function patchProviderCapture(vscode, state) {
  if (state.patchedRegistrations) {
    return;
  }
  state.patchedRegistrations = true;

  const originalRegisterWebviewViewProvider = vscode.window.registerWebviewViewProvider.bind(vscode.window);
  vscode.window.registerWebviewViewProvider = function patchedRegisterWebviewViewProvider(viewType, provider, options) {
    if (viewType === 'chatgpt.sidebarView' && provider) {
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

function wrapActivate(parent, vscode, state) {
  if (state.patchedActivate) {
    return;
  }
  state.patchedActivate = true;

  const originalActivate = parent.exports.activate;
  if (typeof originalActivate !== 'function') {
    return;
  }

  parent.exports.activate = async function patchedActivate(context) {
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

  const disposable = vscode.commands.registerCommand('chatgpt.renameThread', async (args) => {
    const output = ensureOutput(vscode, state);
    try {
      await runRenameCommand(vscode, context, state, args);
    } catch (error) {
      output.appendLine(`[error] ${formatError(error)}`);
      vscode.window.showErrorMessage(`Codex rename patch: ${formatError(error)}`);
    }
  });

  state.commandDisposable = disposable;
  if (context && context.subscriptions && Array.isArray(context.subscriptions)) {
    context.subscriptions.push(disposable);
    if (state.output) {
      context.subscriptions.push(state.output);
    }
  }
}

async function runRenameCommand(vscode, context, state, args) {
  const output = ensureOutput(vscode, state);
  ensureBinaryAvailable('sqlite3', '--version');

  const normalized = normalizeCommandArgs(args);
  const workspaceFolder = pickWorkspaceFolder(vscode);
  const codeUserDir = getVsCodeUserDir();
  const workspaceStorageDir = findWorkspaceStorageDirForFolder(codeUserDir, workspaceFolder.uri.toString());
  const workspaceDb = path.join(workspaceStorageDir, 'state.vscdb');
  assertFileExists(workspaceDb, 'Workspace state DB not found');

  let threads = readCodexThreadsFromWorkspaceCache(workspaceDb);
  if (threads.length === 0 && normalized.threadId) {
    threads = [{ threadId: normalized.threadId, kind: 'local', label: normalized.threadId, resource: '' }];
  }
  if (threads.length === 0) {
    throw new Error('No Codex threads found in workspace cache.');
  }

  let thread = null;
  if (normalized.threadId) {
    thread = threads.find((t) => t.threadId === normalized.threadId) || {
      threadId: normalized.threadId,
      kind: 'local',
      label: normalized.threadId,
      resource: '',
    };
  } else {
    thread = await pickThread(vscode, threads);
  }

  let newName = normalized.name;
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
        matches.push({ dir, mtimeMs: fs.statSync(dir).mtimeMs });
      }
    } catch {
      // ignore
    }
  }

  if (matches.length === 0) {
    throw new Error(`No workspaceStorage entry found for ${folderUri}`);
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0].dir;
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
    throw new Error('Rename cancelled.');
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
