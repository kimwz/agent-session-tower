import test from 'node:test';
import assert from 'node:assert/strict';
import { autoPromptSuggestionResponse, suggestAutoPromptTarget } from '../../../server/auto-prompt/suggestion.js';
import { DecisionError, type ChoiceAnswer, type DecisionEngine, type DecisionQuestion, type DecisionRequest } from '../../../server/decisions/engine.js';
import type { Session, Snapshot } from '../../../shared/types.js';

const at = (hours: number) => new Date(Date.parse('2026-09-26T12:00:00Z') - hours * 3_600_000).toISOString();
const session = (id: string, cwd: string, values: Partial<Session> = {}): Session => ({ id: `claude:${id}`, nativeId: id, provider: 'claude', cwd, project: 'p', title: `Work ${id}`,
  status: 'idle', statusReason: '', createdAt: at(10), updatedAt: at(1), lastMessage: `Last of ${id}`, messageCount: 2, isSubagent: false, resumable: true, ...values });
const UUID = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`;
const snapshot = (sessions: Session[], groups: Snapshot['groups'] = []): Snapshot => ({ sessions, runs: [], providers: [], scanning: false, updatedAt: at(0), hostname: 'h', version: 't', groups });
const prompt = 'Add a dark mode toggle to the settings page of the web app';

/** Answers each question with the option `pick` names and records what was asked. */
function engine(pick: (key: string, question: DecisionQuestion) => string) {
  const asked: Array<DecisionRequest<Record<string, DecisionQuestion>>> = [];
  const value: DecisionEngine = { provider: 'jev', label: 'Jev', decide: async request => {
    asked.push(request as DecisionRequest<Record<string, DecisionQuestion>>);
    return Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
      const choice = pick(key, question);
      const options = Object.keys((question as { options: Record<string, string> }).options);
      return [key, { choice, confidence: 0.9, probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 0.9 : 0.1 / (options.length - 1)])) } satisfies ChoiceAnswer];
    })) as never;
  } };
  return { engine: value, asked };
}
const optionFor = (question: DecisionQuestion, text: string) => Object.entries((question as { options: Record<string, string> }).options).find(([, description]) => description.includes(text))![0];

test('a draft is placed in a project and then in a conversation to continue there', async () => {
  const state = snapshot([session(UUID(1), '/work/web', { title: 'Settings page layout' }), session(UUID(2), '/work/api', { title: 'Invoice export' })]);
  const { engine: jev, asked } = engine((key, question) => key === 'project' ? optionFor(question, '/work/web') : optionFor(question, 'Settings page layout'));
  const suggestion = await suggestAutoPromptTarget(jev, async () => state, { prompt, provider: 'claude' }, { now: Date.parse(at(0)) });
  assert.deepEqual(suggestion, { cwd: '/work/web', project: 'web', sessionId: `claude:${UUID(1)}`, sessionTitle: 'Settings page layout', projectConfidence: 0.9, sessionConfidence: 0.9 });
  assert.equal(asked.length, 2);
  assert.deepEqual(Object.keys(asked[0].questions), ['project']);
  assert.ok('none' in (asked[0].questions.project as { options: object }).options);
  assert.ok('new' in (asked[1].questions.conversation as { options: object }).options);
  assert.match(JSON.stringify(asked[0].state), /dark mode toggle/);
});

test('no fitting project gives no suggestion, and a new task gets a new conversation', async () => {
  const state = snapshot([session(UUID(1), '/work/web')]);
  assert.equal(await suggestAutoPromptTarget(engine(() => 'none').engine, async () => state, { prompt, provider: 'claude' }), null);
  const fresh = await suggestAutoPromptTarget(engine((key, question) => key === 'project' ? optionFor(question, '/work/web') : 'new').engine, async () => state, { prompt, provider: 'claude' });
  assert.deepEqual(fresh, { cwd: '/work/web', project: 'web', sessionId: null, projectConfidence: 0.9, sessionConfidence: 0.9 });
});

test('a folder the owner already chose is not asked about again', async () => {
  const state = snapshot([session(UUID(1), '/work/web'), session(UUID(2), '/work/api')]);
  const { engine: jev, asked } = engine(() => 'new');
  const suggestion = await suggestAutoPromptTarget(jev, async () => state, { prompt, provider: 'claude', cwd: '/work/api' });
  assert.equal(suggestion?.cwd, '/work/api');
  assert.deepEqual(asked.map(request => Object.keys(request.questions)[0]), ['conversation']);
  assert.equal(await suggestAutoPromptTarget(jev, async () => state, { prompt, provider: 'claude', cwd: '/elsewhere' }), null);
});

test('only conversations the router could continue are offered, and a folder without one gets a new conversation unasked', async () => {
  const cwd = '/work/web';
  const state = snapshot([
    session(UUID(1), cwd, { title: 'Offered' }),
    session(UUID(2), cwd, { provider: 'codex', id: `codex:${UUID(2)}`, title: 'Other tool' }),
    session(UUID(3), cwd, { closed: true, title: 'Closed' }),
    session(UUID(4), cwd, { isSubagent: true, title: 'Subagent' }),
    session(UUID(5), cwd, { launchedByAgent: true, title: 'Agent launched' }),
    session('not-a-uuid', cwd, { title: 'Unresumable id' }),
  ]);
  const { engine: jev, asked } = engine(() => 'new');
  await suggestAutoPromptTarget(jev, async () => state, { prompt, provider: 'claude', cwd });
  const offered = Object.values((asked[0].questions.conversation as { options: Record<string, string> }).options).join('\n');
  assert.match(offered, /Offered/);
  for (const hidden of ['Other tool', 'Closed', 'Subagent', 'Agent launched', 'Unresumable id']) assert.doesNotMatch(offered, new RegExp(hidden));
  const empty = engine(() => 'new');
  assert.deepEqual(await suggestAutoPromptTarget(empty.engine, async () => snapshot([], [{ cwd: '/work/pinned', title: 'Pinned', pinned: true }]), { prompt, provider: 'claude', cwd: '/work/pinned' }),
    { cwd: '/work/pinned', project: 'Pinned', sessionId: null, projectConfidence: 1, sessionConfidence: 1 });
  assert.equal(empty.asked.length, 0);
});

test('many projects fit in one question: at most 254 recent ones, with shorter descriptions', async () => {
  const sessions = Array.from({ length: 300 }, (_, index) => session(`${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, `/work/p${index}`, { updatedAt: at(index), lastMessage: 'x'.repeat(400) }));
  const { engine: jev, asked } = engine(() => 'none');
  await suggestAutoPromptTarget(jev, async () => snapshot(sessions), { prompt, provider: 'claude' });
  const options = (asked[0].questions.project as { options: Record<string, string> }).options;
  assert.equal(Object.keys(options).length, 255);
  assert.match(Object.values(options).join('\n'), /\/work\/p0\b/, 'the most recent project is kept');
  assert.doesNotMatch(Object.values(options).join('\n'), /\/work\/p299\b/, 'the oldest is left out');
  assert.ok(Object.values(options).join('').length <= 90_000);
});

test('state is read again before the second question, so a project gone meanwhile is not described', async () => {
  let reads = 0;
  const before = snapshot([session(UUID(1), '/work/web')]);
  const after = snapshot([]);
  const { engine: jev, asked } = engine((key, question) => optionFor(question, '/work/web'));
  assert.equal(await suggestAutoPromptTarget(jev, async () => (reads++ ? after : before), { prompt, provider: 'claude' }), null);
  assert.equal(reads, 2); assert.equal(asked.length, 1);
});

test('the page learns whether suggestions are on, and failures are named without details', async () => {
  const state = snapshot([session(UUID(1), '/work/web')]);
  assert.deepEqual(await autoPromptSuggestionResponse(undefined, async () => state, { prompt, provider: 'claude' }), { available: false });
  const failing = (kind: DecisionError['kind']): DecisionEngine => ({ provider: 'jev', label: 'Jev', decide: async () => { throw new DecisionError(kind, 'secret detail'); } });
  assert.deepEqual(await autoPromptSuggestionResponse(failing('unauthorized'), async () => state, { prompt, provider: 'claude' }), { available: true, label: 'Jev', suggestion: null, error: 'unauthorized' });
  assert.deepEqual(await autoPromptSuggestionResponse(failing('timeout'), async () => state, { prompt, provider: 'claude' }), { available: true, label: 'Jev', suggestion: null, error: 'unavailable' });
  assert.deepEqual(await autoPromptSuggestionResponse(engine(() => 'none').engine, async () => { throw new Error('link down'); }, { prompt, provider: 'claude' }), { available: true, label: 'Jev', suggestion: null, error: 'unavailable' });
});
