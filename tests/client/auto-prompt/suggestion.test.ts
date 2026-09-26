import test from 'node:test';
import assert from 'node:assert/strict';
import { SuggestionFeed, suggestionContext, suggestionKey, suggestionTarget, suggestionWait, type SuggestionInput } from '../../../client/src/auto-prompt/suggestion.js';
import type { AutoPromptSuggestionRequest, AutoPromptSuggestionResponse } from '../../../shared/decisions.js';
import { createAutoPromptAttempt } from '../../../client/src/auto-prompt/auto-prompt-request.js';
import { ApiError, type api } from '../../../client/src/common/lib.js';

const context = suggestionContext('claude', '', undefined);

test('a draft is worth a suggestion from 30 characters, and the same draft is never asked about twice', () => {
  assert.equal(suggestionKey(`  ${'가'.repeat(29)}  `, context), undefined);
  const key = suggestionKey('가'.repeat(30), context)!;
  assert.ok(key);
  assert.equal(suggestionKey(`${'가'.repeat(30)}\n`, context), key, 'surrounding spaces are not a change');
  assert.equal(suggestionWait(key, { inFlight: false }, 1_000), 0, 'the first one goes at once');
  assert.equal(suggestionWait(key, { requestedKey: key, startedAt: 0, inFlight: false }, 60_000), undefined);
});

test('at most one request goes out every 5 seconds while the text changes, and the latest text is always asked about', () => {
  const first = suggestionKey('Add a dark mode toggle to settings page', context);
  const second = suggestionKey('Add a dark mode toggle to settings page and profile', context);
  assert.equal(suggestionWait(second, { requestedKey: first, startedAt: 10_000, inFlight: false }, 12_000), 3_000);
  assert.equal(suggestionWait(second, { requestedKey: first, startedAt: 10_000, inFlight: false }, 16_000), 0);
  assert.equal(suggestionWait(second, { requestedKey: first, startedAt: 10_000, inFlight: true }, 16_000), undefined, 'one request at a time; the next waits for it');
});

test('another tool, folder or computer is another suggestion', () => {
  const text = 'Add a dark mode toggle to settings page';
  const keys = new Set([suggestionContext('claude', '', undefined), suggestionContext('codex', '', undefined), suggestionContext('claude', '/work', undefined), suggestionContext('claude', '', 'a'.repeat(32))].map(item => suggestionKey(text, item)));
  assert.equal(keys.size, 4);
});

test('an accepted suggestion sends the request straight to that conversation, or to a new one in that folder', () => {
  const base = { cwd: '/work/web', project: 'web', projectConfidence: 0.9, sessionConfidence: 0.8 };
  assert.deepEqual(suggestionTarget({ ...base, sessionId: 'claude:abc', sessionTitle: 'Settings' }), { cwd: '/work/web', targetSessionId: 'claude:abc' });
  assert.deepEqual(suggestionTarget({ ...base, sessionId: null }), { cwd: '/work/web', sessionMode: 'new' });
});

test('a request the server says it did not take can be written again at once, without a lookup', async () => {
  const calls: string[] = [];
  const requestApi: typeof api = async <T>(path: string, init?: RequestInit) => {
    calls.push(`${init?.method || 'GET'} ${path}`);
    throw new ApiError('실행 워커가 아직 업데이트되지 않아 추천한 곳으로 바로 보낼 수 없습니다.', 503, 'not-admitted');
  };
  const result = await createAutoPromptAttempt({ requestId: 'request-1', provider: 'claude', prompt: 'Continue', cwd: '/work', targetSessionId: 'claude:abc' }, requestApi).send('token');
  assert.equal('uncertain' in result && result.uncertain, false);
  assert.deepEqual(calls, ['POST /api/auto-prompts']);
});

test('the suggestion reads project › conversation, or project › new session, beside a checkbox that is on', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { SuggestionRow } = await import('../../../client/src/auto-prompt/AutoPromptDialog.js');
  const { setLanguage, getLanguage } = await import('../../../client/src/i18n/i18n.js');
  const previous = getLanguage();
  setLanguage('ko');
  try {
    const found = { cwd: '/work/web', project: 'web', projectConfidence: 0.9, sessionConfidence: 0.8 };
    const sessions = [{ id: 'claude:abc', nativeId: 'abc', provider: 'claude' as const, cwd: '/work/web', project: 'web', title: 'Settings page', status: 'idle' as const, statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true }];
    const row = (suggestion: object | null, accepted = true, extra: object = {}) => renderToStaticMarkup(createElement(SuggestionRow, { state: { context: 'c', label: 'Jev', suggestion, loading: false, ...extra } as never, accepted, disabled: false, machine: undefined, projects: new Map([['/work/web', 'Web App']]), sessions, onChange: () => {} }));
    const continued = row({ ...found, sessionId: 'claude:abc', sessionTitle: 'Old title' });
    assert.match(continued, /type="checkbox" checked=""/);
    assert.match(continued, /Jev 추천/);
    assert.match(continued, /<strong>Web App<\/strong>.*Settings page/);
    assert.match(row({ ...found, sessionId: null }), /<strong>Web App<\/strong>.*새 세션/);
    assert.match(row({ ...found, sessionId: null }, false), /auto-prompt-suggestion off/);
    assert.doesNotMatch(row(null), /checkbox/, 'nothing to accept without a suggestion');
    assert.match(row(null, true, { loading: true }), /Jev가 프로젝트와 세션을 찾고 있습니다/);
  } finally { setLanguage(previous); }
});

test('a request that may already have been taken is never released by a later refusal of a retry', async () => {
  const calls: string[] = [];
  let first = true;
  const requestApi: typeof api = async <T>(path: string, init?: RequestInit) => {
    calls.push(`${init?.method || 'GET'} ${path}`);
    if (init?.method === 'POST' && first) { first = false; throw new TypeError('connection reset'); }
    if (init?.method === 'POST') throw new ApiError('The joined computer is not reachable.', 503, 'not-admitted');
    throw new TypeError('lookup failed');
  };
  const attempt = createAutoPromptAttempt({ requestId: 'request-1', provider: 'claude', prompt: 'Continue', cwd: '/work', targetSessionId: 'claude:abc' }, requestApi, 'a'.repeat(32));
  assert.equal((await attempt.send('token') as { uncertain: boolean }).uncertain, true);
  assert.equal((await attempt.send('token') as { uncertain: boolean }).uncertain, true, 'still possibly taken: keep the same request');
  assert.equal(calls.filter(call => call.startsWith('GET')).length, 2, 'each retry looks the request up');
});

/** A feed with a hand-driven clock and answers the test releases one at a time. */
function feedHarness() {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const asked: Array<{ body: AutoPromptSuggestionRequest; signal: AbortSignal; answer: (response: AutoPromptSuggestionResponse) => void }> = [];
  let changes = 0;
  const feed = new SuggestionFeed((body, signal) => new Promise(resolve => { asked.push({ body, signal, answer: resolve }); }), () => { changes++; },
    { now: () => now, set: (run, ms) => { const id = ++nextTimer; timers.set(id, { at: now + ms, run }); return id; }, clear: id => { timers.delete(id as number); } });
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now) { timers.delete(id); timer.run(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  return { feed, asked, advance, changes: () => changes };
}
const input = (patch: Partial<SuggestionInput> = {}): SuggestionInput => ({ enabled: true, paused: false, draft: 1, prompt: 'Add a dark mode toggle to the settings page', provider: 'claude', cwd: '', machine: undefined, ...patch });
const found = (cwd: string): AutoPromptSuggestionResponse => ({ available: true, label: 'Jev', suggestion: { cwd, project: cwd, sessionId: null, projectConfidence: 1, sessionConfidence: 1 } });

test('the feed asks at once, then at most every 5 seconds, and always about the latest text', async () => {
  const { feed, asked, advance } = feedHarness();
  feed.update(input());
  await advance(0);
  assert.equal(asked.length, 1);
  asked[0].answer(found('/work/web'));
  await advance(0);
  assert.equal(feed.view(input())?.suggestion?.cwd, '/work/web');
  feed.update(input({ prompt: 'Add a dark mode toggle to the settings page, please' }));
  feed.update(input({ prompt: 'Add a dark mode toggle to the settings page, please and profile' }));
  await advance(4_000);
  assert.equal(asked.length, 1, 'not before 5 seconds');
  assert.equal(feed.view(input({ prompt: 'Add a dark mode toggle to the settings page, please and profile' }))?.suggestion?.cwd, '/work/web', 'the last suggestion stays while typing');
  await advance(1_000);
  assert.equal(asked.length, 2);
  assert.equal(asked[1].body.prompt, 'Add a dark mode toggle to the settings page, please and profile');
});

test('a new draft, another tool or a too-short draft starts over, and late answers for the old one are dropped', async () => {
  for (const change of [{ draft: 2 }, { provider: 'codex' as const }, { cwd: '/work/api' }, { machine: 'a'.repeat(32) }]) {
    const { feed, asked, advance } = feedHarness();
    feed.update(input());
    await advance(0);
    feed.update(input(change));
    assert.equal(asked[0].signal.aborted, true, JSON.stringify(change));
    asked[0].answer(found('/work/old'));
    await advance(0);
    assert.equal(feed.view(input(change))?.suggestion?.cwd, undefined, JSON.stringify(change));
    assert.equal(asked.length, 2, 'the new draft is asked about at once');
  }
  const { feed, asked, advance } = feedHarness();
  feed.update(input());
  await advance(0);
  asked[0].answer(found('/work/web'));
  await advance(0);
  feed.update(input({ prompt: 'short' }));
  assert.equal(feed.view(input({ prompt: 'short' })), undefined);
  feed.update(input());
  await advance(0);
  assert.equal(feed.view(input())?.suggestion, null, 'the earlier suggestion does not come back');
  assert.equal(asked.length, 2, 'the same text is asked about again');
});

test('while a request is being sent nothing is asked and what is shown does not change', async () => {
  const { feed, asked, advance } = feedHarness();
  feed.update(input());
  await advance(0);
  asked[0].answer(found('/work/web'));
  await advance(0);
  feed.update(input({ prompt: 'Add a dark mode toggle to the settings page and more' }));
  await advance(5_000);
  assert.equal(asked.length, 2);
  feed.update(input({ prompt: 'Add a dark mode toggle to the settings page and more', paused: true }));
  assert.equal(asked[1].signal.aborted, true);
  asked[1].answer(found('/work/other'));
  await advance(10_000);
  assert.equal(asked.length, 2);
  assert.equal(feed.view(input({ prompt: 'Add a dark mode toggle to the settings page and more', paused: true }))?.suggestion?.cwd, '/work/web');
  feed.update(input({ prompt: 'Add a dark mode toggle to the settings page and more' }));
  await advance(0);
  assert.equal(asked.length, 3, 'after sending failed, the draft is asked about again');
});

test('after a send that may have been taken, a refused retry whose lookup finds nothing still keeps the same request', async () => {
  let first = true;
  const requestApi: typeof api = async <T>(_path: string, init?: RequestInit) => {
    if (init?.method === 'POST' && first) { first = false; throw new TypeError('connection reset'); }
    if (init?.method === 'POST') throw new ApiError('요청이 너무 많습니다. 잠시 후 다시 시도하세요.', 429);
    throw new ApiError('Auto Prompt 요청을 찾을 수 없습니다.', 404);
  };
  const attempt = createAutoPromptAttempt({ requestId: 'request-1', provider: 'claude', prompt: 'Continue', cwd: '/work', sessionMode: 'new' }, requestApi);
  assert.equal((await attempt.send('token') as { uncertain: boolean }).uncertain, true);
  assert.equal((await attempt.send('token') as { uncertain: boolean }).uncertain, true);
});

test('a feed stopped by an effect cleanup works again when the effect runs again, as in React development mode', async () => {
  const { feed, asked, advance } = feedHarness();
  feed.update(input());
  feed.stop();
  assert.equal(asked.length, 0);
  feed.update(input());
  await advance(0);
  assert.equal(asked.length, 1);
  asked[0].answer(found('/work/web'));
  await advance(0);
  assert.equal(feed.view(input())?.suggestion?.cwd, '/work/web');
  feed.stop();
  assert.equal(asked[0].signal.aborted, false, 'an answered request has nothing to cancel');
  feed.update(input({ prompt: 'Add a dark mode toggle to the settings page and more' }));
  await advance(0);
  assert.equal(asked.length, 2);
  feed.stop();
  assert.equal(asked[1].signal.aborted, true, 'unmounting cancels what is out');
});
