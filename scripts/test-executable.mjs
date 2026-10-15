import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'monitor-executable-check-'));
let child;
let output = '';
let completion;
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const force = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000);
  try { assert.equal(await completion, 0, output); } finally { clearTimeout(force); }
}
try {
  const binary = join(dir, process.platform === 'win32' ? 'agent-session-tower.exe' : 'agent-session-tower');
  await copyFile(join(root, 'artifacts', binary.split('/').at(-1)), binary);
  // An update helper from 1.125–1.137.x probes its target with `--storage-contract` (through the package's bin with
  // its own Node, the way a service installs it) and goes on only on this answer: a numeric non-zero exit within its
  // 60-second limit, not killed, `Unknown option: --storage-contract` on stderr, and `--version` answering the version.
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  for (const [file, prefix] of [[process.execPath, [join(root, 'bin', 'agent-session-tower.mjs')]], [binary, []]]) {
    const probe = await execFileAsync(file, [...prefix, '--storage-contract'], { cwd: dir, timeout: 60_000 }).then(() => assert.fail(`${file} accepted --storage-contract`), error => error);
    assert.ok(typeof probe.code === 'number' && probe.code !== 0 && !probe.killed && probe.signal === null, `${file}: ${probe.message}`);
    assert.match(String(probe.stderr), /Unknown option: --storage-contract/, file);
    assert.equal((await execFileAsync(file, [...prefix, '--version'], { cwd: dir, timeout: 60_000 })).stdout.trim(), version, file);
  }
  await mkdir(join(dir, 'codex'));
  await mkdir(join(dir, 'claude'));
  await mkdir(join(dir, 'codex', 'sessions'));
  const nativeId = '11111111-1111-4111-8111-111111111111';
  const sessionId = `codex:${nativeId}`;
  const nativeFile = join(dir, 'codex', 'sessions', `rollout-${nativeId}.jsonl`);
  const timestamp = new Date().toISOString();
  const nativeHistory = [
    { type: 'session_meta', timestamp, payload: { id: nativeId, cwd: dir, timestamp } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Standalone title fixture' }] } },
    { type: 'event_msg', timestamp, payload: { type: 'task_complete' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(nativeFile, nativeHistory);
  const failedRun = {
    id: 'standalone-dismiss-fixture', sessionId, prompt: 'Standalone failure dismissal fixture',
    status: 'error', createdAt: timestamp, finishedAt: timestamp, output: '', error: 'EXPECTED_TEST_FAILURE',
  };
  const stateDir = join(dir, 'state');
  await mkdir(stateDir, { mode: 0o700 });
  const dist = path => import(pathToFileURL(join(root, 'dist/server', path)).href);
  const storage = await dist('storage/index.js');
  const { initializeStorageDomains } = await dist('storage/initialize.js');
  const { RunsRepository } = await dist('runs/storage-repository.js');
  const bundle = await storage.captureStorageBundle();
  const context = storage.storageBuildContext(bundle);
  assert.equal(context.ok, true, 'actual compiled SDK must be trusted');
  const artifact = JSON.parse(await readFile(join(root, 'dist/server/storage/generated/thread-bundle.json'), 'utf8'));
  assert.equal(artifact.sourceHash, context.identity.sourceHash);
  // The compiled storage seeds an existing installation the way the worker leaves one: every domain authority, then one
  // failed run in the run history. It is closed before the executable starts, so only the executable writes afterwards.
  const seed = await storage.openStorage({ stateDir, bundle });
  try {
    assert.equal(seed.status().state, 'ready', JSON.stringify(seed.status()));
    await seed.prepare({ allowMigration: true });
    const domains = await initializeStorageDomains(seed, stateDir);
    assert.deepEqual(domains.map(domain => domain.result), domains.map(() => 'created'));
    await new RunsRepository(seed).restore({ runs: [failedRun], created: [], instructions: {} }, 'standalone-run-seed');
  } finally { await seed.close(); }
  /** The run history as stored, through a read-only connection beside the executable's worker (never a second writer). */
  function storedRuns() {
    const database = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(join(stateDir, 'state.sqlite'), { readOnly: true });
    try { return database.prepare("SELECT json FROM runs_rows WHERE kind = 'run' ORDER BY ordinal").all().map(row => JSON.parse(row.json)); }
    finally { database.close(); }
  }
  const portProbe = createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const args = ['--no-open', '--port', String(port), '--state-dir', stateDir];
  const env = { ...process.env, HOME: dir, SHELL: '/bin/sh', PATH: '/usr/bin:/bin', CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude') };
  function start() {
    child = spawn(binary, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
  }
  async function ready() {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const health = await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(300) })).json();
        if (health.application === 'agent-monitor' && health.pid === child.pid) return;
      } catch { /* Wait for this exact process to bind. */ }
      await setTimeout(100);
    }
    throw new Error(`Executable did not become ready: ${output}`);
  }
  async function discovered() {
    let last;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${base}/api/snapshot`);
      const snapshot = await response.json();
      last = { status: response.status, error: snapshot.error, storage: snapshot.storage };
      const session = response.status === 200 && Array.isArray(snapshot.sessions)
        ? snapshot.sessions.find(session => session.id === sessionId) : undefined;
      if (session) return session;
      await setTimeout(100);
    }
    throw new Error(`Executable did not discover title fixture: ${JSON.stringify(last)}; ${output}`);
  }
  async function setTitle(title, token) {
    const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/title`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token },
      body: JSON.stringify({ title }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).session;
  }
  async function setGroup(patch, token) {
    const response = await fetch(`${base}/api/groups`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token },
      body: JSON.stringify(patch),
    });
    assert.equal(response.status, 200);
    return (await response.json()).group;
  }
  /** The executable's worker storage as its health reports it, once that worker has opened it. */
  async function workerStorage() {
    let last;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      last = (await (await fetch(`${base}/api/health`)).json()).storage;
      if (last?.state === 'ready') return last;
      await setTimeout(100);
    }
    throw new Error(`Executable storage did not become ready: ${JSON.stringify(last)}; ${output}`);
  }
  start();
  await ready();
  // The copied executable's own worker runs the storage this checkout compiled, not merely a compatible one.
  assert.deepEqual((await workerStorage()).identity, context.identity, 'the executable worker\'s storage identity is the compiled SDK\'s');
  const config = JSON.parse(await readFile(join(root, 'dist/executable/sea-config.json'), 'utf8'));
  for (const [key, path] of Object.entries(config.assets)) {
    if (!key.startsWith('web/')) continue;
    const response = await fetch(`${base}/${key.slice(4)}`);
    assert.equal(response.status, 200, key);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path), key);
  }
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/dist/client/index.html`)).status, 404);
  const firstToken = (await (await fetch(`${base}/api/bootstrap`)).json()).token;
  const original = await discovered();
  // Exercise the extracted native binding from the copied executable, with an
  // isolated shell and no provider calls or personal shell configuration.
  const workspaceHeaders = { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': firstToken };
  const createdTerminal = await fetch(`${base}/api/workspace/terminals`, {
    method: 'POST', headers: workspaceHeaders, body: JSON.stringify({ cwd: dir, cols: 83, rows: 29 }),
  });
  assert.equal(createdTerminal.status, 200, await createdTerminal.clone().text());
  const { id: terminalId } = await createdTerminal.json();
  const eventsAbort = new AbortController();
  const events = await fetch(`${base}/api/workspace/terminals/${terminalId}/events`, { signal: eventsAbort.signal });
  const terminalInput = await fetch(`${base}/api/workspace/terminals/${terminalId}/input`, {
    method: 'POST', headers: workspaceHeaders, body: JSON.stringify({ data: 'printf "TOWER_PTY_%s\\n" OK; stty size; exit\r' }),
  });
  assert.equal(terminalInput.status, 200);
  const reader = events.body.getReader();
  let terminalOutput = '';
  const terminalTimeout = globalThis.setTimeout(() => eventsAbort.abort(), 10_000);
  try {
    while (!terminalOutput.includes('event: exit')) {
      const { value, done } = await reader.read();
      if (done) break;
      terminalOutput += new TextDecoder().decode(value);
    }
  } finally { clearTimeout(terminalTimeout); eventsAbort.abort(); }
  assert.match(terminalOutput, /TOWER_PTY_OK/);
  assert.match(terminalOutput, /29 83/);
  await fetch(`${base}/api/workspace/terminals/${terminalId}/close`, { method: 'POST', headers: workspaceHeaders, body: '{}' });
  assert.deepEqual((await (await fetch(`${base}/api/snapshot`)).json()).groups, []);
  await Promise.all([setGroup({ cwd: dir, title: '  실행파일 그룹 제목  ' }, firstToken), setGroup({ cwd: dir, pinned: true }, firstToken)]);
  const emptyGroupCwd = `${dir}/project-with-no-sessions`;
  await setGroup({ cwd: emptyGroupCwd, pinned: true }, firstToken);
  const savedGroups = (await (await fetch(`${base}/api/snapshot`)).json()).groups;
  assert.deepEqual(savedGroups.find(group => group.cwd === dir), { cwd: dir, title: '실행파일 그룹 제목', pinned: true });
  assert.deepEqual(savedGroups.find(group => group.cwd === emptyGroupCwd), { cwd: emptyGroupCwd, title: '', pinned: true });
  assert.equal((await stat(join(dir, 'state', 'project-groups.json'))).mode & 0o777, 0o600);
  const closeResponse = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/close`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': firstToken }, body: '{}',
  });
  assert.equal(closeResponse.status, 200);
  assert.equal((await discovered()).closed, true);
  assert.equal((await stat(join(dir, 'state', 'closed-sessions.json'))).mode & 0o777, 0o600);
  assert.equal((await (await fetch(`${base}/api/snapshot`)).json()).runs[0].id, failedRun.id);
  const dismissResponse = await fetch(`${base}/api/runs/${failedRun.id}/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': firstToken }, body: '{}',
  });
  assert.equal(dismissResponse.status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/snapshot`)).json()).runs, []);
  assert.equal((await stat(join(dir, 'state', 'dismissed-runs.json'))).mode & 0o777, 0o600);
  const afterDismiss = await discovered();
  for (const key of ['status', 'lastRequestAt', 'lastCompletedAt', 'updatedAt']) assert.equal(afterDismiss[key], original[key], `dismissal preserves ${key}`);
  const renamed = await setTitle('  실행파일 제목 저장 확인  ', firstToken);
  assert.equal(renamed.customTitle, '실행파일 제목 저장 확인');
  assert.equal(renamed.title, original.title);
  assert.equal(renamed.updatedAt, original.updatedAt);
  assert.equal(renamed.filePath, undefined);
  assert.equal((await stat(join(dir, 'state', 'session-titles.json'))).mode & 0o777, 0o600);
  const duplicate = spawn(binary, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let duplicateOutput = '';
  duplicate.stdout.on('data', chunk => { duplicateOutput += chunk; });
  duplicate.stderr.on('data', chunk => { duplicateOutput += chunk; });
  assert.equal(await new Promise((resolve, reject) => { duplicate.once('error', reject); duplicate.once('close', resolve); }), 0, duplicateOutput);
  assert.match(duplicateOutput, /already running/);
  await stop();
  start();
  await ready();
  const secondToken = (await (await fetch(`${base}/api/bootstrap`)).json()).token;
  assert.notEqual(secondToken, firstToken);
  assert.deepEqual((await (await fetch(`${base}/api/snapshot`)).json()).groups, savedGroups, 'group titles and pins survive executable restart without sessions');
  assert.deepEqual(await setGroup({ cwd: dir, title: '' }, secondToken), { cwd: dir, title: '', pinned: true });
  await setGroup({ cwd: dir, pinned: false }, secondToken);
  await setGroup({ cwd: emptyGroupCwd, pinned: false }, secondToken);
  assert.deepEqual((await (await fetch(`${base}/api/snapshot`)).json()).groups, []);
  assert.deepEqual((await (await fetch(`${base}/api/snapshot`)).json()).runs, [], 'dismissal survives executable restart');
  assert.deepEqual(storedRuns(), [failedRun], 'dismissal keeps raw execution history intact');
  assert.equal((await discovered()).customTitle, '실행파일 제목 저장 확인');
  assert.equal((await discovered()).closed, true, 'closed session stays closed after executable restart');
  const reopenResponse = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/reopen`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': secondToken }, body: '{}',
  });
  assert.equal(reopenResponse.status, 200);
  assert.equal((await discovered()).closed, undefined);
  const invalidCreate = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': secondToken },
    body: JSON.stringify({ provider: 'codex', cwd: 'relative-work-folder', prompt: 'Must not run' }),
  });
  assert.equal(invalidCreate.status, 400, 'standalone create route rejects a work folder that is not an absolute path');
  const detail = await (await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`)).json();
  assert.equal(detail.session.customTitle, '실행파일 제목 저장 확인');
  assert.equal((await setTitle('', secondToken)).customTitle, undefined);
  await stop();
  start();
  await ready();
  assert.equal((await discovered()).customTitle, undefined);
  assert.equal((await discovered()).closed, undefined, 'reopening survives executable restart');
  assert.deepEqual((await (await fetch(`${base}/api/snapshot`)).json()).groups, [], 'reset group metadata stays removed after executable restart');
  assert.equal(await readFile(nativeFile, 'utf8'), nativeHistory, 'renaming never changes native history');
  await stop();
  args.push('--host', '0.0.0.0');
  start();
  await ready();
  const remoteHealth = await (await fetch(`${base}/api/health`)).json();
  assert.equal(remoteHealth.bindHost, '0.0.0.0');
  assert.equal(remoteHealth.remoteAccess, true);
  assert.equal((await fetch(`${base}/api/snapshot`)).status, 200, 'direct loopback bypasses login');
  const { token: authToken } = await (await fetch(`${base}/api/auth/status`)).json();
  const credentials = { username: 'monitor', password: 'executable-fixture-password' };
  assert.equal((await fetch(`${base}/api/auth/credentials`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': authToken }, body: JSON.stringify(credentials),
  })).status, 200);
  const authFile = join(dir, 'state', 'auth.json');
  const savedAuth = await readFile(authFile, 'utf8');
  assert.equal((await stat(authFile)).mode & 0o777, 0o600);
  assert.ok(!savedAuth.includes(credentials.password), 'only a password hash is persisted');
  const external = Object.values(networkInterfaces()).flat().find(address => address && address.family === 'IPv4' && !address.internal);
  // Forwarded requests must never inherit the direct-loopback login bypass.
  const remoteHeaders = { ...(external ? { Host: `${external.address}:${port}` } : {}), 'X-Forwarded-For': '192.0.2.1' };
  async function loginRemote(url = base, requestHeaders = remoteHeaders) {
    const { token } = await (await fetch(`${url}/api/auth/status`, { headers: requestHeaders })).json();
    const response = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { ...requestHeaders, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token }, body: JSON.stringify(credentials),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('tower_session='));
    return { ...requestHeaders, Cookie: cookie };
  }
  assert.equal((await fetch(`${base}/api/snapshot`, { headers: remoteHeaders })).status, 401);
  const headers = await loginRemote();
  assert.equal((await fetch(`${base}/api/snapshot`, { headers })).status, 200);
  if (external) {
    const url = `http://${external.address}:${port}`;
    assert.equal((await fetch(`${url}/api/snapshot`)).status, 401);
    const externalHeaders = await loginRemote(url, {});
    assert.equal((await fetch(`${url}/api/snapshot`, { headers: externalHeaders })).status, 200);
  }
  await stop();
  start();
  await ready();
  assert.equal(await readFile(authFile, 'utf8'), savedAuth);
  // Sign-ins are kept across restarts (auth-sessions.json) until they expire, log out or the password changes.
  assert.equal((await fetch(`${base}/api/snapshot`, { headers })).status, 200, 'a remote sign-in survives a restart');
  assert.equal((await fetch(`${base}/api/snapshot`, { headers: remoteHeaders })).status, 401, 'a restart signs no one in without a sign-in cookie');
  const { token: pageToken } = await (await fetch(`${base}/api/auth/status`, { headers })).json();
  assert.equal((await fetch(`${base}/api/auth/logout`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': pageToken }, body: '{}',
  })).status, 200);
  assert.equal((await fetch(`${base}/api/snapshot`, { headers })).status, 401, 'logging out revokes the sign-in');
  await stop();
  start();
  await ready();
  assert.equal((await fetch(`${base}/api/snapshot`, { headers })).status, 401, 'a revoked sign-in stays revoked after a restart');
  const renewedHeaders = await loginRemote();
  assert.equal((await fetch(`${base}/api/snapshot`, { headers: renewedHeaders })).status, 200);
  console.log(`PASS: copied executable alone, the 1.137.x update helper's --storage-contract answer (bin and executable), minimal PATH, ${Object.keys(config.assets).length} embedded assets, duplicate launch, persistent private session titles and reset, persistent private project group titles/pins and reset without sessions, durable session close/reopen and creation validation, persistent failure dismissal with unchanged lifecycle and raw history, unchanged native history, shutdown/restart, authenticated public-interface binding and persistent 0600 password hash, local bypass, remote sign-in kept across restart, revoked by logout and still revoked after restart, and a new sign-in.`);
} finally {
  try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); }
}
