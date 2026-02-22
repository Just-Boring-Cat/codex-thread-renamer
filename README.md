<p align="center">
  <img src="images/openAI_Logo.png" alt="OpenAI logo" width="72" />
</p>

<h1 align="center">Codex Thread Renamer</h1>

<p align="center"><strong>Thread renamer for OpenAI ChatGPT/Codex VS Code extension</strong></p>

<p align="center">
  <img alt="GitHub release" src="https://img.shields.io/github/v/release/Just-Boring-Cat/codex-thread-renamer?label=release" />
  <img alt="License" src="https://img.shields.io/github/license/Just-Boring-Cat/codex-thread-renamer" />
  <img alt="Last commit" src="https://img.shields.io/github/last-commit/Just-Boring-Cat/codex-thread-renamer" />
  <img alt="Repo size" src="https://img.shields.io/github/repo-size/Just-Boring-Cat/codex-thread-renamer" />
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-patcher-blue" />
</p>

Patch the installed VS Code `openai.chatgpt` extension so you can rename Codex threads from the UI.

## Prerequisites

Install these before using the patcher:

- VS Code
- OpenAI ChatGPT/Codex VS Code extension (`openai.chatgpt`) installed
- Node.js (used to run the patcher CLI)
- `sqlite3` CLI available in `PATH` (used by the runtime patch for cache fallback patching)

Recommended:

- `git` (for updating/reapplying the patcher repo)

## Important

This project **modifies the installed OpenAI ChatGPT/Codex VS Code extension files on your machine**.

- It patches the extension manifest/runtime/webview loader.
- It adds injected patch files used by the rename feature.
- It creates timestamped backups before writing changes.

Use `verify` before `apply`, and reapply after updating the OpenAI extension.

## Visual Preview

### Right-click rename action in Codex thread list

![Rename thread context menu](images/rename-thread.png)

### Choose thread to rename (Command Palette flow)

![Choose thread to rename](images/choose-thread-to-rename.png)

## What It Adds

- `Rename Codex Thread` command in the Command Palette
- Right-click `Rename Thread` action in the Codex thread list
- Live title updates in the open Codex UI
- Persistent rename via Codex backend rename RPC
- Cache patching fallback so stale titles do not come back

## Quick Start

```bash
node bin/codex-thread-renamer-patch.js status
node bin/codex-thread-renamer-patch.js verify
node bin/codex-thread-renamer-patch.js apply
```

Then restart the VS Code window or run `Developer: Restart Extension Host`.

## Usage

After patching and reloading VS Code:

1. Open the Codex sidebar.
2. Rename a thread using either:
   - Command Palette -> `Rename Codex Thread`
   - Right-click a thread title -> `Rename Thread`

## Commands

- `status` - Check whether the installed extension appears patched
- `verify` - Validate extension signatures before patching
- `apply` - Apply the patch and write backups

Optional flags:

- `--extension-dir <path>` - Target a specific `openai.chatgpt-*` install folder
- `--dry-run` - Show what would change without writing files

## Docs

- [Technical internals](docs/how-it-works.md)
- [Testing and troubleshooting](docs/testing-and-troubleshooting.md)
- [Release history](CHANGELOG.md)

## Known Issue

- Canceling the rename prompt currently shows:
  - `Codex rename patch: Rename cancelled.`
- This is a UX issue only.
- Tracked in:
  - [Issue #1](https://github.com/Just-Boring-Cat/codex-thread-renamer/issues/1)
  - [CHANGELOG.md](CHANGELOG.md)

## Contributing

Contributions are welcome.

- You can fork the repo and open a pull request.
- You can also contribute directly with a branch and pull request if you have access.
- Please do not push directly to `main`, the repo uses PR-first protection.
- If you are not sure where to start, open an issue or pick an existing one:
  - [Issues](https://github.com/Just-Boring-Cat/codex-thread-renamer/issues)

## License

[LICENSE](LICENSE)
