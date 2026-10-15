import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/skip-fsync.js';
import { fastScrypt } from '../../helpers/fast-scrypt.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { createMonitorServer } from '../../../server/http/server.js';
import { DurableRunManager } from '../../../server/runs/durable-runner.js';
import { CALLER_CAPABILITY_HEADER } from '../../../server/runs/session-mcp.js';
import type { RequestContext } from '../../../server/http/request-context.js';

fastScrypt();

/**
 * A worker of 1.129–1.132 still admits the owner into a session they connected to the secret broker (#116) only with
 * the web's owner proof. While such a worker keeps running turns after the web updates, the web still passes it on.
 */
test('the owner proof comes from the signed-in page or the verified master, never a body field, loopback, an agent or a calling turn', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-owner-proof-http-'));
  const { auth, cookie } = await createRemoteAuthFixture(dir);
  const contexts: Record<string, Array<RequestContext | undefined>> = { enqueue: [], api: [], autoPrompt: [] };
  const masterCredential = 'fixture-master-credential';
  const app = createMonitorServer({ port: 0, clientDir: dir, auth, master: { callerSecret: masterCredential, handle: async () => false }, backend: {
    snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'fixture', updatedAt: '' }),
    detail: async () => undefined, cancel: async () => {}, subscribe: () => () => {},
    enqueue: async (_id, _prompt, _attachments, context) => { contexts.enqueue.push(context); return { id: 'fixture-run' } as never; },
    api: async (_operation, _input, context) => { contexts.api.push(context); return []; },
    startAutoPrompt: async (_request, context) => { contexts.autoPrompt.push(context); return { id: 'fixture-job' } as never; },
  } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.dispose(); auth.close(); await auth.flush(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const { token } = await (await fetch(`${base}/api/bootstrap`)).json();
  const post = (path: string, body: unknown, extra: Record<string, string>) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Agent-Monitor-Token': token, ...extra }, body: JSON.stringify(body) });
  const message = (extra: Record<string, string> = {}) => post('/api/sessions/codex:fixture/messages', { prompt: 'Fixture continuation', brokerOwnerAuthorized: true }, extra);
  assert.equal((await message()).status, 202); assert.equal(contexts.enqueue.at(-1)?.brokerOwnerAuthorized, undefined, 'loopback alone and a body field prove nothing');
  assert.equal((await message({ cookie })).status, 202); assert.equal(contexts.enqueue.at(-1)?.brokerOwnerAuthorized, true);
  assert.equal((await message({ 'X-Tower-Master': masterCredential })).status, 202); assert.equal(contexts.enqueue.at(-1)?.brokerOwnerAuthorized, true);
  for (const headers of [{ cookie, 'X-Tower-Agent': 'local' }, { cookie, 'X-Tower-Master': 'invalid' }, { cookie, [CALLER_CAPABILITY_HEADER]: 'a'.repeat(64) }] as Record<string, string>[]) {
    assert.equal((await message(headers)).status, 202); assert.equal(contexts.enqueue.at(-1)?.brokerOwnerAuthorized, undefined, JSON.stringify(Object.keys(headers)));
  }
  assert.equal(contexts.enqueue.at(-1)?.callerCapability, 'a'.repeat(64));
  // The typed API and Auto Prompt take the same proof.
  assert.equal((await post('/api/v1/runs.list', {}, { cookie })).status, 200); assert.equal(contexts.api.at(-1)?.brokerOwnerAuthorized, true);
  assert.equal((await post('/api/v1/runs.list', {}, { cookie, 'X-Tower-Agent': 'local' })).status, 200); assert.equal(contexts.api.at(-1)?.brokerOwnerAuthorized, undefined);
  const prompt = () => ({ requestId: randomUUID(), provider: 'codex', prompt: 'Fixture request' });
  assert.equal((await post('/api/auto-prompts', prompt(), { cookie })).status, 202); assert.equal(contexts.autoPrompt.at(-1)?.brokerOwnerAuthorized, true);
  assert.equal((await post('/api/auto-prompts', prompt(), { cookie, [CALLER_CAPABILITY_HEADER]: 'b'.repeat(64) })).status, 202); assert.equal(contexts.autoPrompt.at(-1)?.brokerOwnerAuthorized, undefined);
});

test('the web passes the owner proof to the worker with every admission it took before, and nothing for other callers', async () => {
  const manager = new DurableRunManager({ stateDir: join(tmpdir(), `tower-owner-proof-${randomUUID()}`) });
  const calls: Array<[string, unknown[]]> = [];
  Object.assign(manager, { snapshot: { capabilities: ['delegation', 'origins', 'remoteOrigins', 'triggers', 'remoteTriggers', 'autoPromptTargets'], sessions: [], runs: [], nativeIds: {} },
    call: async (method: string, args: unknown[]) => { calls.push([method, args]); return {}; } });
  const admission = (method: string) => { const [, args] = calls.findLast(([name]) => name === method)!; return args.at(-1) as Record<string, unknown> | undefined; };
  const prompt = () => ({ requestId: randomUUID(), provider: 'codex' as const, prompt: 'Fixture request' });
  const capability = 'c'.repeat(64);
  await manager.create({ provider: 'codex', cwd: '/fixture', prompt: 'New work' }, { origin: { kind: 'owner' }, brokerOwnerAuthorized: true });
  assert.equal(admission('create')?.brokerOwnerAuthorized, true);
  await manager.enqueue('codex:fixture', 'Follow-up', {}, { origin: { kind: 'owner' }, brokerOwnerAuthorized: true });
  assert.equal(admission('enqueue')?.brokerOwnerAuthorized, true);
  await manager.api('runs.list', {}, { origin: { kind: 'owner' }, brokerOwnerAuthorized: true });
  assert.deepEqual(admission('api'), { brokerOwnerAuthorized: true });
  await manager.submitAutoPrompt(prompt(), { origin: { kind: 'owner' }, brokerOwnerAuthorized: true });
  assert.equal(admission('submitAutoPrompt')?.brokerOwnerAuthorized, true);
  for (const internal of [{ origin: { kind: 'owner' as const } }, { origin: { kind: 'owner' as const }, callerCapability: capability }]) {
    await manager.create({ provider: 'codex', cwd: '/fixture', prompt: 'New work' }, internal); assert.equal(admission('create')?.brokerOwnerAuthorized, undefined);
    await manager.enqueue('codex:fixture', 'Follow-up', {}, internal); assert.equal(admission('enqueue')?.brokerOwnerAuthorized, undefined);
    await manager.api('runs.list', {}, internal); assert.equal(admission('api')?.brokerOwnerAuthorized, undefined);
    await manager.submitAutoPrompt(prompt(), internal); assert.equal(admission('submitAutoPrompt')?.brokerOwnerAuthorized, undefined);
  }
  assert.equal(admission('api')?.callerCapability, capability);
  // A controlling computer's request never carried it.
  await manager.api('runs.list', {}, { origin: { kind: 'owner', controllerId: 'd'.repeat(32) }, brokerOwnerAuthorized: true });
  assert.equal(admission('api')?.brokerOwnerAuthorized, undefined);
});
