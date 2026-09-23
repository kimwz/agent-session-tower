import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SessionService } from '../../../server/sessions/service.js';

const id = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-01-01T00:00:00.000Z';
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const codexUsage = (used: number, window = 100_000) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
  total_token_usage: { total_tokens: 9_000_000 }, last_token_usage: { total_tokens: used }, model_context_window: window,
} } });
const claudeUsage = (input = 10, written = 20, read = 30, model = 'claude-opus-5') => ({ type: 'assistant', sessionId: id, timestamp,
  message: { model, role: 'assistant', content: [{ type: 'text', text: 'Finished.' }], stop_reason: 'end_turn',
    usage: { input_tokens: input, cache_creation_input_tokens: written, cache_read_input_tokens: read, output_tokens: 50_000 } } });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-context-'));
  const codexHome = join(directory, 'codex'); const claudeHome = join(directory, 'claude');
  await Promise.all([mkdir(join(codexHome, 'sessions'), { recursive: true }), mkdir(join(claudeHome, 'projects', 'test'), { recursive: true })]);
  const codex = join(codexHome, 'sessions', `rollout-${id}.jsonl`);
  const claude = join(claudeHome, 'projects', 'test', `${id}.jsonl`);
  const service = new SessionService({ codexHome, claudeHome, inspectProcesses: async () => ({ claude: new Map(), codex: new Set(), providerRunning: { codex: false, claude: false } }) });
  t.after(async () => { service.stop(); await rm(directory, { recursive: true, force: true }); });
  return { service, codex, claude };
}

test('Codex tracks the latest context usage instead of cumulative billing and handles zero and quota-only updates', async t => {
  const f = await fixture(t);
  await writeFile(f.codex, lines({ type: 'session_meta', timestamp, payload: { id, cwd: '/work' } }, codexUsage(30_000)));
  await f.service.refresh();
  assert.deepEqual(f.service.get(`codex:${id}`)?.contextUsage, { usedTokens: 30_000, contextWindow: 100_000, usedPercent: 30, updatedAt: timestamp });
  await appendFile(f.codex, lines({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: null } }));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${id}`)?.contextUsage?.usedPercent, 30);
  await appendFile(f.codex, lines(codexUsage(0)));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${id}`)?.contextUsage?.usedPercent, 0);
  await appendFile(f.codex, lines(codexUsage(30_001)));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${id}`)?.contextUsage?.usedPercent, 30.001);
});

test('missing or invalid native capacity never invents a context percentage', async t => {
  const f = await fixture(t);
  await writeFile(f.codex, lines({ type: 'session_meta', timestamp, payload: { id, cwd: '/work' } }, codexUsage(100, 0)));
  await f.service.refresh();
  assert.deepEqual(f.service.get(`codex:${id}`)?.contextUsage, { usedTokens: 100, updatedAt: timestamp });
  await appendFile(f.codex, lines(codexUsage(-1), codexUsage(Number.MAX_SAFE_INTEGER + 1)));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${id}`)?.contextUsage?.usedTokens, 100);
});

test('Claude counts current input and cache once and keeps model-default estimates labeled across updates', async t => {
  const f = await fixture(t);
  await writeFile(f.claude, lines({ type: 'user', sessionId: id, cwd: '/work', timestamp, message: { role: 'user', content: 'Fix the editor' } }, claudeUsage(2, 919, 444_460), claudeUsage(2, 919, 444_460)));
  await f.service.refresh();
  assert.deepEqual(f.service.get(`claude:${id}`)?.contextUsage, { usedTokens: 445_381, updatedAt: timestamp,
    contextWindow: 1_000_000, usedPercent: 44.5381, capacitySource: 'model-default' });
  await appendFile(f.claude, lines(claudeUsage(1, 0, 20)));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.usedTokens, 21);
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.capacitySource, 'model-default');
  await appendFile(f.claude, lines(claudeUsage(0, 0, 0, '<synthetic>')));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.usedTokens, 21);
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.capacitySource, 'model-default');
});

test('compaction, model changes, and transcript rewrites discard stale context observations', async t => {
  const f = await fixture(t);
  const meta = { type: 'session_meta', timestamp, payload: { id, cwd: '/work' } };
  await writeFile(f.codex, lines(meta, { type: 'turn_context', timestamp, payload: { model: 'model-a' } }, codexUsage(10)));
  await f.service.refresh();
  await appendFile(f.codex, lines({ type: 'turn_context', timestamp, payload: { model: 'model-b' } }));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${id}`)?.contextUsage, undefined);
  await appendFile(f.codex, lines(codexUsage(5), { type: 'compacted', timestamp, payload: {} }));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${id}`)?.contextUsage, undefined);
  await writeFile(f.codex, lines(meta, codexUsage(1)));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${id}`)?.contextUsage?.usedTokens, 1);
  await writeFile(f.claude, lines(claudeUsage(), { type: 'system', subtype: 'compact_boundary', timestamp }));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage, undefined);
});

test('copied Codex parent usage does not become a child context observation', async t => {
  const f = await fixture(t);
  await writeFile(f.codex, lines({ type: 'session_meta', timestamp, payload: { id: child, cwd: '/work', source: { subagent: { thread_spawn: { parent_thread_id: id } } }, subagent_history_start_ordinal: 2 } }, codexUsage(90_000)));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${child}`)?.contextUsage, undefined);
  await appendFile(f.codex, lines(codexUsage(100)));
  await f.service.refresh();
  assert.equal(f.service.get(`codex:${child}`)?.contextUsage?.usedTokens, 100);
});

test('native Claude result capacity reported under a [1m] variant key applies to the bare message model', async t => {
  const f = await fixture(t);
  await writeFile(f.claude, lines(claudeUsage(10, 20, 30), { type: 'result', timestamp, modelUsage: { 'claude-opus-5[1m]': { contextWindow: 1_000_000 } } }));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.usedPercent, 0.006);
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.capacitySource, undefined);
});

test('explicit native Claude result capacity is model-specific and is invalidated when the model changes', async t => {
  const f = await fixture(t);
  await writeFile(f.claude, lines(claudeUsage(10, 20, 30), { type: 'result', timestamp, modelUsage: { 'claude-opus-5': { contextWindow: 1_000_000 } } }));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.usedPercent, 0.006);
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.capacitySource, undefined);
  await appendFile(f.claude, lines(claudeUsage(20, 0, 0)));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.usedPercent, 0.002);
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.capacitySource, undefined);
  await appendFile(f.claude, lines(claudeUsage(10, 0, 0, 'claude-another')));
  await f.service.refresh();
  assert.deepEqual(f.service.get(`claude:${id}`)?.contextUsage, { usedTokens: 10, updatedAt: timestamp });
});

test('only exact verified Claude model IDs receive default estimates, including observed zero', async t => {
  const f = await fixture(t);
  for (const model of ['claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-opus-5-5']) {
    await writeFile(f.claude, lines(claudeUsage(0, 0, 0, model)));
    await f.service.refresh();
    assert.deepEqual(f.service.get(`claude:${id}`)?.contextUsage, {
      usedTokens: 0, updatedAt: timestamp, contextWindow: 1_000_000, usedPercent: 0, capacitySource: 'model-default',
    });
  }
  for (const model of ['opus', 'claude-opus-5-custom', 'claude-opus-5[1m]', 'provider/claude-opus-5', 'unknown-model']) {
    await writeFile(f.claude, lines(claudeUsage(100, 0, 0, model)));
    await f.service.refresh();
    assert.deepEqual(f.service.get(`claude:${id}`)?.contextUsage, { usedTokens: 100, updatedAt: timestamp });
  }
});

test('native capacity overrides a different default and a model switch does not inherit it', async t => {
  const f = await fixture(t);
  await writeFile(f.claude, lines(claudeUsage(100, 0, 0), { type: 'result', timestamp, modelUsage: { 'claude-opus-5': { contextWindow: 200_000 } } }));
  await f.service.refresh();
  assert.deepEqual(f.service.get(`claude:${id}`)?.contextUsage, { usedTokens: 100, updatedAt: timestamp, contextWindow: 200_000, usedPercent: 0.05 });
  await appendFile(f.claude, lines(claudeUsage(100, 0, 0, 'claude-fable-5')));
  await f.service.refresh();
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.contextWindow, 1_000_000);
  assert.equal(f.service.get(`claude:${id}`)?.contextUsage?.capacitySource, 'model-default');
});
