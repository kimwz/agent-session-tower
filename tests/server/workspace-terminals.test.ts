import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { WorkspaceTerminals, type WorkspacePty, type TerminalSpawnOptions } from '../../server/workspace-terminals.js';

class Pty implements WorkspacePty {
  written: string[] = [];
  sizes: number[][] = [];
  killed = 0;
  data = new Set<(data: string) => void>();
  exits = new Set<(event: { exitCode: number }) => void>();
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killed++; }
  onData(listener: (data: string) => void) { this.data.add(listener); return { dispose: () => { this.data.delete(listener); } }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exits.add(listener); return { dispose: () => { this.exits.delete(listener); } }; }
  output(data: string) { for (const listener of this.data) listener(data); }
  exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode }); }
}
class Response extends EventEmitter {
  frames: string[] = [];
  destroyed = false;
  writableEnded = false;
  block = false;
  writeHead() { return this; }
  write(data: string) { this.frames.push(data); return !this.block; }
  end() { this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  asHttp() { return this as unknown as ServerResponse; }
}
function setup(options: { disconnectGraceMs?: number; maxTerminals?: number; keepAliveOnDisconnect?: boolean } = {}) {
  const ptys: Pty[] = [];
  const calls: { shell: string; args: string[]; options: TerminalSpawnOptions }[] = [];
  const terminals = new WorkspaceTerminals({ env: { SHELL: '/bin/fixture-shell', FIXTURE: 'isolated' }, platform: 'darwin', ...options,
    spawnPty: (shell, args, options) => { calls.push({ shell, args, options }); const pty = new Pty(); ptys.push(pty); return pty; },
  });
  return { terminals, ptys, calls };
}

test('PTY starts in exact cwd, accepts raw input and resize, and is killed on close', async t => {
  const { terminals, ptys, calls } = setup(); t.after(() => terminals.dispose());
  const cwd = '/fixture/space \' $(never)\nproject';
  const { id } = await terminals.create(cwd, 80, 24);
  assert.deepEqual(calls, [{ shell: '/bin/fixture-shell', args: ['-l'], options: { cwd, cols: 80, rows: 24, name: 'xterm-256color', env: { SHELL: '/bin/fixture-shell', FIXTURE: 'isolated', TERM: 'xterm-256color' } } }]);
  terminals.input(id, 'pwd\r'); terminals.resize(id, 100, 40);
  assert.deepEqual(ptys[0].written, ['pwd\r']); assert.deepEqual(ptys[0].sizes, [[100, 40]]);
  terminals.close(id); assert.equal(ptys[0].killed, 1);
  assert.throws(() => terminals.input(id, 'x'), { statusCode: 404 });
});

test('SSE replays early output and resumes after last event without duplicating it', async t => {
  const { terminals, ptys } = setup(); t.after(() => terminals.dispose());
  const { id } = await terminals.create('/fixture', 80, 24);
  ptys[0].output('before connection\r\n');
  const response = new Response(); terminals.attach(id, response.asHttp());
  ptys[0].output('live\nwith newline');
  assert.match(response.frames.join(''), /id: 1\nevent: output\ndata: \{"data":"before connection\\r\\n"\}/);
  response.destroy();
  const reconnect = new Response(); terminals.attach(id, reconnect.asHttp(), '1');
  assert.doesNotMatch(reconnect.frames.join(''), /before connection/);
  assert.match(reconnect.frames.join(''), /id: 2\nevent: output/);
  ptys[0].exit(7);
  assert.match(reconnect.frames.join(''), /event: exit\ndata: \{"exitCode":7\}/);
  assert.throws(() => terminals.input(id, 'x'), { statusCode: 409 });
});

test('output replay is bounded and slow consumers are disconnected', async t => {
  const { terminals, ptys } = setup(); t.after(() => terminals.dispose());
  const { id } = await terminals.create('/fixture', 80, 24);
  ptys[0].output('a'.repeat(1024 * 1024));
  const replay = new Response(); terminals.attach(id, replay.asHttp());
  assert.ok(replay.frames.join('').length < 300 * 1024);
  assert.match(replay.frames.join(''), /Earlier terminal output was truncated/);
  const slow = new Response(); slow.block = true; terminals.attach(id, slow.asHttp());
  ptys[0].output('b'.repeat(1024 * 1024));
  assert.equal(slow.destroyed, true);
});

test('input limits, size validation and terminal caps do not spawn extra processes', async t => {
  const { terminals, ptys } = setup({ maxTerminals: 1 }); t.after(() => terminals.dispose());
  await assert.rejects(terminals.create('/fixture', 1000, 24), { statusCode: 400 });
  const { id } = await terminals.create('/fixture', 80, 24);
  await assert.rejects(terminals.create('/fixture', 80, 24), { statusCode: 429 });
  assert.equal(ptys.length, 1);
  assert.throws(() => terminals.resize(id, 80, 0), { statusCode: 400 });
  assert.throws(() => terminals.input(id, 'x'.repeat(16385)), { statusCode: 400 });
  for (let i = 0; i < 128; i++) terminals.input(id, 'x'.repeat(16384));
  assert.throws(() => terminals.input(id, 'x'), { statusCode: 429 });
  assert.equal(ptys[0].written.length, 128);
  assert.throws(() => terminals.attach(id, new Response().asHttp(), '999'), { statusCode: 400 });
});

test('unattached and disconnected terminals expire; attached terminals survive grace period', async t => {
  const { terminals, ptys } = setup({ disconnectGraceMs: 10 }); t.after(() => terminals.dispose());
  await terminals.create('/fixture', 80, 24);
  const { id } = await terminals.create('/fixture', 80, 24);
  const response = new Response(); terminals.attach(id, response.asHttp());
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ptys[0].killed, 1); assert.equal(ptys[1].killed, 0);
  response.destroy();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ptys[1].killed, 1);
});

test('disposal kills all PTYs, ends streams, and handles an in-flight spawn', async () => {
  const { terminals, ptys } = setup();
  const { id } = await terminals.create('/fixture', 80, 24);
  const response = new Response(); terminals.attach(id, response.asHttp());
  terminals.dispose(); terminals.dispose();
  assert.equal(ptys[0].killed, 1); assert.equal(response.writableEnded, true);
  await assert.rejects(terminals.create('/fixture', 80, 24), { statusCode: 503 });
  let finish!: (pty: WorkspacePty) => void;
  const pending = new WorkspaceTerminals({ spawnPty: () => new Promise(resolve => { finish = resolve; }) });
  const creating = pending.create('/fixture', 80, 24);
  pending.dispose();
  const pty = new Pty(); finish(pty);
  await assert.rejects(creating, { statusCode: 503 }); assert.equal(pty.killed, 1);
});


test('durable shells survive browser disconnects and only explicit close terminates them', async t => {
  const { terminals, ptys } = setup({ disconnectGraceMs: 5, keepAliveOnDisconnect: true }); t.after(() => terminals.dispose());
  const { id } = await terminals.create('/fixture', 80, 24);
  const response = new Response(); terminals.attach(id, response.asHttp()); response.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ptys[0].killed, 0); assert.equal(terminals.hasActive(), true);
  ptys[0].output('continued while Tower was disconnected');
  const next = new Response(); terminals.attach(id, next.asHttp());
  assert.match(next.frames.join(''), /continued while Tower was disconnected/);
  terminals.close(id); assert.equal(ptys[0].killed, 1); assert.equal(terminals.hasActive(), false);
});

test('adopting a live terminal cancels its prior disconnect expiry', async t => {
  const { terminals, ptys } = setup({ disconnectGraceMs: 5 }); t.after(() => terminals.dispose());
  const { id } = await terminals.create('/fixture', 80, 24);
  terminals.keepAlive();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ptys[0].killed, 0); terminals.input(id, 'still alive');
  assert.deepEqual(ptys[0].written, ['still alive']);
});
