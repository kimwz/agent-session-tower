import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { startMasterHost } from '../../server/master/host.js';
import { MasterClient } from '../../server/master/client.js';
import { masterPaths } from '../../server/master/paths.js';
import type { ModelCall } from '../../server/master/model-openai.js';
import type { MasterCheckpoint, MasterOverview } from '../../shared/master.js';
import { until } from '../helpers/until.js';

test('the master runs in its own host: the web relays its conversation live and lets go of it without stopping it', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-master-host-'));
  const cleanup: Array<() => unknown> = [];
  // In order: pages and clients let go, the host flushes and stops, then its folder goes.
  t.after(async () => { for (const step of cleanup.reverse()) await step(); await rm(stateDir, { recursive: true, force: true }); });
  const model: ModelCall = async () => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '네, 지금은 조용합니다.' }] }], text: '네, 지금은 조용합니다.' });
  const host = await startMasterHost({ stateDir, model, idleMs: 60_000 });
  cleanup.push(() => host.close());
  const paths = await masterPaths(stateDir);
  assert.equal((await stat(paths.token)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.data)).mode & 0o777, 0o700);
  const client = new MasterClient({ stateDir, credentials: () => ({ port: 1, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) }) });
  cleanup.push(() => client.dispose());

  const before = await client.call('overview') as MasterOverview;
  assert.equal(before.state, 'unconfigured');
  assert.equal(before.settings.guards.maxIrreversiblePerTurn, 0, 'no limits unless the owner sets them');
  const after = await client.call('settings', { body: { apiKey: 'sk-test-0123456789abcdef' } }) as MasterOverview;
  assert.equal(after.configured, true);
  assert.equal(after.keyHint, '…cdef');
  assert.doesNotMatch(JSON.stringify(after), /0123456789ab/);
  assert.equal(((await stat(join(paths.data, 'openai-key.json'))).mode & 0o777), 0o600);

  // A page's live stream goes through the web to the host.
  const checkpoint = await client.call('checkpoint') as MasterCheckpoint;
  const relay = createServer((req, res) => { void client.pipe(res, checkpoint.epoch, checkpoint.seq); });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { relay.closeAllConnections(); relay.close(() => resolve()); }));
  const stream = await fetch(`http://127.0.0.1:${(relay.address() as { port: number }).port}/`);
  const reader = stream.body!.getReader();
  let text = '';
  const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += new TextDecoder().decode(value); } })();
  await client.call('send', { clientMessageId: 'message-0001', text: '지금 뭐 돌아가?', local: true });
  await until(() => text.includes('조용합니다'));
  assert.match(text, /"kind":"owner"/);
  await reader.cancel(); await reading.catch(() => {});

  // Letting go (a web shutting down) leaves the host and its conversation in place.
  client.dispose();
  const again = new MasterClient({ stateDir, credentials: () => undefined });
  cleanup.push(() => again.dispose());
  const resumed = await again.call('checkpoint') as MasterCheckpoint;
  assert.equal(resumed.epoch, checkpoint.epoch);
  assert.ok(resumed.entries.some(entry => entry.data.kind === 'master'));
  // Idle, it steps aside when asked; then nothing answers and no version is in use.
  assert.equal(await again.hostVersion() !== null, true);
  assert.equal(await again.call('shutdown'), true);
  const deadline = Date.now() + 5000;
  while (await again.hostVersion().catch(() => 'error') !== null) {
    assert.ok(Date.now() < deadline, 'the host did not step aside');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});

test('the master stays removable: only three existing files reach into it', async () => {
  const root = join(import.meta.dirname, '..', '..');
  const allowed = new Set(['server/index.ts', 'client/src/app/App.tsx']);
  const offenders: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', 'master'].includes(entry.name)) await walk(path); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const name = relative(root, path);
      if (name === 'shared/master.ts') continue;
      const source = await readFile(path, 'utf8');
      if (/from\s+['"][^'"]*\/master(\/|\.js['"]|['"])/.test(source) && !allowed.has(name)) offenders.push(name);
    }
  };
  for (const folder of ['server', 'client/src', 'shared']) await walk(join(root, folder));
  assert.deepEqual(offenders, []);
  // server/http/server.ts takes the master only as an option and never imports it.
  assert.doesNotMatch(await readFile(join(root, 'server/http/server.ts'), 'utf8'), /from '\.\.\/master\//);
});
