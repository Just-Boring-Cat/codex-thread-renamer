# Changelog

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
- `.context` wrapper script for reapplying the patch after extension updates:
  - `.context/scripts/apply-codex-thread-renamer-patch.sh`

### Fixed During Development

- Webview bootstrap breakage caused by eager `acquireVsCodeApi()` usage in the helper
  - changed to a safe wrapper + lazy acquisition
- Incorrect menu patch shape
  - fixed from nested `menus.webview.context` to literal `menus[\"webview/context\"]`
- Runtime command registration reliability
  - command now registers early so the contributed menu item resolves at runtime

### Known Issues

- Canceling the rename prompt currently shows an error toast:
  - `Codex rename patch: Rename cancelled.`
  - Expected future behavior: silent cancel with no error toast
