import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderServicePlist, runtimePaths, serviceLabel, currentVersion, useVersion, installVersion } from '../../../server/link/service.js';
import { runLinkCommand } from '../../../server/link/cli.js';
import { encodeJoinCode } from '../../../server/link/join-code.js';
import { linkId } from '../../../server/link/identity.js';
import { defaultStateDir } from '../../../server/state-dir.js';
import { HEALTH_APPLICATION_ID } from '../../../shared/app-identity.js';

test('the background service runs the current installed version with this state folder and the user’s tools', () => {
  const stateDir = '/Users/someone/.agent-session-tower & <test>';
  const plist = renderServicePlist(stateDir, { port: 8123, node: '/opt/homebrew/bin/node',
    environment: { PATH: '/Users/someone/project/node_modules/.bin:/Users/someone/.npm/_npx/abc/node_modules/.bin:/opt/node/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/someone', CODEX_HOME: '/Users/someone/.codex', SECRET_TOKEN: 'never' } });
  assert.match(plist, new RegExp(`<key>Label</key><string>${serviceLabel(stateDir).replace(/\./g, '\\.')}</string>`));
  const args = [...plist.matchAll(/^ {4}<string>(.*)<\/string>$/gm)].map(match => match[1]);
  assert.deepEqual(args, ['/opt/homebrew/bin/node', `${join(runtimePaths(stateDir).current, 'node_modules', 'agent-session-tower', 'bin', 'agent-session-tower.mjs').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}`,
    'run', '--no-open', '--port', '8123', '--state-dir', '/Users/someone/.agent-session-tower &amp; &lt;test&gt;']);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/, 'npx and project tool folders are not kept for the service');
  assert.match(plist, /<key>CODEX_HOME<\/key>/);
  assert.doesNotMatch(plist, /SECRET_TOKEN|never/, 'only the variables Tower needs are copied into the service');
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(plist, /<key>StandardOutPath<\/key><string>[^<]*\/logs\/tower\.log<\/string>/);
});

test('each state folder has its own service; the default one keeps the plain name', () => {
  assert.equal(serviceLabel(defaultStateDir()), 'io.github.kimwz.agent-session-tower');
  assert.match(serviceLabel('/tmp/a'), /^io\.github\.kimwz\.agent-session-tower\.[0-9a-f]{8}$/);
  assert.notEqual(serviceLabel('/tmp/a'), serviceLabel('/tmp/b'));
});

test('the installed version is switched in one step and read back', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-service-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  assert.equal(await currentVersion(stateDir), undefined);
  await assert.rejects(installVersion(stateDir, 'latest'), /Not a released version/);
  await mkdir(runtimePaths(stateDir).versions, { recursive: true });
  await useVersion(stateDir, '1.23.0');
  assert.equal(await currentVersion(stateDir), '1.23.0');
  assert.equal(await readlink(runtimePaths(stateDir).current), join('versions', '1.23.0'));
  await useVersion(stateDir, '1.24.0');
  assert.equal(await currentVersion(stateDir), '1.24.0');
  await useVersion(stateDir, '1.22.0');
  assert.equal(await currentVersion(stateDir), '1.24.0', 'an older code never takes the service back');
});

test('join refuses bad arguments and expired codes before touching this computer', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-join-cli-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const code = (expiresAt: number) => encodeJoinCode({ v: 1, name: 'computer-a', pin: Buffer.alloc(32, 1).toString('base64url'), addresses: ['ws://127.0.0.1:9/tower-link'],
    inviteId: '00000000-0000-4000-8000-000000000000', secret: Buffer.alloc(32, 2).toString('base64url'), expiresAt, version: '1.23.0' });
  await assert.rejects(runLinkCommand(['join', '--state-dir', stateDir]), /Usage:/);
  await assert.rejects(runLinkCommand(['join', 'a', 'b', '--state-dir', stateDir]), /Usage:/);
  await assert.rejects(runLinkCommand(['join', code(Date.now() + 60_000), '--state-dir', stateDir, '--port', '99999']), /Port must be/);
  await assert.rejects(runLinkCommand(['join', code(Date.now() + 60_000), '--state-dir', stateDir, '--force']), /Unknown option: --force/);
  await assert.rejects(runLinkCommand(['join', 'tower-link:nope', '--state-dir', stateDir]), /연결 코드가 아닙니다/);
  await assert.rejects(runLinkCommand(['join', code(Date.now() - 1), '--state-dir', stateDir]), /expired/);
  // Nothing runs here and the service is not wanted: say how to continue instead of installing anything.
  await assert.rejects(runLinkCommand(['join', code(Date.now() + 60_000), '--state-dir', stateDir, '--no-service']), /Tower is not running here/);
  assert.equal(await currentVersion(stateDir), undefined);
  await assert.rejects(runLinkCommand(['service', 'restart', '--state-dir', stateDir]), /Usage:/);
});

test('join talks only to the Tower that holds this state folder, and says so when that Tower is too old', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-join-owner-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let pid = 999_999;
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/api/health' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/health' ? { ok: true, application: HEALTH_APPLICATION_ID, pid, version: '1.21.0' } : { error: 'API 경로를 찾을 수 없습니다.' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = (server.address() as { port: number }).port;
  await mkdir(join(stateDir, '.instance-lock'), { recursive: true });
  await writeFile(join(stateDir, '.instance-lock', 'owner-00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ pid: process.pid, port, createdAt: new Date().toISOString() }));
  const code = encodeJoinCode({ v: 1, name: 'computer-a', pin: Buffer.alloc(32, 1).toString('base64url'), addresses: ['ws://127.0.0.1:9/tower-link'],
    inviteId: '00000000-0000-4000-8000-000000000000', secret: Buffer.alloc(32, 2).toString('base64url'), expiresAt: Date.now() + 60_000, version: '1.23.0' });
  // Another program answers on the recorded port: it is not this folder's Tower.
  await assert.rejects(runLinkCommand(['join', code, '--state-dir', stateDir, '--no-service']), /Tower is not running here/);
  pid = process.pid;
  await assert.rejects(runLinkCommand(['join', code, '--state-dir', stateDir, '--no-service']), /Tower 1\.21\.0 is running here but cannot join/);
});

test('join hands the code to the Tower running here and waits until the other computer accepts it', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-join-running-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const pin = Buffer.alloc(32, 7).toString('base64url');
  const code = encodeJoinCode({ v: 1, name: 'computer-a\u001b[2J', pin, addresses: ['ws://127.0.0.1:9/tower-link'],
    inviteId: '00000000-0000-4000-8000-000000000000', secret: Buffer.alloc(32, 2).toString('base64url'), expiresAt: Date.now() + 60_000, version: '1.23.0' });
  const received: unknown[] = [];
  let joined = false;
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/health') return reply(200, { ok: true, application: HEALTH_APPLICATION_ID, pid: process.pid, version: '1.23.0' });
    if (req.url === '/api/bootstrap') return reply(200, { token: 'a'.repeat(64) });
    if (req.url === '/api/link' && req.method === 'GET') return reply(200, { controllers: joined ? [{ id: linkId(pin), name: 'computer-a', fingerprint: '', state: 'paired', status: 'connected' }] : [] });
    if (req.url === '/api/link/join' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { received.push({ token: req.headers['x-agent-monitor-token'], body: JSON.parse(body) }); joined = true; reply(200, {}); });
      return;
    }
    reply(404, { error: 'API 경로를 찾을 수 없습니다.' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await mkdir(join(stateDir, '.instance-lock'), { recursive: true });
  await writeFile(join(stateDir, '.instance-lock', 'owner-00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, createdAt: new Date().toISOString() }));
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  await runLinkCommand(['join', code, '--state-dir', stateDir, '--no-service']);
  assert.deepEqual(received, [{ token: 'a'.repeat(64), body: { code } }]);
  assert.ok(lines.some(line => line.startsWith('Connected. computer-a[2J can now see')), lines.join('\n'));
  assert.ok(lines.every(line => !line.includes('\u001b')), 'the pasted name cannot drive the terminal');
});
