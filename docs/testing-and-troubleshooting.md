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
   - Command Palette -> `Rename Codex Thread` inside a thread starts inline rename for the current thread
   - Command Palette -> `Rename Codex Thread` outside a thread opens the thread picker
   - Right-click a thread title -> `Rename Thread in Codex Sidebar` in the original context menu
   - `Cmd+R` / `Ctrl+R` in the Codex sidebar or conversation editor
5. Confirm the original context menu remains available:
   - `Rename Thread in Codex Sidebar` and `New Thread in Codex Sidebar` appear when right-clicking outside a thread row
   - `Rename Thread in Codex Sidebar` appears directly above `New Thread in Codex Sidebar`
   - the existing Codex/OpenAI menu items are still present
6. Test persistence:
   - switch threads and back
   - restart extension host
   - reopen the VS Code window

## Common Problems

## Rename Fails With Active Writer

Error:

- `thread/resume failed: thread ... already has an active writer`

Likely cause:

- An older runtime payload resumes the target from a second app-server before
  renaming it, while Codex already owns that thread's writer.

Fix:

- Pull and reapply the latest patcher. The corrected runtime sends
  `thread/name/set` directly and does not resume the target thread.

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

## Verify Fails After OpenAI Extension Update

Likely cause:

- The installed OpenAI extension changed its bundled webview signatures.

Fix:

- Pull the latest patcher repo.
- Run `node bin/codex-thread-renamer-patch.js verify` again before applying.
- If verification still fails, update the verifier signatures before patching blindly.

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
