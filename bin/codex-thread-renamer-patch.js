#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PATCH_ID = 'codex-thread-renamer-patch';
const RUNTIME_FILE = 'codex-thread-renamer.patch.runtime.js';
const WEBVIEW_FILE = 'codex-thread-renamer.patch.webview.js';
const EXTENSION_JS_MARKER = 'CODEX_THREAD_RENAMER_PATCH_RUNTIME_START';
const INDEX_HTML_MARKER = 'CODEX_THREAD_RENAMER_PATCH_WEBVIEW_SCRIPT';

const ROOT = path.resolve(__dirname, '..');
const PATCHES_DIR = path.join(ROOT, 'patches');

function main() {
  const { cmd, options } = parseArgs(process.argv.slice(2));
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) {
    printHelp();
    process.exit(0);
  }

  const extDir = options.extensionDir || findLatestOpenAiChatGptExtensionDir();
  if (!extDir) {
    fail('Could not find installed openai.chatgpt extension directory.');
  }

  const target = buildTarget(extDir);

  if (cmd === 'status') {
    const status = inspectStatus(target);
    printStatus(status);
    process.exit(status.ok ? 0 : 1);
  }

  if (cmd === 'verify') {
    const verify = verifyTarget(target);
    printVerify(verify);
    process.exit(verify.ok ? 0 : 1);
  }

  if (cmd === 'apply') {
    const verify = verifyTarget(target);
    printVerify(verify);
    if (!verify.ok) {
      fail('Verification failed. Refusing to patch this extension build.');
    }
    const changes = applyPatch(target, options);
    for (const line of changes.logs) console.log(line);
    const post = inspectStatus(target);
    printStatus(post);
    process.exit(post.ok ? 0 : 1);
  }

  fail(`Unknown command: ${cmd}`);
}

function parseArgs(argv) {
  const out = { cmd: null, options: { dryRun: false, extensionDir: null } };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!out.cmd && !arg.startsWith('-')) {
      out.cmd = arg;
      continue;
    }
    if (arg === '--dry-run') {
      out.options.dryRun = true;
      continue;
    }
    if (arg === '--extension-dir') {
      out.options.extensionDir = argv[++i];
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      out.cmd = 'help';
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node bin/codex-thread-renamer-patch.js <command> [options]\n\nCommands:\n  status   Show patch status for installed openai.chatgpt extension\n  verify   Verify extension signatures and patch compatibility\n  apply    Apply patch (creates backups first)\n\nOptions:\n  --extension-dir <path>  Patch a specific openai.chatgpt-* extension directory\n  --dry-run               Show changes without writing files`);
}

function buildTarget(extensionDir) {
  const extDir = path.resolve(extensionDir);
  const packageJson = path.join(extDir, 'package.json');
  const extensionJs = path.join(extDir, 'out', 'extension.js');
  const webviewIndexHtml = path.join(extDir, 'webview', 'index.html');
  const webviewAssetsDir = path.join(extDir, 'webview', 'assets');
  const runtimeOutFile = path.join(extDir, 'out', RUNTIME_FILE);
  const webviewOutFile = path.join(webviewAssetsDir, WEBVIEW_FILE);
  const bundleFile = findWebviewBundleFile(webviewAssetsDir);
  return {
    extDir,
    packageJson,
    extensionJs,
    webviewIndexHtml,
    webviewAssetsDir,
    runtimeOutFile,
    webviewOutFile,
    bundleFile,
    runtimePatchSource: path.join(PATCHES_DIR, RUNTIME_FILE),
    webviewPatchSource: path.join(PATCHES_DIR, WEBVIEW_FILE),
  };
}

function findLatestOpenAiChatGptExtensionDir() {
  const base = path.join(os.homedir(), '.vscode', 'extensions');
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('openai.chatgpt-'))
    .map((d) => path.join(base, d.name));
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0];
}

function findWebviewBundleFile(assetsDir) {
  if (!fs.existsSync(assetsDir)) return null;
  const name = fs.readdirSync(assetsDir).find((n) => /^index-.*\.js$/.test(n));
  return name ? path.join(assetsDir, name) : null;
}

function verifyTarget(target) {
  const checks = [];
  const mustExist = [
    ['package.json', target.packageJson],
    ['out/extension.js', target.extensionJs],
    ['webview/index.html', target.webviewIndexHtml],
    ['webview bundle', target.bundleFile],
    ['runtime patch source', target.runtimePatchSource],
    ['webview patch source', target.webviewPatchSource],
  ];
  for (const [label, file] of mustExist) {
    checks.push(result(label, !!file && fs.existsSync(file), file || 'missing'));
  }
  if (checks.some((c) => !c.ok)) {
    return { ok: false, target, checks };
  }

  const extensionJs = fs.readFileSync(target.extensionJs, 'utf8');
  const bundle = fs.readFileSync(target.bundleFile, 'utf8');
  const indexHtml = fs.readFileSync(target.webviewIndexHtml, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(target.packageJson, 'utf8'));

  checks.push(result('Signature: extension handles open-vscode-command', extensionJs.includes('case"open-vscode-command"') || extensionJs.includes('case"open-vscode-command":'), 'required for webview -> command bridge'));
  checks.push(result('Signature: extension registers webview provider', extensionJs.includes('registerWebviewViewProvider('), 'required for capturing provider'));
  checks.push(result('Signature: webview supports thread-title-updated', bundle.includes('thread-title-updated'), 'required for live UI title update'));
  checks.push(result('Signature: webview thread rows expose data-thread-title', bundle.includes('data-thread-title'), 'required for right-click rename hook'));
  checks.push(result('Signature: webview index loads module bundle', /<script\s+type="module"[^>]*src="\.\/assets\/index-.*\.js"/.test(indexHtml), 'required to inject helper script'));
  checks.push(result('Package contributes.commands exists', Array.isArray(pkg?.contributes?.commands), 'required for adding command'));

  return { ok: checks.every((c) => c.ok), target, checks };
}

function inspectStatus(target) {
  const checks = [];
  const okFiles = [target.packageJson, target.extensionJs, target.webviewIndexHtml];
  for (const file of okFiles) {
    checks.push(result(`Exists: ${path.relative(target.extDir, file)}`, fs.existsSync(file), file));
  }
  let pkg = null;
  if (fs.existsSync(target.packageJson)) {
    try { pkg = JSON.parse(fs.readFileSync(target.packageJson, 'utf8')); } catch {}
  }
  const commandPresent = !!pkg?.contributes?.commands?.some?.((c) => c.command === 'chatgpt.renameThread');
  const webviewMenuPresent = !!pkg?.contributes?.menus?.['webview/context']?.some?.((m) => m.command === 'chatgpt.renameThread');
  checks.push(result('Package command chatgpt.renameThread', commandPresent, 'package.json'));
  checks.push(result('Package webview/context menu entry', webviewMenuPresent, 'package.json'));
  if (fs.existsSync(target.extensionJs)) {
    const s = fs.readFileSync(target.extensionJs, 'utf8');
    checks.push(result('extension.js runtime loader marker', s.includes(EXTENSION_JS_MARKER), 'out/extension.js'));
  }
  if (fs.existsSync(target.webviewIndexHtml)) {
    const s = fs.readFileSync(target.webviewIndexHtml, 'utf8');
    checks.push(result('webview/index.html helper script marker', s.includes(INDEX_HTML_MARKER), 'webview/index.html'));
  }
  checks.push(result(`Injected file out/${RUNTIME_FILE}`, fs.existsSync(target.runtimeOutFile), target.runtimeOutFile));
  checks.push(result(`Injected file webview/assets/${WEBVIEW_FILE}`, fs.existsSync(target.webviewOutFile), target.webviewOutFile));

  return { ok: checks.every((c) => c.ok), target, checks };
}

function applyPatch(target, options) {
  const dryRun = !!options.dryRun;
  const logs = [];
  logs.push(`[${PATCH_ID}] target: ${target.extDir}`);
  if (dryRun) logs.push(`[${PATCH_ID}] dry-run mode enabled`);

  ensureDir(path.dirname(target.runtimeOutFile), dryRun, logs);
  ensureDir(path.dirname(target.webviewOutFile), dryRun, logs);

  patchPackageJson(target.packageJson, dryRun, logs);
  patchExtensionJs(target.extensionJs, dryRun, logs);
  patchWebviewIndexHtml(target.webviewIndexHtml, dryRun, logs);
  copyInjectedFile(target.runtimePatchSource, target.runtimeOutFile, dryRun, logs);
  copyInjectedFile(target.webviewPatchSource, target.webviewOutFile, dryRun, logs);

  return { logs };
}

function patchPackageJson(file, dryRun, logs) {
  const raw = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.contributes = pkg.contributes || {};
  pkg.contributes.commands = Array.isArray(pkg.contributes.commands) ? pkg.contributes.commands : [];
  pkg.contributes.menus = pkg.contributes.menus || {};

  upsertCommand(pkg.contributes.commands, {
    command: 'chatgpt.renameThread',
    title: 'Rename Codex Thread',
    category: 'Codex',
  });

  const commandPalette = ensureLiteralMenuArray(pkg.contributes.menus, 'commandPalette');
  if (!commandPalette.some((m) => m.command === 'chatgpt.renameThread')) {
    commandPalette.push({ command: 'chatgpt.renameThread' });
  }

  cleanupLegacyNestedWebviewMenuShape(pkg.contributes.menus);
  const webviewContext = ensureLiteralMenuArray(pkg.contributes.menus, 'webview/context');
  if (!webviewContext.some((m) => m.command === 'chatgpt.renameThread')) {
    webviewContext.push({
      command: 'chatgpt.renameThread',
      when: "webviewId == 'chatgpt.sidebarView'",
      group: 'navigation@99',
    });
  }

  const updated = JSON.stringify(pkg, null, 2) + '\n';
  writeIfChanged(file, raw, updated, dryRun, logs);
}

function ensureLiteralMenuArray(menus, key) {
  if (!Array.isArray(menus[key])) menus[key] = [];
  return menus[key];
}

function cleanupLegacyNestedWebviewMenuShape(menus) {
  if (!menus || typeof menus !== 'object' || Array.isArray(menus)) return;
  const webview = menus.webview;
  if (!webview || typeof webview !== 'object' || Array.isArray(webview)) return;
  if (!Array.isArray(webview.context)) return;
  const onlyRenameEntries = webview.context.every((m) => m && m.command === 'chatgpt.renameThread');
  if (onlyRenameEntries) {
    delete menus.webview;
  }
}

function upsertCommand(commands, command) {
  const idx = commands.findIndex((c) => c && c.command === command.command);
  if (idx >= 0) {
    commands[idx] = { ...commands[idx], ...command };
  } else {
    commands.push(command);
  }
}

function patchExtensionJs(file, dryRun, logs) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes(EXTENSION_JS_MARKER)) {
    logs.push(`[${PATCH_ID}] extension.js already patched`);
    return;
  }
  const injected = `${raw}\n/* ${EXTENSION_JS_MARKER} */\n;(()=>{try{require('./${RUNTIME_FILE}').installRuntimePatch();}catch(e){try{console.error('[${PATCH_ID}] runtime patch load failed',e);}catch{}}})();\n/* CODEX_THREAD_RENAMER_PATCH_RUNTIME_END */\n`;
  writeIfChanged(file, raw, injected, dryRun, logs);
}

function patchWebviewIndexHtml(file, dryRun, logs) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes(INDEX_HTML_MARKER) || raw.includes(WEBVIEW_FILE)) {
    logs.push(`[${PATCH_ID}] webview/index.html already patched`);
    return;
  }

  const scriptTag = `    <script src="./assets/${WEBVIEW_FILE}"></script> <!-- ${INDEX_HTML_MARKER} -->`;
  let updated = raw;
  const moduleScriptMatch = raw.match(/<script\s+type="module"[^>]*src="\.\/assets\/index-.*\.js"[^>]*><\/script>/);
  if (!moduleScriptMatch) {
    throw new Error('Could not find module bundle script tag in webview/index.html');
  }
  updated = raw.replace(moduleScriptMatch[0], `${moduleScriptMatch[0]}\n${scriptTag}`);
  writeIfChanged(file, raw, updated, dryRun, logs);
}

function copyInjectedFile(src, dst, dryRun, logs) {
  const next = fs.readFileSync(src, 'utf8');
  const prev = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
  if (prev === next) {
    logs.push(`[${PATCH_ID}] no change ${path.basename(dst)}`);
    return;
  }
  if (!dryRun) {
    backupFileIfExists(dst, logs);
    fs.writeFileSync(dst, next, 'utf8');
  }
  logs.push(`[${PATCH_ID}] ${dryRun ? 'would write' : 'wrote'} ${dst}`);
}

function writeIfChanged(file, prev, next, dryRun, logs) {
  if (prev === next) {
    logs.push(`[${PATCH_ID}] no change ${file}`);
    return;
  }
  if (!dryRun) {
    backupFileIfExists(file, logs);
    fs.writeFileSync(file, next, 'utf8');
  }
  logs.push(`[${PATCH_ID}] ${dryRun ? 'would patch' : 'patched'} ${file}`);
}

function backupFileIfExists(file, logs) {
  if (!fs.existsSync(file)) return;
  const backup = `${file}.pre-${PATCH_ID}-${stamp()}.bak`;
  fs.copyFileSync(file, backup);
  logs.push(`[${PATCH_ID}] backup ${backup}`);
}

function ensureDir(dir, dryRun, logs) {
  if (fs.existsSync(dir)) return;
  if (!dryRun) fs.mkdirSync(dir, { recursive: true });
  logs.push(`[${PATCH_ID}] ${dryRun ? 'would create' : 'created'} dir ${dir}`);
}

function result(name, ok, detail) {
  return { name, ok: !!ok, detail };
}

function printVerify(v) {
  console.log(`Target: ${v.target.extDir}`);
  console.log('Verify:');
  for (const c of v.checks) {
    console.log(`- [${c.ok ? 'OK' : 'FAIL'}] ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  }
}

function printStatus(s) {
  console.log(`Target: ${s.target.extDir}`);
  console.log('Status:');
  for (const c of s.checks) {
    console.log(`- [${c.ok ? 'OK' : 'FAIL'}] ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

main();
