import { RunAdmissionUncertain } from '../../../server/runs/run-records.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from '../../helpers/until.js';
import { SessionCompactions, continuationModel, continuedTitle, type SessionCompactionDependencies } from '../../../server/sessions/compaction/service.js';
import { PART_BYTES, excerpt, transcriptLines, transcriptParts } from '../../../server/sessions/compaction/transcript.js';
import { SUMMARY_CHARS, SUMMARY_SCHEMA, carriedSummary, parseSummary, renderSummary, startInstructions, visiblePrompt } from '../../../server/sessions/compaction/summary.js';
import { TOWER_INSTRUCTIONS } from '../../../server/sessions/parser.js';
import { outcomeMark } from '../../../server/sessions/outcomes.js';
import type { AutoPromptModelRequest } from '../../../server/auto-prompt/native.js';
import type { RunAdmission } from '../../../server/runs/manager.js';
import { saveModelSettings } from '../../../server/models/settings.js';
import { initialModelSettings } from '../../../shared/models.js';
import { TowerError } from '../../../shared/errors.js';
import type { ChatMessage, CreateSessionRequest, Run, Session } from '../../../shared/types.js';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 8, 0, minute)).toISOString();
const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, nativeId: id.split(':')[1], provider: 'claude', title: 'Voice fix', cwd: '/work/app', project: 'app',
  status: 'completed', statusReason: '', createdAt: at(0), updatedAt: at(9), lastMessage: 'Deployed 1.2.3.', messageCount: 4, isSubagent: false, resumable: true,
  model: 'claude-opus-5-5', effort: 'high', ...patch });
let ids = 0;
const message = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${ids++}`, role, text, timestamp: at(ids % 50), ...extra });
const SUMMARY = { goal: 'Fix the master voice', status: 'Fix deployed in 1.2.3', openWork: ['Confirm on iPhone'], ownerDirectives: ['Always answer in Korean'],
  decisions: ['Use streaming TTS because clips were slow'], references: ['PR #42', 'server/master/voice.ts'], nextSteps: ['Ask the owner to test'] };
const OWNER: RunAdmission = { origin: { kind: 'owner' } };

interface Setup {
  history?: ChatMessage[];
  answer?: (request: AutoPromptModelRequest, index: number) => unknown;
  deps?: Partial<SessionCompactionDependencies>;
  stateDir?: string;
  /** Conversations and turns there before the service loads. */
  seed?: { sessions?: Session[]; runs?: Run[] };
}
async function setup(t: test.TestContext, options: Setup = {}) {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), 'tower-compaction-'));
  const sessions = new Map<string, Session>([['claude:src', session('claude:src')]]);
  const runs: Run[] = [...options.seed?.runs ?? []];
  for (const item of options.seed?.sessions ?? []) sessions.set(item.id, item);
  const created: { input: CreateSessionRequest; admission: RunAdmission }[] = [];
  const requests: AutoPromptModelRequest[] = [];
  const reads: (number | undefined)[] = [];
  let history = options.history ?? [message('user', 'The master voice does not play'), message('assistant', 'Fixed and deployed 1.2.3.')];
  const dependencies: SessionCompactionDependencies = {
    stateDir, session: id => sessions.get(id), runs: () => runs,
    history: async (_session, before, limit) => {
      reads.push(before);
      const end = before ?? history.length;
      const start = Math.max(0, end - limit);
      return { messages: history.slice(start, end), hasMore: start > 0, ...(start > 0 ? { nextBefore: start } : {}) };
    },
    model: async request => { requests.push(request); return options.answer ? options.answer(request, requests.length - 1) : SUMMARY; },
    create: async (input, admission) => {
      await admission.refresh?.();
      admission.validate?.();
      const id = `claude:new-${created.length}`;
      created.push({ input, admission });
      const made = session(id, { title: input.prompt, customTitle: input.title, messageCount: 0, creationPending: true, model: undefined, effort: undefined });
      sessions.set(id, made);
      runs.push({ id: `run-${id}`, sessionId: id, prompt: input.prompt, status: 'queued', createdAt: new Date().toISOString(), output: '', ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(admission.instructions ? { instructions: admission.instructions } : {}) });
      return { session: made };
    },
    ...options.deps,
  };
  const service = new SessionCompactions(dependencies);
  await service.load();
  t.after(async () => { await service.close(); if (!options.stateDir) await rm(stateDir, { recursive: true, force: true }); });
  const settle = async (sessionId = 'claude:src') => { await until(() => !service.inFlight()); return service.get(sessionId)!; };
  return { stateDir, service, sessions, runs, created, requests, reads, settle, setHistory: (next: ChatMessage[]) => { history = next; }, dependencies };
}

test('the transcript keeps what the person and the agent said whole and excerpts tool output with a marker', () => {
  const long = `${'x'.repeat(130_000)}LAST-WORDS`;
  const lines = transcriptLines(message('user', long));
  assert.equal(lines.length, 3);
  assert.equal(lines.map(line => line.replace(/^\[[^\]]+\] User \(message part \d\/3\): /, '')).join(''), long, 'nothing of the message is lost');
  const output = `${'a'.repeat(5_000)}git push → https://github.com/o/r/pull/7`;
  const [result] = transcriptLines(message('tool', output, { toolName: 'result' }));
  assert.match(result, /characters omitted/);
  assert.match(result, /pull\/7$/, 'the end of tool output, where links usually are, is kept');
  const [call] = transcriptLines(message('tool', 'c'.repeat(3_000), { toolName: 'Bash' }));
  assert.ok(call.length < 2_100 && /omitted\]…$/.test(call), 'a call keeps only its start (no tail)');
  assert.equal(excerpt('short', { head: 10, tail: 0 }), 'short');
  assert.deepEqual(transcriptLines(message('assistant', '   ')), []);
  // Of Tower's hidden instructions only a compacted session's carried summary is read.
  const start = startInstructions({ title: 'Voice fix', id: 'claude:old' }, '## Goal\nCarried goal');
  assert.match(transcriptLines(message('system', start, { toolName: TOWER_INSTRUCTIONS })).join(''), /Summary carried from the session this conversation continues[^]*## Goal\nCarried goal$/);
  assert.deepEqual(transcriptLines(message('system', 'Browser tools for this turn …', { toolName: TOWER_INSTRUCTIONS })), []);
  assert.equal(carriedSummary(start), '## Goal\nCarried goal');
});

test('parts split between lines, keep the order, start with the first message and stay within the budget', () => {
  const messages = Array.from({ length: 60 }, (_, index) => message(index % 2 ? 'assistant' : 'user', `${index}:${'가'.repeat(9_000)}`));
  const parts = transcriptParts(messages);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(Buffer.byteLength(part) <= PART_BYTES);
  assert.match(parts[0], /User: 0:/, 'the beginning is never dropped');
  assert.match(parts.at(-1)!, /Agent: 59:/);
  const order = parts.join('\n\n').match(/: (\d+):/g)!.map(item => Number(item.slice(2, -1)));
  assert.deepEqual(order, Array.from({ length: 60 }, (_, index) => index));
});

test('a summary is checked and bounded, and the start of the new session carries it as a handoff', () => {
  assert.throws(() => parseSummary({ goal: '', status: '', openWork: [], ownerDirectives: [], decisions: [], references: [], nextSteps: [] }), /empty/);
  assert.throws(() => parseSummary('text'), /no summary/);
  const big = parseSummary({ ...SUMMARY, references: Array.from({ length: 100 }, (_, index) => `${index} https://example.com/${'r'.repeat(800)}`) });
  assert.equal(big.references.length, 100);
  assert.ok(big.references.every(item => item.endsWith('r'.repeat(10))), 'a long link is kept whole');
  assert.match(parseSummary({ ...SUMMARY, status: 's'.repeat(5_000) }).status, /…\(cut: 1,000 more characters\)$/, 'only a pasted wall of text is cut, visibly');
  const huge = renderSummary({ ...big, openWork: big.references, decisions: big.references, nextSteps: big.references, ownerDirectives: big.references });
  assert.ok(huge.length <= SUMMARY_CHARS);
  assert.match(huge, /more not kept/);
  assert.ok(huge.split('\n').filter(line => line.startsWith('- ') && !line.includes('more not kept')).every(line => line.endsWith('r'.repeat(10))), 'items are dropped whole, never cut');
  const markdown = renderSummary(parseSummary(SUMMARY));
  for (const text of ['## Goal', 'PR #42', 'Always answer in Korean', '## Next steps']) assert.ok(markdown.includes(text), text);
  const start = startInstructions({ title: 'Voice fix', id: 'claude:src' }, markdown);
  assert.match(start, /only a handoff: do not run commands/);
  assert.match(start, /<previous-session-summary>\n## Goal/);
  assert.match(visiblePrompt('Voice fix', '0123456789abcdef'), /「Voice fix」.*\(압축 01234567\)$/);
  assert.equal(continuedTitle('Voice fix (이어서)'), 'Voice fix (이어서)', 'marked once');
  assert.ok(continuedTitle('t'.repeat(200)).length <= 120);
  assert.deepEqual(SUMMARY_SCHEMA.required, ['goal', 'status', 'openWork', 'ownerDirectives', 'decisions', 'references', 'nextSteps']);
});

test('the new session runs with what the latest answer ran with: the native record, then the last request, then the CLI default', () => {
  const run = (patch: Partial<Run>): Run => ({ id: 'r', sessionId: 'claude:src', prompt: 'x', status: 'completed', createdAt: at(5), finishedAt: at(9), output: '', ...patch });
  assert.deepEqual(continuationModel(session('claude:src'), [run({ model: 'sonnet', effort: 'low' })]),
    { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', modelSource: 'observed', effortSource: 'observed' });
  assert.deepEqual(continuationModel(session('claude:src', { model: undefined, effort: undefined }), [run({ model: 'sonnet', effort: 'low', createdAt: at(1) }), run({ model: 'opus', effort: 'max', createdAt: at(3) })]),
    { provider: 'claude', model: 'opus', effort: 'max', modelSource: 'lastRun', effortSource: 'lastRun' });
  assert.deepEqual(continuationModel(session('claude:src', { model: undefined, effort: 'auto' }), []), { provider: 'claude', modelSource: 'default', effortSource: 'default' }, 'an effort Claude Code cannot take is not passed on');
  assert.deepEqual(continuationModel(session('codex:src', { provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }), []),
    { provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', modelSource: 'observed', effortSource: 'observed' });
  // Tower's request counts only while it is the conversation's latest: not after the owner went on elsewhere.
  const unknown = session('claude:src', { model: undefined, effort: undefined, lastRequestAt: at(10) });
  assert.deepEqual(continuationModel(unknown, [run({ model: 'opus', effort: 'max', finishedAt: at(6) })]), { provider: 'claude', modelSource: 'default', effortSource: 'default' });
  assert.deepEqual(continuationModel(unknown, [run({ model: 'opus', effort: 'max', finishedAt: at(11) })]), { provider: 'claude', model: 'opus', effort: 'max', modelSource: 'lastRun', effortSource: 'lastRun' });
  assert.deepEqual(continuationModel(unknown, [run({ model: 'opus', effort: 'max', finishedAt: at(11), status: 'cancelled' })]), { provider: 'claude', modelSource: 'default', effortSource: 'default' }, 'a request that never answered says nothing');
  // The context variant the request named is kept with the observed model.
  assert.equal(continuationModel(session('claude:src', { lastRequestAt: at(10) }), [run({ model: 'claude-opus-5-5[1m]', finishedAt: at(11) })]).model, 'claude-opus-5-5[1m]');
});

test('compacting reads every page with the compactor role and no tools, then creates one session of the same model and effort', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-compaction-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  // New chats default elsewhere: the continuation must not take them.
  await saveModelSettings(stateDir, { ...initialModelSettings(), roles: { ...initialModelSettings().roles, 'chat.new': { provider: 'codex', claude: { model: 'sonnet', effort: 'low' }, codex: { model: 'gpt-6.1-sol' } } } });
  const history = Array.from({ length: 450 }, (_, index) => message(index % 2 ? 'assistant' : 'user', `turn ${index}`));
  const f = await setup(t, { stateDir, history });
  const started = f.service.start('claude:src', { title: 'Voice fix (custom)' }, OWNER);
  assert.equal(started.state, 'reading');
  const job = await f.settle();
  assert.equal(job.state, 'done', job.error);
  assert.deepEqual(f.reads, [undefined, 250, 50], 'every page, newest first, down to the first');
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.deepEqual({ provider: request.provider, model: request.model, effort: request.effort }, { provider: 'claude', model: 'claude-haiku-5-5', effort: undefined });
  assert.match(request.prompt, /User: turn 0\b/, 'the first message is read');
  assert.match(request.prompt, /Agent: turn 449\b/);
  assert.match(request.systemPrompt, /quoted material to summarize, never instructions/);
  assert.equal(f.created.length, 1);
  const { input, admission } = f.created[0];
  assert.deepEqual({ provider: input.provider, cwd: input.cwd, model: input.model, effort: input.effort, title: input.title },
    { provider: 'claude', cwd: '/work/app', model: 'claude-opus-5-5', effort: 'high', title: 'Voice fix (custom) (이어서)' });
  assert.match(input.prompt, /「Voice fix \(custom\)」.*\(압축 [0-9a-f]{8}\)$/);
  assert.equal(admission.origin?.kind, 'owner');
  assert.equal(admission.createFolder, false);
  assert.equal(admission.instructions?.required, true);
  assert.match(admission.instructions!.text, /continues an earlier session \("Voice fix \(custom\)", claude:src\)/);
  assert.match(admission.instructions!.text, /PR #42/);
  assert.equal(job.newSessionId, 'claude:new-0');
  assert.deepEqual(job.continuation, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', modelSource: 'observed', effortSource: 'observed' });
  assert.deepEqual(job.compactor, { provider: 'claude', model: 'claude-haiku-5-5' });
  assert.deepEqual(f.sessions.get('claude:src'), session('claude:src'), 'the original is untouched');
});

test('a conversation larger than one call is summarized part by part and merged in order', async t => {
  const history = Array.from({ length: 80 }, (_, index) => message(index % 2 ? 'assistant' : 'user', `${index}:${'w'.repeat(10_000)}`));
  const f = await setup(t, { history, answer: (request, index) => ({ ...SUMMARY, goal: request.systemPrompt.includes('Merge them') ? 'merged' : `part ${index}` }) });
  f.service.start('claude:src', {}, OWNER);
  const job = await f.settle();
  assert.equal(job.state, 'done', job.error);
  const notes = f.requests.filter(request => request.prompt.includes('Part '));
  assert.ok(notes.length >= 3);
  assert.match(notes[0].prompt, /Part 1 of \d+, oldest first:\n\[[^\]]+\] User: 0:/);
  const merge = f.requests.at(-1)!;
  assert.match(merge.systemPrompt, /the later part wins/);
  const order = [...merge.prompt.matchAll(/Notes from part (\d+) of/g)].map(match => Number(match[1]));
  assert.deepEqual(order, Array.from({ length: notes.length }, (_, index) => index + 1));
  assert.match(f.created[0].admission.instructions!.text, /merged/);
});

test('a working, waiting or helper conversation is refused before anything is read', async t => {
  const f = await setup(t);
  const refuse = (patch: Partial<Session>, runs: Run[] = []) => {
    f.sessions.set('claude:src', session('claude:src', patch));
    f.runs.splice(0, f.runs.length, ...runs);
    assert.throws(() => f.service.start('claude:src', {}, OWNER), (error: unknown) => error instanceof TowerError && error.kind === 'conflict', JSON.stringify(patch));
  };
  refuse({ status: 'working' });
  refuse({ isSubagent: true });
  refuse({ launchedByAgent: true });
  refuse({ master: true });
  refuse({ resumable: false });
  refuse({ messageCount: 0 });
  const queued: Run = { id: 'q', sessionId: 'claude:src', prompt: 'later', status: 'queued', createdAt: at(1), output: '', scheduled: { at: at(30), afterRunId: 'x' } };
  refuse({}, [queued]);
  assert.throws(() => f.service.start('claude:missing', {}, OWNER), (error: unknown) => error instanceof TowerError && error.kind === 'not-found');
  assert.equal(f.requests.length, 0);
  assert.equal(f.created.length, 0);
});

test('a second click, a retried request and a finished compaction of the same conversation make no second session', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup(t, { answer: async () => { await gate; return SUMMARY; } });
  const first = f.service.start('claude:src', {}, OWNER);
  assert.equal(f.service.start('claude:src', {}, OWNER).id, first.id, 'while it runs');
  release();
  const done = await f.settle();
  assert.equal(done.state, 'done');
  assert.equal(f.service.start('claude:src', {}, OWNER).id, first.id, 'the conversation says the same: the same result');
  assert.equal(f.created.length, 1);
  assert.equal(f.requests.length, 1);
  // Once the conversation goes on, it is a new compaction.
  f.sessions.set('claude:src', session('claude:src', { messageCount: 6, lastMessage: 'More work.' }));
  const next = f.service.start('claude:src', {}, OWNER);
  assert.notEqual(next.id, first.id);
  await f.settle();
  assert.equal(f.created.length, 2);
});

test('the finished compaction is remembered across workers, so a retry after a handoff returns the same session', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-compaction-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const first = await setup(t, { stateDir });
  first.service.start('claude:src', {}, OWNER);
  const done = await first.settle();
  await first.service.close();
  const saved = JSON.parse(await readFile(join(stateDir, 'session-compactions.json'), 'utf8'));
  assert.equal(saved.sources['claude:src'].state, 'done');
  assert.deepEqual(Object.keys(saved), ['version', 'sources'], 'no summary is kept here: it travels with the new session');
  const second = await setup(t, { stateDir, seed: { sessions: [session('claude:new-0')] } });
  assert.deepEqual(second.service.get('claude:src'), { id: done.id, sessionId: 'claude:src', state: 'done', createdAt: saved.sources['claude:src'].at, updatedAt: saved.sources['claude:src'].at, newSessionId: 'claude:new-0' });
  assert.equal(second.service.start('claude:src', {}, OWNER).newSessionId, 'claude:new-0');
  assert.equal(second.created.length, 0);
});

test('an attempt a crash left unsettled is settled by its own turn when the worker starts, and never made again without it', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-compaction-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const attempt = { jobId: 'abcdef0123', revision: outcomeMark(session('claude:src')), at: at(20), state: 'creating', prompt: visiblePrompt('Voice fix', 'abcdef0123') };
  await writeFile(join(stateDir, 'session-compactions.json'), JSON.stringify({ version: 1, sources: { 'claude:src': attempt } }));
  // Not found: unknown whether a session was made, so none is made again for what the conversation says.
  const lost = await setup(t, { stateDir });
  assert.throws(() => lost.service.start('claude:src', {}, OWNER), (error: unknown) => error instanceof TowerError && error.disposition === 'not-admitted' && /확인할 수 없어/.test(error.message));
  assert.equal(lost.service.get('claude:src')?.state, 'failed');
  assert.equal(lost.created.length, 0);
  await lost.service.close();
  // Found when the next worker loads: the turn that names this compaction made that session.
  const found = await setup(t, { stateDir, seed: { sessions: [session('claude:made')], runs: [{ id: 'run-made', sessionId: 'claude:made', prompt: attempt.prompt, status: 'completed', createdAt: at(21), output: '' }] } });
  assert.equal(found.service.get('claude:src')?.newSessionId, 'claude:made');
  assert.equal(found.service.start('claude:src', {}, OWNER).newSessionId, 'claude:made');
  assert.equal(found.created.length, 0);
  await found.service.close();
  assert.equal(JSON.parse(await readFile(join(stateDir, 'session-compactions.json'), 'utf8')).sources['claude:src'].state, 'done', 'settled once, on disk');
});

test('a compacted session compacted again reads the summary it started with from its own first message', async t => {
  const start = startInstructions({ title: 'Voice fix', id: 'claude:old' }, '## Goal\nCarried goal\n\n## The person\'s standing instructions\n- Never deploy on Fridays');
  const f = await setup(t, { history: [message('user', '이전 세션의 요약을 이어받아…'), message('system', start, { toolName: TOWER_INSTRUCTIONS }), message('assistant', 'Taken over.')] });
  f.service.start('claude:src', {}, OWNER);
  await f.settle();
  assert.match(f.requests[0].prompt, /Summary carried from the session this conversation continues[^]*Never deploy on Fridays/);
  assert.doesNotMatch(f.requests[0].prompt, /only a handoff/, 'only the summary, not the rest of Tower\'s instructions');
});

test('a finished compaction whose session can no longer carry the work does not stop a new one', async t => {
  const f = await setup(t);
  f.service.start('claude:src', {}, OWNER);
  const first = await f.settle();
  f.sessions.set(first.newSessionId!, session(first.newSessionId!, { resumable: false }));
  const next = f.service.start('claude:src', {}, OWNER);
  assert.notEqual(next.id, first.id);
  await f.settle();
  assert.equal(f.created.length, 2);
});

test('a creation that fails after saving its session still ends with that session, and refusals say nothing was admitted', async t => {
  const made = await setup(t, { deps: { create: async (input, admission) => {
    admission.validate?.();
    made.sessions.set('claude:half', session('claude:half', { creationPending: true }));
    made.runs.push({ id: 'run-half', sessionId: 'claude:half', prompt: input.prompt, status: 'error', createdAt: new Date().toISOString(), output: '' });
    throw new Error('state could not be flushed');
  } } });
  made.service.start('claude:src', {}, OWNER);
  const job = await made.settle();
  assert.equal(job.state, 'done');
  assert.equal(job.newSessionId, 'claude:half');
  assert.equal(made.service.start('claude:src', {}, OWNER).id, job.id);

  const stateDir = await mkdtemp(join(tmpdir(), 'tower-compaction-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(join(stateDir, 'session-compactions.json'), '{not json');
  const unreadable = await setup(t, { stateDir });
  assert.throws(() => unreadable.service.start('claude:src', {}, OWNER), (error: unknown) => error instanceof TowerError && error.kind === 'unavailable' && error.disposition === 'not-admitted');
  assert.equal(await readFile(join(stateDir, 'session-compactions.json'), 'utf8'), '{not json', 'the unreadable file is left as it is');

  const held = await setup(t);
  held.service.hold();
  assert.throws(() => held.service.start('claude:src', {}, OWNER), (error: unknown) => error instanceof TowerError && error.disposition === 'not-admitted');
  held.service.release();
  held.service.start('claude:src', {}, OWNER);
  assert.equal((await held.settle()).state, 'done');

  const full = await setup(t, { deps: { maxFileBytes: 10 } });
  full.service.start('claude:src', {}, OWNER);
  const refused = await full.settle();
  assert.equal(refused.state, 'failed');
  assert.match(refused.error!, /너무 커서/);
  assert.equal(full.created.length, 0);
});

test('only a compaction creating its session holds a forced update', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup(t, { deps: { create: async (input, admission) => {
    await gate;
    admission.validate?.();
    const made = session('claude:late', { creationPending: true });
    f.sessions.set(made.id, made);
    f.runs.push({ id: 'run-late', sessionId: made.id, prompt: input.prompt, status: 'queued', createdAt: new Date().toISOString(), output: '' });
    return { session: made };
  } } });
  f.service.start('claude:src', {}, OWNER);
  assert.equal(f.service.creating(), false);
  assert.equal(f.service.inFlight(), true);
  await until(() => f.service.creating());
  release();
  await f.settle();
  assert.equal(f.service.creating(), false);
});

test('the conversation changing while it is summarized, or right before creation, makes no session', async t => {
  const changed = await setup(t, { answer: () => { changed.sessions.set('claude:src', session('claude:src', { messageCount: 5, lastMessage: 'New request' })); return SUMMARY; } });
  changed.service.start('claude:src', {}, OWNER);
  const job = await changed.settle();
  assert.equal(job.state, 'failed');
  assert.match(job.error!, /새 대화가 생겨/);
  assert.equal(changed.created.length, 0);

  // A message queued in the original after the last look, while the session is being created: refused at registration.
  const race = await setup(t, { deps: { create: async (_input, admission) => {
    race.runs.push({ id: 'late', sessionId: 'claude:src', prompt: 'late', status: 'queued', createdAt: at(30), output: '' });
    admission.validate?.();
    throw new Error('registered anyway');
  } } });
  race.service.start('claude:src', {}, OWNER);
  const raced = await race.settle();
  assert.equal(raced.state, 'failed');
  assert.match(raced.error!, /대기·예약된 요청/);
  const saved = JSON.parse(await readFile(join(race.stateDir, 'session-compactions.json'), 'utf8'));
  assert.deepEqual(saved.sources, {}, 'a creation refused before registration leaves no unsettled attempt');
});

test('cancelling stops before anything is created; a model failure leaves the original alone', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup(t, { answer: async (request) => { await new Promise((resolve, reject) => { request.signal.addEventListener('abort', () => reject(new Error('aborted'))); void gate.then(resolve); }); return SUMMARY; } });
  f.service.start('claude:src', {}, OWNER);
  await until(() => f.requests.length === 1);
  assert.equal(f.service.cancel('claude:src').state, 'cancelled');
  release();
  await f.settle();
  assert.equal(f.service.get('claude:src')?.state, 'cancelled');
  assert.equal(f.created.length, 0);

  const failing = await setup(t, { answer: () => { throw new Error('Auto Prompt: model_not_found'); } });
  failing.service.start('claude:src', {}, OWNER);
  const job = await failing.settle();
  assert.equal(job.state, 'failed');
  assert.match(job.error!, /압축 모델\(claude claude-haiku-5-5\) 호출이 실패했습니다: Auto Prompt: model_not_found/);
  assert.equal(failing.created.length, 0);
  assert.deepEqual(failing.sessions.get('claude:src'), session('claude:src'));
});

test("a controller's compaction looks at the sharing again before creating, and outside content stays marked", async t => {
  let excluded = false;
  const prepared: string[] = [];
  const remote = await setup(t, { deps: { remote: { prepare: async session => { prepared.push(session.cwd); excluded = true; }, visible: () => !excluded } } });
  remote.service.start('claude:src', {}, { origin: { kind: 'owner', controllerId: 'ctrl' }, requestId: 'r' });
  const job = await remote.settle();
  assert.equal(job.state, 'failed');
  assert.match(job.error!, /공유되지 않아/);
  assert.deepEqual(prepared, ['/work/app']);
  assert.equal(remote.created.length, 0);

  const shared = await setup(t, { deps: { remote: { prepare: async () => {}, visible: () => true } } });
  shared.service.start('claude:src', {}, { origin: { kind: 'owner', controllerId: 'ctrl' }, requestId: 'r' });
  assert.equal((await shared.settle()).state, 'done', 'a conversation still shared is compacted for a controller');
  const unknown = await setup(t);
  unknown.service.start('claude:src', {}, { origin: { kind: 'owner', controllerId: 'ctrl' }, requestId: 'r' });
  assert.equal((await unknown.settle()).state, 'failed', 'without a sharing rule nothing is created for a controller');
  const untrusted = await setup(t, { deps: { untrusted: () => true, refuse: () => undefined } });
  untrusted.service.start('claude:src', {}, OWNER);
  await untrusted.settle();
  assert.equal(untrusted.created[0].admission.untrustedInput, true);
  const coordinator = await setup(t, { deps: { refuse: () => 'Slack·GitHub 코디네이터 대화는 압축할 수 없습니다.' } });
  assert.throws(() => coordinator.service.start('claude:src', {}, OWNER), /코디네이터/);
});

test('reading stops as soon as the conversation outgrows the calls, before the rest is read', async t => {
  const big = Array.from({ length: 2_000 }, (_, index) => message(index % 2 ? 'assistant' : 'user', `${index} ${'z'.repeat(20_000)}`));
  const f = await setup(t, { history: big });
  f.service.start('claude:src', {}, OWNER);
  const job = await f.settle();
  assert.equal(job.state, 'failed');
  assert.match(job.error!, /너무 길어/);
  assert.ok(f.reads.length < 10, `stopped after ${f.reads.length} pages`);
  assert.equal(f.requests.length, 0);
});

test('a worker closing mid-compaction ends it without creating anything', async t => {
  const f = await setup(t, { answer: request => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  f.service.start('claude:src', {}, OWNER);
  await until(() => f.requests.length === 1);
  await f.service.close();
  const job = f.service.get('claude:src')!;
  assert.equal(job.state, 'failed');
  assert.match(job.error!, /실행 워커가 바뀌어/);
  assert.equal(f.created.length, 0);
  assert.throws(() => f.service.start('claude:src', {}, OWNER), /실행 워커를 바꾸는 중/);
});

test('a forced update stops a compaction still summarizing, and none can begin creating its session after', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup(t, { answer: async () => { await gate; return SUMMARY; } });
  f.service.start('claude:src', {}, OWNER);
  await until(() => f.requests.length === 1);
  f.service.hold();
  release();
  const job = await f.settle();
  assert.equal(job.state, 'failed');
  assert.match(job.error!, /업데이트로 압축을 멈췄습니다/);
  assert.equal(f.created.length, 0);
  assert.equal(f.service.creating(), false);
});

test("a controller's sharing is read again as the last wait before the session is registered", async t => {
  const order: string[] = [];
  const f = await setup(t, { deps: {
    remote: { prepare: async () => { order.push('prepare'); }, visible: () => { order.push('visible'); return true; } },
    create: async (input, admission) => { order.push('create'); await admission.refresh?.(); order.push('validate'); admission.validate?.(); const made = session('claude:ok'); f.sessions.set(made.id, made); return { session: made }; },
  } });
  f.service.start('claude:src', {}, { origin: { kind: 'owner', controllerId: 'ctrl' }, requestId: 'r' });
  assert.equal((await f.settle()).state, 'done');
  assert.deepEqual(order.slice(order.indexOf('create')), ['create', 'prepare', 'validate', 'visible']);
});

test("a finished compaction whose session cannot carry the work is not offered on the original's page", async t => {
  const f = await setup(t);
  f.service.start('claude:src', {}, OWNER);
  const done = await f.settle();
  assert.equal(f.service.get('claude:src')?.id, done.id);
  f.sessions.delete(done.newSessionId!);
  const shown = f.service.get('claude:src');
  assert.equal(shown?.state, 'failed', 'the page that follows it hears why, rather than nothing');
  assert.match(shown!.error!, /이어서 쓸 수 없습니다/);
});

test('a handoff pause stops compactions underway and is undone by resume alone; an intake hold stays until released', async t => {
  const f = await setup(t);
  f.service.hold();
  f.service.pause();
  f.service.resume();
  assert.throws(() => f.service.start('claude:src', {}, OWNER), /업데이트를 준비/, 'a failed handoff resumes the worker without lifting the forced update\'s hold');
  f.service.release();
  f.service.start('claude:src', {}, OWNER);
  assert.equal((await f.settle()).state, 'done');
});

test('unknown creation receipt preserves the compaction attempt and never infers success from a memory placeholder', async t => {
  const f = await setup(t), original = f.dependencies.create;
  f.dependencies.create = async (input,admission) => { await original(input,admission); throw new RunAdmissionUncertain('receipt unresolved',{ commandId: 'compaction-fixed-commit',sha256: 'a'.repeat(64) }); };
  f.service.start('claude:src',{},OWNER);
  assert.equal((await f.settle()).state,'failed');
  const saved = JSON.parse(await readFile(join(f.stateDir,'session-compactions.json'),'utf8'));
  assert.equal(saved.sources['claude:src'].state,'creating'); assert.equal(saved.sources['claude:src'].uncertain,true);
  const restarted = new SessionCompactions(f.dependencies); await restarted.load();
  assert.throws(() => restarted.start('claude:src',{},OWNER));
  assert.equal(restarted.get('claude:src')?.state,'failed'); assert.equal(f.created.length,1); await restarted.close();
});
