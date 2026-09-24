import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderServicePlist, runtimePaths, serviceLabel, currentVersion, useVersion, installVersion } from '../../../server/link/service.js';
import { runLinkCommand } from '../../../server/link/cli.js';
import { encodeJoinCode } from '../../../server/link/join-code.js';
import { defaultStateDir } from '../../../server/state-dir.js';

test('the background service runs the current installed version with this state folder and the user’s tools', () => {
  const stateDir = '/Users/someone/.agent-session-tower & <test>';
  const plist = renderServicePlist(stateDir, { port: 8123, node: '/opt/homebrew/bin/node',
    environment: { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/someone', CODEX_HOME: '/Users/someone/.codex', SECRET_TOKEN: 'never' } });
  assert.match(plist, new RegExp(`<key>Label</key><string>${serviceLabel(stateDir).replace(/\./g, '\\.')}</string>`));
  const args = [...plist.matchAll(/^ {4}<string>(.*)<\/string>$/gm)].map(match => match[1]);
  assert.deepEqual(args, ['/opt/homebrew/bin/node', `${join(runtimePaths(stateDir).current, 'node_modules', 'agent-session-tower', 'bin', 'agent-session-tower.mjs').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}`,
    'run', '--no-open', '--port', '8123', '--state-dir', '/Users/someone/.agent-session-tower &amp; &lt;test&gt;']);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
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
