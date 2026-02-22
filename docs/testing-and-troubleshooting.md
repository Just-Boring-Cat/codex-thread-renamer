# Testing And Troubleshooting

## Recommended Test Flow

1. Run patch checks:
   - `node bin/codex-thread-renamer-patch.js status`
   - `node bin/codex-thread-renamer-patch.js verify`
2. Apply patch:
   - `node bin/codex-thread-renamer-patch.js apply`
3. Reload VS Code:
   - `Developer: Restart Extension Host` or reload window
4. Test rename in two ways:
   - Command Palette -> `Rename Codex Thread`
   - Right-click a thread title -> `Rename Thread`
5. Test persistence:
   - switch threads and back
   - restart extension host
   - reopen the VS Code window

## Common Problems

## Menu Item Appears But Command Fails

Error:

- `command 'chatgpt.renameThread' not found`

Likely cause:

- The extension manifest is patched, but the runtime patch has not been loaded yet.

Fix:

- Restart Extension Host or reload the VS Code window.
- Check `Output` -> `Codex Thread Renamer Patch`.

## Codex UI Breaks After Applying Patch

Likely cause:

- Webview helper issue (for example stale injected helper version).

Fix:

- Reapply the latest patcher version.
- Restart Extension Host / reload window.
- If needed, restore from backups:
  - `*.pre-codex-thread-renamer-patch-*.bak`

## Rename Persists But UI Does Not Update Immediately

Likely cause:

- Live webview provider capture failed or no active webview received the update.

Fix:

- Reopen the Codex sidebar.
- Switch to another thread and back.
- Check `Codex Thread Renamer Patch` output logs.

## Cancel Prompt Shows Error Toast

Current behavior:

- Canceling the prompt shows `Codex rename patch: Rename cancelled.`

Status:

- Known UX issue only (no functional failure)
- Tracked in repo issues / changelog
- Planned fix is to treat cancel as a silent no-op

## Useful Checks

Patch status:

```bash
node bin/codex-thread-renamer-patch.js status
```

Compatibility verification before patching:

```bash
node bin/codex-thread-renamer-patch.js verify
```

Target a specific OpenAI extension install:

```bash
node bin/codex-thread-renamer-patch.js verify --extension-dir ~/.vscode/extensions/openai.chatgpt-0.4.76-darwin-arm64
```
