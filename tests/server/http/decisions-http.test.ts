import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteAuthFixture } from '../../helpers/auth.js';
import { createMonitorServer, type HttpOptions } from '../../../server/http/server.js';
import { parseAutoPrompt, parseAutoPromptSuggestion } from '../../../server/http/requests.js';
import type { AutoPromptSuggestionRequest, DecisionOverview } from '../../../shared/decisions.js';
import type { Snapshot } from '../../../shared/types.js';

const requestId = '95257141-1ee4-4438-8374-c5507b156cd7';
const prompt = 'Add a dark mode toggle to the settings page';
const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'here', version: 't', updatedAt: '' };
const overview: DecisionOverview = { provider: 'jev', label: 'Jev', configured: true, keyHint: '…1234', features: { autoPromptSuggestions: true, attentionNotifications: true }, providers: [{ id: 'jev', label: 'Jev' }] };

test('an Auto Prompt may name a new conversation or one to continue, always with its folder', () => {
  assert.deepEqual(parseAutoPrompt({ requestId, provider: 'claude', prompt, cwd: '/work', sessionMode: 'new' }), { requestId, provider: 'claude', prompt, cwd: '/work', sessionMode: 'new' });
  assert.deepEqual(parseAutoPrompt({ requestId, provider: 'claude', prompt, cwd: '/work', targetSessionId: 'claude:abc' }), { requestId, provider: 'claude', prompt, cwd: '/work', targetSessionId: 'claude:abc' });
  for (const body of [
    { sessionMode: 'new' }, { sessionMode: 'old', cwd: '/work' }, { targetSessionId: 'claude:abc' },
    { targetSessionId: 'claude:abc', cwd: '/work', sessionMode: 'new' }, { targetSessionId: '', cwd: '/work' }, { targetSessionId: 'a\u0000b', cwd: '/work' },
    { routingContext: 'set by Tower only', cwd: '/work' },
  ]) assert.throws(() => parseAutoPrompt({ requestId, provider: 'claude', prompt, ...body }), { statusCode: 400 }, JSON.stringify(body));
});

test('a suggestion needs a draft of 30 characters and names nothing but the draft, tool, folder and computer', () => {
  assert.deepEqual(parseAutoPromptSuggestion({ prompt, provider: 'codex', cwd: '/work', node: 'a'.repeat(32) }), { prompt, provider: 'codex', cwd: '/work', node: 'a'.repeat(32) });
  for (const body of [{ prompt: `  ${'x'.repeat(29)}  `, provider: 'claude' }, { prompt, provider: 'other' }, { prompt, provider: 'claude', cwd: 'relative' },
    { prompt, provider: 'claude', node: 'short' }, { prompt, provider: 'claude', sessionId: 'x' }]) assert.throws(() => parseAutoPromptSuggestion(body), { statusCode: 400 }, JSON.stringify(body));
});

async function serve(t: test.TestContext, options: Partial<HttpOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-decisions-http-'));
  const { auth, origins, cookie, fetch } = await createRemoteAuthFixture(dir);
  const { server, dispose } = createMonitorServer({ port: 0, clientDir: dir, auth, remote: { origins },
    backend: { snapshot: () => snapshot, detail: async () => undefined, enqueue: async () => { throw new Error('unused'); }, cancel: async () => {}, subscribe: () => () => {} }, ...options });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const post = (path: string, body: unknown, headers: Record<string, string> = { cookie, 'X-Agent-Monitor-Token': token }) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, cookie, token, fetch, post };
}

test('fast judgment settings need a signed-in page and its token, and a key check sends nothing of the owner', async t => {
  const calls: unknown[] = [];
  const { base, cookie, fetch, post } = await serve(t, { decisions: {
    overview: () => overview, update: async body => { calls.push(['update', body]); return overview; }, test: async () => { calls.push(['test']); return overview; },
    suggestAutoPrompt: async () => ({ available: false }),
  } });
  assert.equal((await fetch(`${base}/api/decisions`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/api/decisions`, { headers: { cookie } })).json(), overview);
  assert.equal((await post('/api/decisions/settings', { apiKey: 'k' }, { cookie })).status, 403);
  assert.equal((await post('/api/decisions/settings', { apiKey: 'tsk-abcdefgh1234' })).status, 200);
  assert.equal((await post('/api/decisions/test', { anything: true })).status, 400);
  assert.equal((await post('/api/decisions/test', {})).status, 200);
  assert.deepEqual(calls, [['update', { apiKey: 'tsk-abcdefgh1234' }], ['test']]);
});

test('suggestions follow typing on their own budget, never the budget for changes', async t => {
  const asked: AutoPromptSuggestionRequest[] = [];
  const { post } = await serve(t, { decisions: {
    overview: () => overview, update: async () => overview, test: async () => overview,
    suggestAutoPrompt: async (input, load) => { asked.push(input); assert.equal((await load()).hostname, 'here'); return { available: true, label: 'Jev', suggestion: null }; },
  } });
  // Well past the 30 changes a minute everything else may make.
  for (let index = 0; index < 45; index++) assert.equal((await post('/api/auto-prompt-suggestions', { prompt, provider: 'claude' })).status, 200);
  assert.equal(asked.length, 45);
  assert.equal((await post('/api/groups', { cwd: '/work', title: 'x' })).status, 503, 'changes still have their full budget');
  const statuses = [];
  for (let index = 0; index < 20; index++) statuses.push((await post('/api/auto-prompt-suggestions', { prompt, provider: 'claude' })).status);
  assert.ok(statuses.includes(429), 'suggestions have a limit of their own');
  assert.equal((await post('/api/auto-prompt-suggestions', { prompt: 'short', provider: 'claude' })).status, 400);
});

test('without fast judgments the page learns suggestions are off, and an unknown computer is refused', async t => {
  const { post } = await serve(t);
  assert.deepEqual(await (await post('/api/auto-prompt-suggestions', { prompt, provider: 'claude' })).json(), { available: false });
  const withDecisions = await serve(t, { decisions: { overview: () => overview, update: async () => overview, test: async () => overview, suggestAutoPrompt: async () => ({ available: false }) } });
  assert.equal((await withDecisions.post('/api/auto-prompt-suggestions', { prompt, provider: 'claude', node: 'a'.repeat(32) })).status, 404);
});
