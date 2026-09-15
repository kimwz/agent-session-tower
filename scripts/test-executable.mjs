import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'monitor-executable-check-'));
const binary = join(dir, process.platform === 'win32' ? 'agent-session-tower.exe' : 'agent-session-tower');
await copyFile(join(root, 'artifacts', binary.split('/').at(-1)), binary);
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
await mkdir(join(dir, 'state'));
await writeFile(join(dir, 'state', 'runs.json'), JSON.stringify([failedRun]));
const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const args = ['--no-open', '--port', String(port), '--state-dir', join(dir, 'state')];
const env = { ...process.env, PATH: '/usr/bin:/bin', CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude') };
let child;
let output = '';
let completion;
function start() {
  child = spawn(binary, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const force = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000);
  try { assert.equal(await completion, 0, output); } finally { clearTimeout(force); }
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
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await (await fetch(`${base}/api/snapshot`)).json();
    const session = snapshot.sessions.find(session => session.id === sessionId);
    if (session) return session;
    await setTimeout(100);
  }
  throw new Error('Executable did not discover title fixture.');
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
try {
  start();
  await ready();
  const config = JSON.parse(await readFile(join(root, 'dist/executable/sea-config.json'), 'utf8'));
  for (const [key, path] of Object.entries(config.assets)) {
    const response = await fetch(`${base}/${key.slice(4)}`);
    assert.equal(response.status, 200, key);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path), key);
  }
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/dist/client/index.html`)).status, 404);
  const firstToken = (await (await fetch(`${base}/api/bootstrap`)).json()).token;
  const original = await discovered();
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
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'state', 'runs.json'), 'utf8')), [failedRun], 'dismissal keeps raw execution history intact');
  assert.equal((await discovered()).customTitle, '실행파일 제목 저장 확인');
  assert.equal((await discovered()).closed, true, 'closed session stays closed after executable restart');
  const reopenResponse = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/reopen`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': secondToken }, body: '{}',
  });
  assert.equal(reopenResponse.status, 200);
  assert.equal((await discovered()).closed, undefined);
  const invalidCreate = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': secondToken },
    body: JSON.stringify({ provider: 'codex', cwd: join(dir, 'absent-work-folder'), prompt: 'Must not run' }),
  });
  assert.equal(invalidCreate.status, 400, 'standalone create route validates missing work folders');
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
  assert.equal((await fetch(`${base}/api/snapshot`)).status, 401);
  const passwordFile = join(dir, 'state', 'access-password');
  const password = (await readFile(passwordFile, 'utf8')).trim();
  assert.equal((await stat(passwordFile)).mode & 0o777, 0o600);
  const headers = { Authorization: `Basic ${Buffer.from(`monitor:${password}`).toString('base64')}` };
  assert.equal((await fetch(`${base}/api/snapshot`, { headers })).status, 200);
  const external = Object.values(networkInterfaces()).flat().find(address => address && address.family === 'IPv4' && !address.internal);
  if (external) {
    const url = `http://${external.address}:${port}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(`${url}/api/snapshot`, { headers })).status, 200);
  }
  await stop();
  start();
  await ready();
  assert.equal((await readFile(passwordFile, 'utf8')).trim(), password);
  assert.equal((await fetch(`${base}/api/snapshot`, { headers })).status, 200);
  console.log(`PASS: copied executable alone, minimal PATH, ${Object.keys(config.assets).length} embedded assets, duplicate launch, persistent private session titles and reset, persistent private project group titles/pins and reset without sessions, durable session close/reopen and creation validation, persistent failure dismissal with unchanged lifecycle and raw history, unchanged native history, shutdown/restart, authenticated public-interface binding and persistent 0600 password.`);
} finally {
  await stop();
  await rm(dir, { recursive: true, force: true });
}
