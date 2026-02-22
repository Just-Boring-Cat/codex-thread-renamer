# Codex Thread Renamer Patcher

Patches the installed VS Code `openai.chatgpt` extension to support live Codex thread renaming.

What it adds:
- `chatgpt.renameThread` command (visible in Command Palette)
- live UI title update by sending existing `thread-title-updated` message to the Codex webview(s)
- backend persistent rename via Codex `app-server` (`thread/resume` + `thread/name/set`)
- thread-row right-click context menu in the Codex webview (`Rename Thread`)
- cache patching fallback (workspace/global/Codex thread title caches)

Why patching is needed:
- VS Code does not provide a public API for one extension to post messages into another extension's webview.
- The OpenAI extension already has the internal UI cache and message handlers, so patching that extension runtime is the only reliable path to live rename.

## Commands

```bash
node bin/codex-thread-renamer-patch.js status
node bin/codex-thread-renamer-patch.js apply
node bin/codex-thread-renamer-patch.js verify
```

Optional flags:
- `--extension-dir <path>`: patch a specific installed `openai.chatgpt-*` directory
- `--dry-run`: show what would change

## What gets patched

- `package.json`
- `out/extension.js` (runtime hook loader only)
- `webview/index.html` (loads injected webview helper)
- Added files:
  - `out/codex-thread-renamer.patch.runtime.js`
  - `webview/assets/codex-thread-renamer.patch.webview.js`

## How It Works (Exact Flow)

This project patches the installed OpenAI extension in a minimal way and keeps most logic in two injected files.

### 1) Manifest patch (`package.json`)

The patcher adds a new command contribution:
- `chatgpt.renameThread` -> `Rename Codex Thread`

It also adds menu entries:
- Command Palette entry
- `webview/context` entry for the Codex sidebar webview

This is why VS Code can show the menu item even before the runtime command is registered.

### 2) Runtime hook patch (`out/extension.js`)

The patcher does not rewrite the OpenAI extension internals.
It appends a tiny loader to `out/extension.js` that does only this:

- `require('./codex-thread-renamer.patch.runtime.js').installRuntimePatch()`

That injected runtime file then:
- hooks `vscode.window.registerWebviewViewProvider(...)` and `registerCustomEditorProvider(...)`
- captures the OpenAI Codex webview provider instance (the object that owns the sidebar/panel webviews)
- registers `chatgpt.renameThread`
- sends live `thread-title-updated` messages into the already-open Codex webviews

This is the key part that a separate extension cannot do reliably.

### 3) Webview helper patch (`webview/index.html`)

The patcher injects a small helper script into `webview/index.html`:
- `./assets/codex-thread-renamer.patch.webview.js`

That helper runs inside the Codex webview and adds:
- right-click menu on thread titles (it watches for elements with `data-thread-title`)
- `Rename Thread` action
- a `prompt(...)`-based rename dialog

When you confirm a new name, it sends a normal webview message already supported by the OpenAI extension:
- `open-vscode-command` with command `chatgpt.renameThread`

Important implementation detail:
- The helper wraps `acquireVsCodeApi()` safely and acquires lazily, so it does not break the main Codex webview bootstrap.

### 4) `chatgpt.renameThread` command execution (in injected runtime)

When the command runs, it performs both persistent and live updates:

1. Backend rename (real source of truth)
- Starts `codex app-server`
- Sends:
  - `initialize`
  - `thread/resume`
  - `thread/name/set`

2. Cache patching (fallback + persistence across stale clients)
- Patches workspace cache:
  - `workspaceStorage/.../state.vscdb` -> `agentSessions.model.cache`
- Patches VS Code global extension state:
  - `globalStorage/state.vscdb` -> `openai.chatgpt` -> `thread-titles`
- Patches Codex global state:
  - `~/.codex/.codex-global-state.json` -> `thread-titles`

3. Live UI update (immediate)
- Broadcasts existing OpenAI webview message:
  - `thread-title-updated`
- The Codex webview already knows how to handle this and updates `threadTitleCache` + UI immediately

### Why both backend rename and cache patching?

- Backend rename (`thread/name/set`) is the real persistent thread name.
- Cache patching prevents stale titles from older cached state from coming back.
- Live webview message gives instant visual update without reload.

## Rename Sequence (End-to-End)

User action options:
- Command Palette -> `Rename Codex Thread`
- Right-click thread title in Codex sidebar -> `Rename Thread`

Flow:
1. Webview helper resolves thread id from the clicked thread row/link
2. Webview sends `open-vscode-command(chatgpt.renameThread, {threadId,name})`
3. Injected runtime command runs backend rename + cache patching
4. Injected runtime posts `thread-title-updated` to open Codex webviews
5. UI updates immediately and persists

## Compatibility / Safety Checks

Before applying, `verify` checks for expected signatures in the installed OpenAI extension, including:
- `open-vscode-command` handler exists in `out/extension.js`
- `registerWebviewViewProvider(...)` exists
- webview bundle handles `thread-title-updated`
- webview thread titles include `data-thread-title`

If these signatures change in a future OpenAI release, the patcher should fail verification instead of patching blindly.

## Testing (Recommended)

1. Run `status` and `verify`
2. Apply patch
3. Restart Extension Host / reload VS Code window
4. Test Command Palette rename
5. Test right-click rename in Codex thread list
6. Test persistence after:
   - switching threads
   - restarting extension host
   - reopening VS Code window

## Troubleshooting

- Menu item appears but command says `command 'chatgpt.renameThread' not found`
  - Runtime patch did not register the command yet
  - Restart Extension Host / reload window
  - Check `Output` -> `Codex Thread Renamer Patch`

- Codex UI breaks after patch
  - Most likely webview helper issue
  - Reapply latest patcher version (the helper now lazily acquires VS Code API)
  - If needed, restore from the `*.pre-codex-thread-renamer-patch-*.bak` backups

- Rename persists but UI does not update immediately
  - Live webview provider capture may have failed
  - Check output channel logs
  - Reopen Codex sidebar / switch threads

## Known Issues (Tracked)

- Canceling the rename prompt currently surfaces an error toast:
  - `Codex rename patch: Rename cancelled.`
  - This is a UX issue only, not a functional failure.
  - Planned fix: treat user cancel as a silent no-op (no error toast).

## Notes

- Reapply after updating the `openai.chatgpt` extension.
- The patcher creates timestamped backups before modifying files.
