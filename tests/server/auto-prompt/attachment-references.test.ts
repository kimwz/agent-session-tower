import { externalStorageFixture } from '../remote/external-storage-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AutoPromptManager } from '../../../server/auto-prompt/manager.js';
import { RunManager } from '../../../server/runs/manager.js';
import { AttachmentStore } from '../../../server/stores/attachments.js';
import type { Session, Snapshot } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-auto-references-'));
  const nativeId = randomUUID();
  const session: Session = { id: `codex:${nativeId}`, nativeId, provider: 'codex', cwd: directory, project: 'fixture', title: 'Existing', status: 'idle', statusReason: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
  const runs = new RunManager({ stateDir: directory, getSession: id => id === session.id ? session : undefined, refreshSessions: async () => {}, maxConcurrent: 0,
    findExecutable: async () => '/fixture/codex', spawnProcess: () => { throw new Error('These tests must never launch a provider'); } });
  await runs.start();
  const staged = new AttachmentStore(join(directory, 'auto-prompt-staging')); await staged.start();
  const main = new AttachmentStore(directory);
  const snapshot = (): Snapshot => ({ sessions: [session], runs: runs.list(), providers: [{ provider: 'codex', available: true, sessionCount: 1 }], scanning: false,
    updatedAt: session.updatedAt, hostname: 'fixture', version: 'test' });
  const storage = await externalStorageFixture(t, directory);
  const options = { repository: storage.autoPrompt, effectGate: storage.effectGate, stateDir: directory, snapshot, detail: async () => undefined, refresh: async () => {}, runs,
    model: async () => { throw new Error('Explicit targets must not call the native router'); },
    remote: { prepare: async () => {}, matcher: () => ({ revision: 1, excludes: () => false }), coordinators: () => new Set<string>() } };
  const auto = new AutoPromptManager(options); await auto.start(); await auto.startRuntimeEffects();
  t.after(async () => { await auto.close(); await runs.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, session, runs, staged, main, auto, options };
}

async function* original() { for (let index = 0; index < 24; index++) yield Buffer.alloc(1024 * 1024, index); }

for (const action of ['new', 'resume'] as const) test(`Auto ${action} dispatches only references and imports an original above legacy aggregate limits`, async t => {
  const f = await fixture(t);
  const requestId = randomUUID();
  const attachment = await f.staged.upload(requestId, 'original.bin', 'application/octet-stream', original(), { pending: true });
  let dispatched: unknown;
  if (action === 'new') {
    const create = f.runs.create.bind(f.runs);
    f.runs.create = async (input, internal) => { dispatched = input; return create(input, internal); };
  } else {
    const enqueue = f.runs.enqueue.bind(f.runs);
    f.runs.enqueue = async (id, prompt, input, internal) => { dispatched = input; return enqueue(id, prompt, input, internal); };
  }
  const input = { requestId, provider: 'codex' as const, cwd: f.directory, prompt: '', attachmentIds: [attachment.id],
    ...(action === 'new' ? { sessionMode: 'new' as const } : { targetSessionId: f.session.id }) };
  await f.auto.submit(input);
  const job = await until(() => { const job = f.auto.get(requestId); return job && ['completed', 'error'].includes(job.status) ? job : undefined; });
  assert.equal(job.status, 'completed', job.error);
  assert.equal((dispatched as { attachments?: unknown }).attachments, undefined);
  assert.deepEqual((dispatched as { attachmentIds: string[] }).attachmentIds, [attachment.id]);
  assert.ok(JSON.stringify(dispatched).length < 1000);
  const run = f.runs.list().find(run => run.id === job.runId)!;
  assert.equal(run.attachments?.[0].size, 24 * 1024 * 1024);
  assert.notEqual(run.attachments![0].id, attachment.id);
  const stored = await f.main.openVerified(run.attachments![0].id, run.sessionId);
  try { const bytes = await stored.file.readFile(); assert.equal(bytes.length, 24 * 1024 * 1024); for (let index = 0; index < 24; index++) assert.equal(bytes[index * 1024 * 1024], index); }
  finally { await stored.file.close(); }
  await until(() => !f.auto.busy());
  assert.deepEqual(await readdir(f.staged.directory), []);
  await f.auto.close();
  const restarted = new AutoPromptManager(f.options); await restarted.start(); await restarted.startRuntimeEffects();
  try { assert.equal((await restarted.submit(input)).runId, run.id); assert.equal(f.runs.list().length, 1); }
  finally { await restarted.close(); }
});

test('foreign Auto scope and mixed invalid inline upload never admit or leak imported files', async t => {
  const f = await fixture(t);
  const sourceScope = randomUUID();
  const attachment = await f.staged.upload(sourceScope, 'original.bin', 'application/octet-stream', original(), { pending: true });
  await assert.rejects(f.runs.enqueue(f.session.id, '', { attachmentIds: [attachment.id] }, { autoPromptId: randomUUID() }));
  await assert.rejects(f.runs.enqueue(f.session.id, '', { attachmentIds: [attachment.id], attachments: [{ name: '../bad', mimeType: 'text/plain', data: 'YQ==' }] }, { autoPromptId: sourceScope }));
  await assert.rejects(f.runs.create({ provider: 'codex', cwd: f.directory, prompt: '', attachmentIds: [attachment.id] }));
  assert.deepEqual(f.runs.list(), []);
  assert.deepEqual(await readdir(f.main.directory), []);
  assert.equal((await f.staged.read(attachment.id, sourceScope)).metadata.size, attachment.size);
});

test('retention failure logs and preserves an accepted durable run until protected GC pins it', async t => {
  const f = await fixture(t);
  const attachment = await f.main.upload(f.session.id, 'a.txt', 'text/plain', (async function* () { yield Buffer.from('original'); })(), { pending: true });
  const store = (f.runs as unknown as { attachments: AttachmentStore }).attachments;
  const retain = store.retain; store.retain = async () => { throw new Error('disk retention failure'); };
  const messages: string[] = []; const error = console.error; console.error = (...values) => { messages.push(values.join(' ')); };
  let run;
  try { run = await f.runs.enqueue(f.session.id, '', { attachmentIds: [attachment.id] }); }
  finally { store.retain = retain; console.error = error; }
  assert.equal(f.runs.list()[0].id, run.id);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'runs.json'), 'utf8'))[0].id, run.id);
  assert.ok(messages.some(message => /retention failed/.test(message)));
  await f.main.sweepPending(new Set([attachment.id]));
  const manifest = JSON.parse(await readFile(join(f.main.directory, attachment.id, '.metadata.json'), 'utf8'));
  assert.equal(manifest.pendingUntil, undefined);
  assert.equal((await f.main.read(attachment.id, f.session.id)).content.toString(), 'original');
});

 test('an unadmitted Auto upload is bound to its controller, including local and remote separation', async t => {
  const f = await fixture(t);
  const controllerId = 'controllera1b2c3d4e5f6';
  const foreignController = 'controllerb1b2c3d4e5f6';
  const requestId = randomUUID();
  const attachment = await f.staged.upload(requestId, 'a.txt', 'text/plain', (async function* () { yield Buffer.from('original'); })(), { pending: true, owner: controllerId });
  const input = { requestId, provider: 'codex' as const, cwd: f.directory, prompt: '', attachmentIds: [attachment.id], sessionMode: 'new' as const };
  await assert.rejects(f.auto.submit(input, { origin: { kind: 'owner', controllerId: foreignController } }));
  await assert.rejects(f.auto.submit(input, { origin: { kind: 'owner' } }));
  assert.equal(f.auto.list().length, 0); assert.equal(f.runs.list().length, 0);
  const localId = randomUUID();
  const local = await f.staged.upload(localId, 'local.txt', 'text/plain', (async function* () { yield Buffer.from('local'); })(), { pending: true, owner: 'local' });
  await assert.rejects(f.auto.submit({ ...input, requestId: localId, attachmentIds: [local.id] }, { origin: { kind: 'owner', controllerId } }));
  assert.equal(f.auto.list().length, 0);
  await f.auto.submit(input, { origin: { kind: 'owner', controllerId } });
  const job = await until(() => { const job = f.auto.get(requestId); return job && ['completed', 'error'].includes(job.status) ? job : undefined; });
  assert.equal(job.status, 'completed', job.error);
});
