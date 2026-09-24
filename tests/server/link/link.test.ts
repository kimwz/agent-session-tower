import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { ControllerLinks } from '../../../server/link/controller.js';
import { NodeLinks } from '../../../server/link/node.js';
import { loadLinkIdentity, type LinkIdentity } from '../../../server/link/identity.js';
import { decodeJoinCode, encodeJoinCode } from '../../../server/link/join-code.js';
import { linkRequest } from '../../../server/link/transport.js';
import { until } from '../../helpers/until.ts';

async function computer(t: TestContext, name: string) {
  const stateDir = await mkdtemp(join(tmpdir(), `tower-link-${name}-`));
  const identity = await loadLinkIdentity(stateDir);
  const served: Array<{ controllerId: string; path: string }> = [];
  const open = async () => {
    const controller = new ControllerLinks({ stateDir, identity, version: '1.23.0', hostname: () => name });
    const node = new NodeLinks({ stateDir, identity, version: '1.23.0', hostname: () => name, features: () => ['work'],
      handle: (req, res, principal) => { served.push({ controllerId: principal.controllerId, path: req.url }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ hostname: name, controllerId: principal.controllerId })); } });
    await controller.start();
    await node.start();
    return { controller, node };
  };
  let current = await open();
  const self = {
    name, stateDir, identity, served,
    get controller() { return current.controller; },
    get node() { return current.node; },
    /** Starts listening for joining computers on a loopback port. */
    async listen() {
      await current.controller.setHub({ enabled: true, port: 0, bind: '127.0.0.1' });
      const port = current.controller.hub().port;
      await current.controller.setHub({ custom: [`ws://127.0.0.1:${port}/tower-link`] });
      return port;
    },
    async restart() { await current.node.close(); await current.controller.close(); current = await open(); },
    async stop() { await current.node.close(); await current.controller.close(); },
  };
  t.after(async () => { await self.stop(); await rm(stateDir, { recursive: true, force: true }); });
  return self;
}
const connected = (controller: ControllerLinks, name: string) => until(() => controller.list().find(node => node.name === name && node.status === 'connected'), 5000);

test('a computer joins with a code; each side then knows the other and requests reach the joined computer', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  const invite = await a.controller.invite();
  assert.match(invite.command, /^npx --yes github:kimwz\/agent-session-tower#v1\.23\.0 join tower-link:/);
  await b.node.join(invite.code);
  const joined = await connected(a.controller, 'computer-b');
  assert.equal(joined.fingerprint, b.identity.fingerprint);
  assert.deepEqual(joined.features, ['work']);
  const controller = await until(() => b.node.list().find(item => item.status === 'connected' && item.state === 'paired'), 5000);
  assert.equal(controller.name, 'computer-a');
  assert.equal(controller.fingerprint, a.identity.fingerprint);
  const answer = await linkRequest(a.controller.session(joined.id)!, 'GET', '/api/snapshot');
  assert.deepEqual(answer.json, { hostname: 'computer-b', controllerId: a.identity.id });
  assert.equal((await stat(join(a.stateDir, 'link', 'controller.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(b.stateDir, 'link', 'controllers.json'))).mode & 0o777, 0o600);
});

test('a code works once: a second computer using it is not accepted', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  const c = await computer(t, 'computer-c');
  await a.listen();
  const invite = await a.controller.invite();
  await b.node.join(invite.code);
  await connected(a.controller, 'computer-b');
  await c.node.join(invite.code);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(a.controller.list().map(node => node.name), ['computer-b']);
  assert.equal(c.node.list()[0].status === 'connected', false);
});

test('an expired code, a code from this computer, and text that is not a code are refused before connecting', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  const invite = decodeJoinCode((await a.controller.invite()).code);
  await assert.rejects(b.node.join(encodeJoinCode({ ...invite, expiresAt: Date.now() - 1 })), /만료/);
  await assert.rejects(a.node.join(encodeJoinCode(invite)), /이 컴퓨터에서 만든 코드/);
  for (const text of ['hello', 'tower-link:', `tower-link:${Buffer.from('{"v":1}').toString('base64url')}`,
    encodeJoinCode({ ...invite }).replace('tower-link:', 'tower-lnk:')]) await assert.rejects(b.node.join(text), /연결 코드가 아닙니다/);
  assert.throws(() => encodeJoinCode({ ...invite, addresses: ['http://127.0.0.1:1/tower-link'] }));
  assert.throws(() => encodeJoinCode({ ...invite, addresses: ['ws://user:pass@127.0.0.1:1/tower-link'] }));
  assert.deepEqual(b.node.list(), []);
});

test('a joining computer refuses to connect when another computer answers in place of the one the code names', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  const invite = decodeJoinCode((await a.controller.invite()).code);
  await b.node.join(encodeJoinCode({ ...invite, pin: randomBytes(32).toString('base64url') }));
  const refused = await until(() => b.node.list().find(item => item.status === 'refused'), 5000);
  assert.match(refused.error ?? '', /다른 컴퓨터가 응답/);
  assert.deepEqual(a.controller.list(), []);
});

test('without the code’s secret a computer cannot join, even with the right controller and invitation', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  const invite = decodeJoinCode((await a.controller.invite()).code);
  await b.node.join(encodeJoinCode({ ...invite, secret: randomBytes(32).toString('base64url') }));
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.deepEqual(a.controller.list(), []);
  assert.equal(b.served.length, 0);
});

test('after both computers restart they reconnect by their pinned keys alone', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  const port = await a.listen();
  await b.node.join((await a.controller.invite()).code);
  await connected(a.controller, 'computer-b');
  await a.restart();
  await a.controller.setHub({ enabled: true, port, bind: '127.0.0.1' });
  await b.restart();
  await connected(a.controller, 'computer-b');
  assert.equal(b.node.list()[0].state, 'paired');
});

test('removing a computer on the controller tells it to stop connecting, and it is refused if it comes back', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  await b.node.join((await a.controller.invite()).code);
  const joined = await connected(a.controller, 'computer-b');
  await a.controller.remove(joined.id);
  await until(() => b.node.list().length === 0 || undefined, 5000);
  assert.deepEqual(a.controller.list(), []);
});

test('a computer that stops trusting its controller shows there as having left', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  await b.node.join((await a.controller.invite()).code);
  await connected(a.controller, 'computer-b');
  await until(() => b.node.list().find(item => item.state === 'paired'), 5000);
  await b.node.remove(b.node.list()[0].id);
  await until(() => a.controller.list().find(node => node.status === 'removed-by-node'), 5000);
  assert.deepEqual(b.node.list(), []);
});

test('one computer can be joined to two controllers at once', async t => {
  const a = await computer(t, 'computer-a');
  const d = await computer(t, 'computer-d');
  const c = await computer(t, 'computer-c');
  await a.listen();
  await d.listen();
  await c.node.join((await a.controller.invite()).code);
  await c.node.join((await d.controller.invite()).code);
  await connected(a.controller, 'computer-c');
  await connected(d.controller, 'computer-c');
  assert.deepEqual(c.node.list().map(item => item.name).sort(), ['computer-a', 'computer-d']);
});

test('the link port serves nothing to a browser or to plain web requests', async t => {
  const a = await computer(t, 'computer-a');
  const port = await a.listen();
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/snapshot`)).status, 404);
  const opened = await new Promise<boolean>(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/tower-link`, { headers: { Origin: 'https://attacker.example' } });
    socket.once('open', () => { socket.close(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
  assert.equal(opened, false);
});

test('a link identity is made once, kept private, and reused', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-link-identity-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const first: LinkIdentity = await loadLinkIdentity(stateDir);
  const again = await loadLinkIdentity(stateDir);
  assert.equal(again.pin, first.pin);
  assert.match(first.id, /^[a-f0-9]{32}$/);
  assert.match(first.fingerprint, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal((await stat(join(stateDir, 'link', 'identity.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateDir, 'link'))).mode & 0o777, 0o700);
});

test('a computer removed while it was away is told to stop connecting when it comes back', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  await b.node.join((await a.controller.invite()).code);
  const joined = await connected(a.controller, 'computer-b');
  await until(() => b.node.list().find(item => item.state === 'paired'), 5000);
  await b.stop();
  await a.controller.remove(joined.id);
  await b.restart();
  await until(() => b.node.list().length === 0 || undefined, 5000);
  assert.deepEqual(a.controller.list(), []);
});

test('joining finishes after the joining computer restarts part-way', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  const invite = await a.controller.invite();
  await b.node.join(invite.code);
  // Stopped before the link came up: only the saved claim remains.
  await b.stop();
  await b.restart();
  await connected(a.controller, 'computer-b');
  await until(() => b.node.list().find(item => item.state === 'paired'), 5000);
});

test('a computer removed on the controller can join again with a new code', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  await b.node.join((await a.controller.invite()).code);
  const joined = await connected(a.controller, 'computer-b');
  await a.controller.remove(joined.id);
  await until(() => b.node.list().length === 0 || undefined, 5000);
  await b.node.join((await a.controller.invite()).code);
  await connected(a.controller, 'computer-b');
  await until(() => b.node.list().find(item => item.state === 'paired'), 5000);
});

test('a computer whose confirmation was lost finishes joining on its next connection', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  const invite = decodeJoinCode((await a.controller.invite()).code);
  await b.node.join(encodeJoinCode(invite));
  await connected(a.controller, 'computer-b');
  await until(() => b.node.list().find(item => item.state === 'paired'), 5000);
  await b.stop();
  // As if the controller's "paired" message never arrived: the computer still offers its invitation.
  const path = join(b.stateDir, 'link', 'controllers.json');
  const saved = JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, unknown>>;
  await writeFile(path, JSON.stringify(saved.map(record => ({ ...record, state: 'claiming', inviteId: invite.inviteId, secret: invite.secret, expiresAt: invite.expiresAt }))));
  await b.restart();
  await until(() => b.node.list().find(item => item.state === 'paired' && item.status === 'connected'), 5000);
});

test('a computer whose link breaks mid-request is dropped cleanly on both sides and reconnects', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  await b.node.join((await a.controller.invite()).code);
  const joined = await connected(a.controller, 'computer-b');
  const session = a.controller.session(joined.id)!;
  const pending = linkRequest(session, 'GET', '/api/snapshot').catch(error => error as Error);
  session.destroy(new Error('network went away'));
  assert.ok(await pending instanceof Error, 'the request in flight fails instead of hanging');
  await until(() => a.controller.list().find(node => node.status === 'offline'), 5000);
  await connected(a.controller, 'computer-b');
});
