'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const RUNTIME_PATH = path.resolve(
  __dirname,
  '../patches/codex-thread-renamer.patch.runtime.js'
);

function loadRpcClient() {
  const source = `${fs.readFileSync(RUNTIME_PATH, 'utf8')}\nmodule.exports.__RpcClient = RpcClient;\n`;
  const runtimeModule = new Module(RUNTIME_PATH, module);
  runtimeModule.filename = RUNTIME_PATH;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(RUNTIME_PATH));
  runtimeModule._compile(source, RUNTIME_PATH);
  return runtimeModule.exports.__RpcClient;
}

test('rename sends thread/name/set without resuming an actively owned thread', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-renamer-test-'));
  const fakeCodexPath = path.join(tempDir, 'codex');
  const requestLogPath = path.join(tempDir, 'requests.jsonl');
  const previousLogPath = process.env.CODEX_RENAMER_TEST_LOG;

  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.CODEX_RENAMER_TEST_LOG, JSON.stringify(request) + '\\n');
  const response = request.method === 'thread/resume'
    ? { id: request.id, error: { code: -32600, message: 'thread already has an active writer' } }
    : { id: request.id, result: {} };
  process.stdout.write(JSON.stringify(response) + '\\n');
});
`,
    { mode: 0o755 }
  );

  process.env.CODEX_RENAMER_TEST_LOG = requestLogPath;
  const RpcClient = loadRpcClient();
  const client = new RpcClient(fakeCodexPath, { appendLine() {} });
  let requests;

  try {
    await client.renameThread('thread-active-writer', 'Renamed thread');
    requests = fs
      .readFileSync(requestLogPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  } finally {
    await client.dispose();
    if (previousLogPath === undefined) {
      delete process.env.CODEX_RENAMER_TEST_LOG;
    } else {
      process.env.CODEX_RENAMER_TEST_LOG = previousLogPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.deepEqual(
    requests.map((request) => request.method),
    ['initialize', 'thread/name/set']
  );
});
