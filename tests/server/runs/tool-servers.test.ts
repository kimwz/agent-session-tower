import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitToolServers } from '../../../server/runs/session-mcp.js';

async function folder(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-tool-servers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a turn waits for a tool server script that is being rebuilt', async t => {
  const entry = join(await folder(t), 'index.js');
  setTimeout(() => void writeFile(entry, ''), 60);
  const started = Date.now();
  await awaitToolServers({ servers: { tower_slack: { command: '/fixture/node', args: [entry, '--slack-mcp', '/state', 'workflow'] } }, required: true }, { intervalMs: 10 });
  assert.ok(Date.now() - started >= 50);
});

test('required tools whose script never appears fail the turn; optional ones do not', async t => {
  const servers = { tower: { command: '/fixture/node', args: [join(await folder(t), 'missing.js'), '--tower-mcp', '/state'] } };
  await assert.rejects(awaitToolServers({ servers, required: true }, { timeoutMs: 30, intervalMs: 10 }), /cannot start: .*missing\.js is missing/);
  await awaitToolServers({ servers, required: false }, { timeoutMs: 30, intervalMs: 10 });
});

test('only absolute script paths are checked', async () => {
  await awaitToolServers({ servers: { tower_slack: { command: '/fixture/node', args: ['bridge.mjs', '/state'] } }, required: true }, { timeoutMs: 0 });
  await awaitToolServers({ required: true }, { timeoutMs: 0 });
});
