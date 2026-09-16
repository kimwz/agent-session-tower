import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AutoPromptManager } from '../server/auto-prompts.js';
import type { AutoPromptModelRequest } from '../server/auto-prompt-native.js';
import type { RunAdmission } from '../server/runner.js';
import type { AttachmentInput, AutoPromptRequest, CreateSessionRequest, MessageAttachments, Run, Session, Snapshot } from '../shared/types.js';

const nativeId = '11111111-1111-4111-8111-111111111111';
const makeSession = (cwd: string, values: Partial<Session> = {}): Session => ({ id: `codex:${nativeId}`, nativeId, provider: 'codex',
  cwd, project: 'project', title: 'Fix the editor', status: 'completed', statusReason: 'Finished',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  lastMessage: 'The editor now saves files.', messageCount: 2, isSubagent: false, resumable: true,
  contextUsage: { usedTokens: 30_000, contextWindow: 100_000, usedPercent: 30 }, ...values });
const resume = (sessionId: string, relation = 'continuation') => ({ action: 'resume', sessionId, relation, reason: 'The request continues the editor work.' });
const create = () => ({ action: 'create', sessionId: null, relation: 'new', reason: 'A separate task needs a new conversation.' });
const request = (cwd?: string, values: Partial<AutoPromptRequest> = {}): AutoPromptRequest => ({ requestId: randomUUID(), provider: 'codex', prompt: 'Continue the editor work', ...(cwd ? { cwd } : {}), ...values });

async function until<T>(read: () => T | undefined, timeout = 4000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = read(); if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-auto-prompts-'));
  const cwd = join(directory, 'project'); const other = join(directory, 'other');
  await Promise.all([mkdir(cwd), mkdir(other)]);
  const session = makeSession(cwd);
  const managed: Run[] = [];
  const current: Snapshot = { sessions: [session], runs: managed, providers: [{ provider: 'codex', available: true, sessionCount: 1 }, { provider: 'claude', available: true, sessionCount: 0 }],
    scanning: false, updatedAt: session.updatedAt, hostname: 'fixture', version: 'test', groups: [{ cwd: other, title: 'Other project', pinned: true }] };
  const calls: AutoPromptModelRequest[] = [];
  const dispatches: Array<{ action: string; sessionId?: string; input: CreateSessionRequest | { prompt: string } & MessageAttachments; internal?: RunAdmission }> = [];
  let response: (input: AutoPromptModelRequest) => Promise<unknown> = async () => resume(session.id);
  let beforeAdmission: (() => Promise<void>) | undefined;
  const record = (sessionId: string, prompt: string, internal?: RunAdmission): Run => {
    internal?.validate?.();
    const run: Run = { id: randomUUID(), sessionId, prompt, status: 'queued', output: '', createdAt: new Date().toISOString(), ...(internal?.autoPromptId ? { autoPromptId: internal.autoPromptId } : {}) };
    managed.push(run); return run;
  };
  const runs = {
    list: () => structuredClone(managed),
    create: async (input: CreateSessionRequest, internal?: RunAdmission) => {
      await beforeAdmission?.();
      const fresh = makeSession(input.cwd, { id: `${input.provider}:${randomUUID()}`, provider: input.provider });
      const run = record(fresh.id, input.prompt, internal);
      dispatches.push({ action: 'create', input, internal }); current.sessions.push(fresh);
      return { session: fresh, run };
    },
    enqueue: async (sessionId: string, prompt: string, input: MessageAttachments = {}, internal?: RunAdmission) => {
      await beforeAdmission?.();
      const run = record(sessionId, prompt, internal);
      dispatches.push({ action: 'resume', sessionId, input: { prompt, ...input }, internal });
      return run;
    },
  };
  const options = { stateDir: directory, snapshot: () => structuredClone(current), refresh: async () => {}, runs,
    detail: async (id: string) => { const found = current.sessions.find(value => value.id === id); return found ? { session: found, hasMore: false, messages: [
      { id: 'user', role: 'user' as const, text: 'The editor crashes when saving.', timestamp: session.createdAt },
      { id: 'assistant', role: 'assistant' as const, text: 'Fixed the save operation in Editor.tsx.', timestamp: session.updatedAt },
    ] } : undefined; },
    model: async (input: AutoPromptModelRequest) => { calls.push(input); return response(input); },
  };
  const manager = new AutoPromptManager(options);
  await manager.start();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const finished = (id: string) => until(() => { const job = manager.get(id); return job && ['completed', 'error', 'cancelled'].includes(job.status) ? job : undefined; });
  return { directory, cwd, other, session, current, managed, calls, dispatches, manager, options, finished,
    respond: (fn: typeof response) => { response = fn; }, beforeAdmission: (fn: () => Promise<void>) => { beforeAdmission = fn; } };
}

test('explicit directory routes a busy continuation and preserves the original instruction without execution model override', async t => {
  const f = await fixture(t);
  f.session.status = 'working'; f.session.contextUsage = undefined;
  const input = request(f.cwd, { prompt: '  Keep working\nwithout changing the API.  ' });
  const accepted = await f.manager.submit(input);
  assert.equal(accepted.status, 'queued');
  const job = await f.finished(accepted.id);
  assert.equal(job.status, 'completed'); assert.equal(job.decision?.action, 'resume');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].model, 'gpt-5.6-sol');
  assert.equal(f.dispatches[0].input.prompt, input.prompt);
  assert.equal(f.dispatches[0].input.model, undefined);
  assert.equal(f.managed[0].autoPromptId, accepted.id);
  assert.match(f.calls[0].prompt, /Fixed the save operation/);
  assert.match(f.calls[0].systemPrompt, /untrusted data/);
});

test('Auto selects among every directory including closed sessions and empty pins, then restricts candidates to its provider', async t => {
  const f = await fixture(t);
  f.session.closed = true;
  f.respond(async input => {
    const value = JSON.parse(input.prompt);
    if (value.directories) {
      assert.deepEqual(value.directories.map((directory: { cwd: string }) => directory.cwd).sort(), [f.cwd, f.other].sort());
      assert.equal(value.directories.find((directory: { cwd: string }) => directory.cwd === f.cwd).recentSessions[0].provider, 'codex');
      return { directoryId: value.directories.find((directory: { cwd: string }) => directory.cwd === f.other).id, reason: 'Use the other project.' };
    }
    assert.equal(value.cwd, f.other); assert.deepEqual(value.candidates, []);
    return create();
  });
  const accepted = await f.manager.submit(request(undefined, { provider: 'claude' }));
  const job = await f.finished(accepted.id);
  assert.equal(job.status, 'completed'); assert.equal(job.cwd, f.other);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.model === 'opus'));
  assert.equal((f.dispatches[0].input as CreateSessionRequest).provider, 'claude');
});

test('hidden-only folders without sessions remain available to Auto and explicit folder routing without being pinned', async t => {
  for (const mode of ['auto', 'explicit'] as const) await t.test(mode, async t => {
    const f = await fixture(t);
    f.current.sessions = [];
    const hidden = { cwd: f.other, title: '', pinned: false, hidden: true };
    f.current.groups = [hidden];
    f.respond(async input => {
      const value = JSON.parse(input.prompt);
      if (value.directories) {
        assert.deepEqual(value.directories.map((directory: { cwd: string; sessionCount: number }) => [directory.cwd, directory.sessionCount]), [[f.other, 0]]);
        return { directoryId: value.directories[0].id, reason: 'Use the hidden folder.' };
      }
      assert.equal(value.cwd, f.other); assert.deepEqual(value.candidates, []);
      return create();
    });
    const accepted = await f.manager.submit(request(mode === 'explicit' ? f.other : undefined));
    assert.equal((await f.finished(accepted.id)).status, 'completed');
    assert.equal(f.calls.length, mode === 'explicit' ? 1 : 2);
    assert.equal(f.dispatches[0].action, 'create');
    assert.equal((f.dispatches[0].input as CreateSessionRequest).cwd, f.other);
    assert.deepEqual(f.current.groups, [hidden]);
  });
  const f = await fixture(t);
  const missing = join(f.directory, 'missing');
  f.current.groups = [{ cwd: missing, title: '', pinned: false, hidden: true }];
  await assert.rejects(f.manager.submit(request(missing)), /더 이상 존재하지 않습니다/);
  assert.equal(f.calls.length, 0); assert.equal(f.dispatches.length, 0);
});

test('adjacent reuse accepts exactly 30% but rejects estimates, higher, unknown, busy, or already queued context', async t => {
  for (const mode of ['boundary', 'estimated', 'higher', 'unknown', 'busy', 'queued'] as const) await t.test(mode, async t => {
    const f = await fixture(t);
    if (mode === 'estimated') f.session.contextUsage!.capacitySource = 'model-default';
    if (mode === 'higher') f.session.contextUsage!.usedPercent = 30.01;
    if (mode === 'unknown') f.session.contextUsage = { usedTokens: 10 };
    if (mode === 'busy') f.session.status = 'working';
    if (mode === 'queued') f.managed.push({ id: randomUUID(), sessionId: f.session.id, prompt: 'Existing task', status: 'queued', createdAt: f.session.createdAt, output: '' });
    f.respond(async () => resume(f.session.id, 'adjacent'));
    const job = await f.manager.submit(request(f.cwd));
    assert.equal((await f.finished(job.id)).status, mode === 'boundary' ? 'completed' : 'error');
    assert.equal(f.dispatches.length, mode === 'boundary' ? 1 : 0);
  });
});

test('an estimated context percentage does not block a direct task continuation', async t => {
  const f = await fixture(t);
  f.session.contextUsage!.capacitySource = 'model-default';
  f.respond(async input => {
    assert.match(input.systemPrompt, /model-default is an estimate/);
    return resume(f.session.id, 'continuation');
  });
  const accepted = await f.manager.submit(request(f.cwd));
  assert.equal((await f.finished(accepted.id)).status, 'completed');
  assert.equal(f.dispatches.length, 1);
});

test('closed, other provider, other directory, subagent, and pending creation cannot become resume targets', async t => {
  for (const mode of ['closed', 'provider', 'directory', 'subagent', 'pending'] as const) await t.test(mode, async t => {
    const f = await fixture(t);
    f.current.groups!.push({ cwd: f.cwd, title: '', pinned: true });
    if (mode === 'closed') f.session.closed = true;
    if (mode === 'provider') f.session.provider = 'claude';
    if (mode === 'directory') f.session.cwd = f.other;
    if (mode === 'subagent') f.session.isSubagent = true;
    if (mode === 'pending') f.session.creationPending = true;
    f.respond(async input => { assert.deepEqual(JSON.parse(input.prompt).candidates, []); return resume(f.session.id); });
    const job = await f.manager.submit(request(f.cwd));
    assert.equal((await f.finished(job.id)).status, 'error'); assert.equal(f.dispatches.length, 0);
  });
});

test('state changes after model selection and during asynchronous run preparation prevent dispatch', async t => {
  for (const mode of ['closed', 'context', 'nativeId', 'provider', 'admission'] as const) await t.test(mode, async t => {
    const f = await fixture(t);
    f.respond(async () => {
      if (mode === 'closed') f.session.closed = true;
      if (mode === 'context') f.session.contextUsage!.usedPercent = 80;
      if (mode === 'nativeId') f.session.nativeId = randomUUID();
      if (mode === 'provider') f.current.providers[0].available = false;
      return resume(f.session.id, 'adjacent');
    });
    if (mode === 'admission') f.beforeAdmission(async () => { f.session.status = 'working'; });
    const accepted = await f.manager.submit(request(f.cwd));
    const job = await f.finished(accepted.id);
    assert.equal(job.status, 'error'); assert.match(job.error!, mode === 'provider' ? /사용할 수 없습니다/ : /변경/);
    assert.equal(f.dispatches.length, 0);
  });
});

test('identical concurrent request IDs share admission and a different payload is rejected', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.respond(async () => { await gate; return resume(f.session.id); });
  const input = request(f.cwd);
  const [first, second] = await Promise.all([f.manager.submit(input), f.manager.submit(structuredClone(input))]);
  assert.equal(first.id, second.id);
  await assert.rejects(f.manager.submit({ ...input, prompt: 'Different request' }), { statusCode: 409 });
  release(); await f.finished(first.id);
  const repeated = await f.manager.submit(input);
  assert.equal(repeated.runId, f.managed[0].id);
  assert.equal(f.calls.length, 1); assert.equal(f.dispatches.length, 1);
  assert.equal((await stat(join(f.directory, 'auto-prompts.json'))).mode & 0o777, 0o600);
});

test('a duplicate cannot acknowledge a job while its original durable admission is still pending', async t => {
  const f = await fixture(t);
  let failWrite!: (error: Error) => void;
  // Hold the real persistence queue to reproduce an fsync/rename that has not
  // resolved. No request may be acknowledged solely from the in-memory record.
  (f.manager as unknown as { writes: Promise<void> }).writes = new Promise((_, reject) => { failWrite = reject; });
  const input = request(f.cwd);
  const first = f.manager.submit(input).then(value => ({ value }), error => ({ error }));
  await until(() => f.manager.get(input.requestId));
  let duplicateResolved = false;
  const duplicate = f.manager.submit(input).then(value => { duplicateResolved = true; return { value }; }, error => { duplicateResolved = true; return { error }; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(duplicateResolved, false);
  failWrite(new Error('Synthetic storage failure'));
  assert.ok('error' in await first); assert.ok('error' in await duplicate);
  assert.equal(f.manager.get(input.requestId), undefined);
  assert.equal(f.calls.length, 0); assert.equal(f.dispatches.length, 0);
});

test('sequential routing sees the earlier admitted task in the next session context', async t => {
  const f = await fixture(t);
  f.respond(async input => {
    const state = JSON.parse(input.prompt);
    if (state.request.prompt === 'Second') assert.equal(state.candidates[0].pendingTasks[0].prompt, 'First');
    return resume(f.session.id);
  });
  const first = await f.manager.submit(request(f.cwd, { prompt: 'First' }));
  const second = await f.manager.submit(request(f.cwd, { prompt: 'Second' }));
  await Promise.all([f.finished(first.id), f.finished(second.id)]);
  assert.deepEqual(f.dispatches.map(dispatch => dispatch.input.prompt), ['First', 'Second']);
});

test('restarting reconciles persisted dispatch correlation and never reroutes incomplete jobs', async t => {
  const f = await fixture(t);
  await f.manager.close();
  const input = request(f.cwd);
  const other = request(f.cwd);
  const stored = [input, other].map(input => ({ fingerprint: createHash('sha256').update(JSON.stringify({ provider: input.provider, cwd: input.cwd, prompt: input.prompt, attachments: [] })).digest('hex'),
    staged: [], job: { id: input.requestId, provider: input.provider, cwd: input.cwd, prompt: input.prompt, routerModel: 'gpt-5.6-sol', status: 'dispatching', createdAt: f.session.createdAt, updatedAt: f.session.updatedAt } }));
  await writeFile(join(f.directory, 'auto-prompts.json'), JSON.stringify(stored));
  f.managed.push({ id: randomUUID(), sessionId: f.session.id, prompt: input.prompt, status: 'queued', output: '', createdAt: f.session.updatedAt, autoPromptId: input.requestId });
  const restarted = new AutoPromptManager(f.options); await restarted.start();
  assert.equal(restarted.get(input.requestId)?.runId, f.managed[0].id);
  assert.equal(restarted.get(other.requestId)?.status, 'error');
  assert.equal((await restarted.submit(input)).status, 'completed');
  assert.equal(f.calls.length, 0); assert.equal(f.dispatches.length, 0);
  await restarted.close();
});

test('attachments are staged privately, described to the router, transferred intact, and cleaned', async t => {
  const f = await fixture(t);
  const attachments: AttachmentInput[] = [{ name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('Editor design notes').toString('base64') }];
  f.respond(async input => {
    const state = JSON.parse(input.prompt);
    assert.equal(state.request.attachments[0].excerpt, 'Editor design notes');
    assert.equal(state.request.attachments[0].data, undefined);
    return create();
  });
  const job = await f.manager.submit(request(f.cwd, { prompt: '', attachments }));
  assert.deepEqual(job.attachments, [{ name: 'notes.txt', mimeType: 'text/plain', size: 19 }]);
  assert.equal((await f.finished(job.id)).status, 'completed');
  assert.deepEqual(f.dispatches[0].input.attachments, attachments);
  assert.equal(f.dispatches[0].input.prompt, '');
  await f.manager.close();
  assert.deepEqual(await readdir(join(f.directory, 'auto-prompt-staging', 'attachments')), []);
  const saved = await readFile(join(f.directory, 'auto-prompts.json'), 'utf8');
  assert.ok(!saved.includes(attachments[0].data));
});

test('cancel aborts routing, clears staged uploads, and never dispatches a queued request', async t => {
  const f = await fixture(t);
  f.respond(input => new Promise((_, reject) => {
    input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const first = await f.manager.submit(request(f.cwd));
  await until(() => f.calls.length ? true : undefined);
  const second = await f.manager.submit(request(f.cwd, { attachments: [{ name: 'a.txt', mimeType: 'text/plain', data: 'YQ==' }] }));
  assert.equal((await f.manager.cancel(second.id)).status, 'cancelled');
  assert.equal((await f.manager.cancel(first.id)).status, 'cancelled');
  await f.manager.close();
  assert.equal(f.dispatches.length, 0);
  assert.deepEqual(await readdir(join(f.directory, 'auto-prompt-staging', 'attachments')), []);
});

test('dispatch claims cancellation before an asynchronous run admission can start', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let preparing = false;
  f.beforeAdmission(async () => { preparing = true; await gate; });
  const accepted = await f.manager.submit(request(f.cwd));
  await until(() => preparing ? true : undefined);
  assert.equal(f.manager.get(accepted.id)?.status, 'dispatching');
  await assert.rejects(f.manager.cancel(accepted.id), { statusCode: 409 });
  release(); assert.equal((await f.finished(accepted.id)).status, 'completed');
  assert.equal(f.dispatches.length, 1);
});

test('ambiguous folders, invalid decisions, and inconsistent new-task resume decisions never execute', async t => {
  for (const answer of [null, 'not JSON', { ...resume(`codex:${nativeId}`), relation: 'new' }, { ...create(), sessionId: `codex:${nativeId}` }]) await t.test(JSON.stringify(answer), async t => {
    const f = await fixture(t); f.respond(async () => answer);
    const accepted = await f.manager.submit(request(f.cwd));
    assert.equal((await f.finished(accepted.id)).status, 'error'); assert.equal(f.dispatches.length, 0);
  });
  const f = await fixture(t); f.respond(async () => ({ directoryId: null, reason: 'Unknown project.' }));
  const accepted = await f.manager.submit(request());
  assert.equal((await f.finished(accepted.id)).status, 'error'); assert.equal(f.dispatches.length, 0);
  await assert.rejects(f.manager.submit(request(f.directory)), /목록/);
});

test('unavailable provider or explicitly unavailable Sol model rejects before routing', async t => {
  const f = await fixture(t);
  f.current.providers[0].available = false;
  const unavailable = request(f.cwd);
  await assert.rejects(f.manager.submit(unavailable), { statusCode: 422 });
  assert.equal(f.manager.get(unavailable.requestId), undefined, 'the rejection must allow editing an unaccepted draft');
  f.current.providers[0].available = true;
  f.current.providers[0].models = [{ id: 'other-model', label: 'Other' }];
  const unsupported = request(f.cwd);
  await assert.rejects(f.manager.submit(unsupported), { statusCode: 422, message: '선택한 Codex 계정에서 라우팅 모델 GPT Sol을 사용할 수 없습니다.' });
  assert.equal(f.manager.get(unsupported.requestId), undefined);
  assert.equal(f.calls.length, 0);
  f.respond(async () => create());
  const revised = await f.manager.submit({ ...unsupported, provider: 'claude' });
  assert.equal((await f.finished(revised.id)).status, 'completed', 'an unaccepted request can select an available provider');
});
