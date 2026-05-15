# How It Works

This patcher modifies the installed VS Code `openai.chatgpt` extension in a minimal way and keeps most custom logic in injected files.

## Patch Points

The patcher updates only these extension files:

- `package.json`
- `out/extension.js`
- `webview/index.html`

It also writes two injected files:

- `out/codex-thread-renamer.patch.runtime.js`
- `webview/assets/codex-thread-renamer.patch.webview.js`

## 1) Manifest Patch (`package.json`)

The patcher adds:

- `chatgpt.renameThread` command contribution (`Rename Codex Thread`)
- hidden `chatgpt.renameThreadInline` helper command for webview-driven inline edits
- hidden `chatgpt.renameThreadRememberContext` helper command for remembering the right-clicked thread
- Command Palette entry
- `Cmd+R` / `Ctrl+R` keybinding when the Codex sidebar or conversation editor is active
- a context-aware `webview/context` menu item that appears only on marked Codex thread rows

This keeps the public command available while preserving the original Codex/VS Code context menu.

## 2) Runtime Hook (`out/extension.js`)

The patcher appends a tiny loader to `out/extension.js` that loads:

- `./codex-thread-renamer.patch.runtime.js`

The injected runtime patch then:

- hooks `registerWebviewViewProvider(...)` and `registerCustomEditorProvider(...)`
- captures the OpenAI Codex webview provider instance
- registers the `chatgpt.renameThread` command
- sends live `thread-title-updated` messages into open Codex webviews

This is what enables immediate UI updates.

## 3) Webview Helper (`webview/index.html`)

The patcher injects a helper script tag into `webview/index.html`:

- `./assets/codex-thread-renamer.patch.webview.js`

The helper runs inside the Codex webview and adds:

- `data-vscode-context` markers on thread rows so VS Code can show `Rename Thread in Codex Sidebar` only there
- right-click context tracking for the selected thread without preventing the original menu
- inline title editing
- fallback command targeting when the current webview DOM does not expose a thread id

When confirmed, the helper sends `open-vscode-command` to invoke:

- `chatgpt.renameThread`

Important:

- The helper uses a safe, lazy `acquireVsCodeApi()` wrapper to avoid breaking Codex webview startup.

## 4) Rename Command Execution

When `chatgpt.renameThread` runs, it performs three layers of work.

Thread targeting works like this:

- If the command is invoked from a thread row context action, that thread is renamed directly.
- If the Codex sidebar is currently inside a thread route, the runtime asks the webview for that current thread and renames it directly.
- If a Codex conversation editor tab is active, the current thread is renamed directly.
- If no active thread can be resolved, the command falls back to the thread picker.

### A. Backend rename (source of truth)

The runtime patch starts `codex app-server` and sends:

- `initialize`
- `thread/resume`
- `thread/name/set`

This updates the persistent thread name in Codex backend state.

### B. Cache patching (fallback persistence)

The runtime patch also patches title caches to reduce stale title rehydration:

- Workspace cache (`agentSessions.model.cache`)
- VS Code global extension state (`openai.chatgpt` -> `thread-titles`)
- Codex global state (`~/.codex/.codex-global-state.json` -> `thread-titles`)

### C. Live UI update (immediate)

The runtime patch posts the existing Codex webview message:

- `thread-title-updated`

The OpenAI Codex webview already handles this and updates the visible title immediately.

## Why Patch the OpenAI Extension Instead of Building a Separate Extension?

VS Code does not expose a public API for one extension to post messages into another extension's webview.

A separate helper can patch files/databases, but it cannot reliably update the live Codex UI in-memory state. Patching the OpenAI extension runtime is what makes live rename work.

## Verification Strategy

Before patching, `verify` checks extension signatures such as:

- `open-vscode-command` handler exists in `out/extension.js`
- all webview JavaScript bundles are scanned for `thread-title-updated`
- thread rows expose `data-thread-title`
- the webview still exposes the built-in `rename-thread` action

Injected helper bundles are excluded from signature scanning so verification only reflects the installed OpenAI extension build.

If these signatures change, the patcher should fail verification rather than patching blindly.
