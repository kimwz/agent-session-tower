import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import { connect as tlsConnect } from 'node:tls';
import { connect, type Socket } from 'node:net';
import { ControllerLinks } from '../../../server/link/controller.js';
import { NodeLinks } from '../../../server/link/node.js';
import { loadLinkIdentity, type LinkIdentity } from '../../../server/link/identity.js';
import { decodeJoinCode, encodeJoinCode } from '../../../server/link/join-code.js';
import { linkRequest, openControllerEnd, openNodeEnd, pairingProof } from '../../../server/link/transport.js';
import { until } from '../../helpers/until.ts';

async function computer(t: TestContext, name: string, options: { pingMs?: number; now?: () => number } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), `tower-link-${name}-`));
  const identity = await loadLinkIdentity(stateDir);
  const served: Array<{ controllerId: string; path: string }> = [];
  const open = async () => {
    const controller = new ControllerLinks({ stateDir, identity, version: '1.23.0', hostname: () => name, ...options });
    const node = new NodeLinks({ stateDir, identity, version: '1.23.0', hostname: () => name, features: () => ['work'], ...options,
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

test('a new link is used only once the joined computer has recorded its pairing, so the first request is served', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  const first = new Promise<number>(resolve => a.controller.once('connected', (id: string) => {
    linkRequest(a.controller.session(id)!, 'GET', '/api/snapshot').then(answer => resolve(answer.status), () => resolve(0));
  }));
  await b.node.join((await a.controller.invite()).code);
  assert.equal(await first, 200);
});

test('a computer removed while it is being told it joined is told to stop instead, and never attached', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  let attached = false;
  a.controller.once('paired', (id: string) => { void a.controller.remove(id); });
  a.controller.on('connected', () => { attached = true; });
  await b.node.join((await a.controller.invite()).code);
  await until(() => b.node.list().find(item => item.status === 'removed'), 5000);
  assert.equal(attached, false);
  assert.deepEqual(a.controller.list(), []);
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
  await until(() => b.node.list().find(item => item.state === 'removed' && item.status === 'removed'), 5000);
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
  await until(() => b.node.list().find(item => item.state === 'removed' && item.status === 'removed'), 5000);
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
  await until(() => b.node.list().find(item => item.state === 'removed' && item.status === 'removed'), 5000);
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

test('a computer removed while it was away joins again with a new code', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  const port = await a.listen();
  await b.node.join((await a.controller.invite()).code);
  const joined = await connected(a.controller, 'computer-b');
  await until(() => b.node.list().find(item => item.state === 'paired'), 5000);
  // The controller stops listening, then listens elsewhere: the joined computer keeps trying the old port.
  await a.controller.setHub({ enabled: false });
  await until(() => b.node.list().find(item => item.status !== 'connected'), 5000);
  await a.controller.remove(joined.id);
  await a.controller.setHub({ enabled: true, port: 0 });
  const again = await a.controller.invite();
  await b.node.join(again.code);
  await a.controller.setHub({ port });
  const rejoined = await connected(a.controller, 'computer-b');
  assert.equal(rejoined.id, joined.id);
  await until(() => b.node.list().find(item => item.state === 'paired' && item.status === 'connected'), 5000);
});

test('joining again while already joined keeps the computer’s name and label on the controller', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  await a.listen();
  await b.node.join((await a.controller.invite()).code);
  const joined = await connected(a.controller, 'computer-b');
  await a.controller.rename(joined.id, 'Studio');
  await b.node.join((await a.controller.invite()).code);
  await b.restart();
  const back = await connected(a.controller, 'computer-b');
  assert.equal(back.label, 'Studio');
  assert.equal(back.pairedAt, joined.pairedAt);
  assert.equal(a.controller.list().length, 1);
});

test('a code used to join again cannot be used by another computer afterwards', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  const c = await computer(t, 'computer-c');
  await a.listen();
  await b.node.join((await a.controller.invite()).code);
  await connected(a.controller, 'computer-b');
  await until(() => b.node.list().find(item => item.state === 'paired'), 5000);
  // This computer stops trusting the controller, then joins it again with a new code the controller still knows it by.
  await b.node.remove(b.node.list()[0].id);
  await until(() => a.controller.list().find(node => node.status === 'removed-by-node'), 5000);
  const again = await a.controller.invite();
  await b.node.join(again.code);
  await connected(a.controller, 'computer-b');
  await c.node.join(again.code);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(a.controller.list().map(node => node.name), ['computer-b']);
});

test('connections that never ask for the link are limited per address and closed', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  const port = await a.listen();
  const sockets = await Promise.all(Array.from({ length: 12 }, () => new Promise<Socket>(resolve => { const socket = connect(port, '127.0.0.1', () => resolve(socket)); socket.on('error', () => {}); })));
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const closed = await Promise.all(sockets.map(socket => new Promise<boolean>(resolve => { socket.once('close', () => resolve(true)); setTimeout(() => resolve(false), 300); })));
  assert.equal(closed.filter(Boolean).length, 8, 'only four silent connections from one address are kept');
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 50));
  await b.node.join((await a.controller.invite()).code);
  await connected(a.controller, 'computer-b');
});

test('closing stops a link that is still being set up', async t => {
  const b = await computer(t, 'computer-b');
  const silent = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => { for (const client of silent.clients) client.terminate(); silent.close(resolve); }));
  await new Promise(resolve => silent.once('listening', resolve));
  const opened = new Promise<WebSocket>(resolve => silent.once('connection', ws => resolve(ws)));
  const a = decodeJoinCode(encodeJoinCode({ v: 1, name: 'silent', pin: randomBytes(32).toString('base64url'), addresses: [`ws://127.0.0.1:${(silent.address() as { port: number }).port}/tower-link`],
    inviteId: '00000000-0000-4000-8000-000000000000', secret: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 60_000, version: '1.23.0' }));
  await b.node.join(encodeJoinCode(a));
  const socket = await opened;
  const gone = new Promise(resolve => socket.once('close', resolve));
  await b.node.close();
  await gone;
});

test('a joined computer that stops answering is dropped quickly and the controller keeps running', async t => {
  const a = await computer(t, 'computer-a', { pingMs: 50 });
  const b = await computer(t, 'computer-b');
  await a.listen();
  await b.node.join((await a.controller.invite()).code);
  const joined = await connected(a.controller, 'computer-b');
  // As if the other computer went to sleep: its end stops reading without closing anything.
  const live = (b.node as unknown as { live: Map<string, { ws: { _socket: Socket } }> }).live;
  const socket = [...live.values()][0].ws._socket;
  socket.pause();
  await until(() => a.controller.list().find(node => node.id === joined.id && node.status === 'offline'), 2000);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(a.controller.session(joined.id), undefined);
  socket.resume();
});

test('a computer cannot join by replaying a pairing proof made for another connection', async t => {
  const a = await computer(t, 'computer-a');
  const port = await a.listen();
  const invite = decodeJoinCode((await a.controller.invite()).code);
  const stranger = await loadLinkIdentity(await mkdtemp(join(tmpdir(), 'tower-link-stranger-')));
  const attempt = new WebSocket(`ws://127.0.0.1:${port}/tower-link`, { perMessageDeflate: false });
  const closed = new Promise(resolve => attempt.once('close', resolve));
  attempt.once('open', () => {
    void openNodeEnd(createWebSocketStream(attempt), stranger, { accept: () => true, handle: (req, res) => {
      // The proof is right in every way except the connection it was made for.
      const proof = pairingProof(invite.secret, randomBytes(32), { inviteId: invite.inviteId, controllerPin: invite.pin, nodePin: stranger.pin });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/link/hello' ? { protocol: 1, name: 'stranger', version: '1.23.0', features: [], pairing: { inviteId: invite.inviteId, proof } } : {}));
    } }).catch(() => {});
  });
  await closed;
  assert.deepEqual(a.controller.list(), []);
});

test('a controller without a certificate is refused by the joining computer and gets no answers', async t => {
  const b = await computer(t, 'computer-b');
  const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => { for (const client of fake.clients) client.terminate(); fake.close(resolve); }));
  await new Promise(resolve => fake.once('listening', resolve));
  const handshake = new Promise<void>(resolve => fake.once('connection', ws => {
    const secure = tlsConnect({ socket: createWebSocketStream(ws), rejectUnauthorized: false, ALPNProtocols: ['h2'], minVersion: 'TLSv1.3' });
    secure.on('error', () => resolve());
    secure.on('secureConnect', () => resolve());
  }));
  await b.node.join(encodeJoinCode({ v: 1, name: 'fake', pin: randomBytes(32).toString('base64url'), addresses: [`ws://127.0.0.1:${(fake.address() as { port: number }).port}/tower-link`],
    inviteId: '00000000-0000-4000-8000-000000000000', secret: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 60_000, version: '1.23.0' }));
  await handshake;
  await until(() => b.node.list().find(item => item.status === 'refused'), 5000);
  assert.equal(b.served.length, 0);
});

test('an expired code is refused by the controller even if the joining computer still tries it', async t => {
  let now = Date.now();
  const a = await computer(t, 'computer-a', { now: () => now });
  const b = await computer(t, 'computer-b');
  await a.listen();
  const invite = await a.controller.invite();
  now += 11 * 60_000;
  await b.node.join(invite.code);
  await until(() => b.node.list().find(item => item.status === 'offline'), 5000);
  assert.deepEqual(a.controller.list(), []);
});

test('a joining computer answers nothing but its introduction until the controller confirms it', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  // A stand-in for computer A holding A's own key: it can connect, but has not confirmed the pairing.
  const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => { for (const client of fake.clients) client.terminate(); fake.close(resolve); }));
  await new Promise(resolve => fake.once('listening', resolve));
  const answers = new Promise<number[]>(resolve => fake.once('connection', ws => {
    void openControllerEnd(createWebSocketStream(ws), a.identity).then(async end => {
      const hello = await linkRequest(end.session, 'GET', '/link/hello');
      const snapshot = await linkRequest(end.session, 'GET', '/api/snapshot');
      resolve([hello.status, snapshot.status]);
    });
  }));
  const code = decodeJoinCode((await (async () => { await a.listen(); return a.controller.invite(); })()).code);
  await b.node.join(encodeJoinCode({ ...code, addresses: [`ws://127.0.0.1:${(fake.address() as { port: number }).port}/tower-link`] }));
  assert.deepEqual(await answers, [200, 404]);
  assert.equal(b.served.length, 0);
});

test('a joining computer tries the next address when another computer answers at one of them', async t => {
  const a = await computer(t, 'computer-a');
  const d = await computer(t, 'computer-d');
  const b = await computer(t, 'computer-b');
  const aPort = await a.listen();
  const dPort = await d.listen();
  const invite = decodeJoinCode((await a.controller.invite()).code);
  await b.node.join(encodeJoinCode({ ...invite, addresses: [`ws://127.0.0.1:${dPort}/tower-link`, `ws://127.0.0.1:${aPort}/tower-link`] }));
  await connected(a.controller, 'computer-b');
  assert.deepEqual(d.controller.list(), []);
});

test('unreadable saved link state stops changes instead of being saved over', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-link-broken-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const identity = await loadLinkIdentity(stateDir);
  await writeFile(join(stateDir, 'link', 'controller.json'), '{"version":2}', { mode: 0o600 });
  await writeFile(join(stateDir, 'link', 'controllers.json'), 'not json', { mode: 0o600 });
  const controller = new ControllerLinks({ stateDir, identity, version: '1.23.0', hostname: () => 'broken' });
  const node = new NodeLinks({ stateDir, identity, version: '1.23.0', hostname: () => 'broken', features: () => [], handle: () => {} });
  await controller.start();
  await node.start();
  t.after(async () => { await node.close(); await controller.close(); });
  assert.match(controller.error ?? '', /controller\.json/);
  assert.match(node.error ?? '', /controllers\.json/);
  await assert.rejects(controller.setHub({ enabled: true, port: 0, bind: '127.0.0.1' }), /읽을 수 없어/);
  await assert.rejects(node.join(encodeJoinCode({ v: 1, name: 'x', pin: randomBytes(32).toString('base64url'), addresses: ['ws://127.0.0.1:9/tower-link'],
    inviteId: '00000000-0000-4000-8000-000000000000', secret: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 60_000, version: '1.23.0' })), /읽을 수 없어/);
  assert.equal(await readFile(join(stateDir, 'link', 'controller.json'), 'utf8'), '{"version":2}');
  assert.equal(await readFile(join(stateDir, 'link', 'controllers.json'), 'utf8'), 'not json');
});

test('an unreadable link identity is reported instead of being replaced', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-link-identity-broken-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await loadLinkIdentity(stateDir);
  await writeFile(join(stateDir, 'link', 'identity.json'), '');
  await assert.rejects(loadLinkIdentity(stateDir));
  assert.equal(await readFile(join(stateDir, 'link', 'identity.json'), 'utf8'), '');
});

test('a code run on a computer that is already joined is spent, and names the computer that used it', async t => {
  const a = await computer(t, 'computer-a');
  const b = await computer(t, 'computer-b');
  const c = await computer(t, 'computer-c');
  await a.listen();
  await b.node.join((await a.controller.invite()).code);
  await connected(a.controller, 'computer-b');
  const again = await a.controller.invite();
  await b.node.join(again.code);
  await until(() => a.controller.list().find(node => node.invite === again.id && node.status === 'connected'), 5000);
  await until(() => b.node.list().find(item => item.state === 'paired' && item.status === 'connected'), 5000);
  await c.node.join(again.code);
  await until(() => c.node.list().find(item => item.status !== 'connecting'), 5000);
  assert.deepEqual(a.controller.list().map(node => node.name), ['computer-b']);
});
