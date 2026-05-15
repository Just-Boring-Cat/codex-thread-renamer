# Changelog

## 0.1.1 - 2026-05-15

Compatibility update for newer `openai.chatgpt` extension builds.

### Added

- Verification now scans all webview JavaScript bundles instead of only the primary `index-*.js` bundle.
- Verification now excludes the injected helper bundle and checks the OpenAI webview's built-in thread rename signature.
- Webview helper now supports newer `data-app-action-sidebar-thread-*` thread row/title attributes.
- Inline rename flow and `Cmd+R` / `Ctrl+R` rename shortcut support.
- Context-aware `Rename Thread` contribution for the original VS Code webview menu.

### Fixed

- Canceling rename input now exits silently instead of showing an error toast.
- Live title updates now patch both older `data-thread-title` nodes and newer sidebar title nodes.
- Right-click rename no longer replaces the original menu; the native menu now keeps `Rename Thread in Codex Sidebar` above `New Thread in Codex Sidebar`.
- Sidebar right-clicks outside a thread row now show both Codex sidebar actions.
- The Command Palette rename flow now starts inline rename for the current thread when one is active, and falls back to the thread picker outside a thread.

## 0.1.0 - 2026-02-22

Initial working patcher release for adding live Codex thread rename support to the VS Code `openai.chatgpt` extension.

### Added

- Patcher CLI with:
  - `status`
  - `verify`
  - `apply`
- Minimal patch strategy:
  - `package.json` command/menu contributions
  - `out/extension.js` runtime loader injection
  - `webview/index.html` webview helper injection
- Injected runtime patch (`out/codex-thread-renamer.patch.runtime.js`) that:
  - registers `chatgpt.renameThread`
  - performs backend rename via Codex `app-server`
  - patches workspace/global/Codex title caches
  - sends live `thread-title-updated` messages to Codex webviews
- Injected webview helper (`webview/assets/codex-thread-renamer.patch.webview.js`) that:
  - adds right-click `Rename Thread` on Codex thread titles
  - forwards rename requests through `open-vscode-command`
### Fixed During Development

- Webview bootstrap breakage caused by eager `acquireVsCodeApi()` usage in the helper
  - changed to a safe wrapper + lazy acquisition
- Incorrect menu patch shape
  - fixed from nested `menus.webview.context` to literal `menus[\"webview/context\"]`
- Runtime command registration reliability
  - command now registers early so the contributed menu item resolves at runtime
