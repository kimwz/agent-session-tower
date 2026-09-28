import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import { parseMessages, towerInstructionsBlock } from '../../../server/sessions/parser.js';
import type { CodexStdioOptions } from '../../../server/runs/codex-stdio.js';
import type { Run, Session } from '../../../shared/types.js';

const NATIVE = '40000000-0000-4000-8000-000000000001';
const now = '2026-09-28T00:00:00.000Z';

/** A manager whose providers never start: each launch is recorded, then refused. */
async function fixture(t: TestContext, notes?: (run: Run, session: Session) => Promise<string | undefined>, saved?: { runs: unknown[] }) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-run-instructions-'));
  const stateDir = join(directory, 'state');
  await mkdir(stateDir, { recursive: true });
  if (saved) await writeFile(join(stateDir, 'runs.json'), JSON.stringify(saved.runs), { mode: 0o600 });
  const native: Session = { id: `codex:${NATIVE}`, nativeId: NATIVE, provider: 'codex', title: 'Native', cwd: directory, project: 'fixture',
    status: 'completed', statusReason: 'Finished', createdAt: now, updatedAt: now, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const codex: CodexStdioOptions[] = [];
  const claude: string[][] = [];
  const manager = new RunManager({ stateDir, getSession: id => id === native.id ? native : undefined, refreshSessions: async () => {}, pollMs: 60_000,
    findExecutable: async provider => `/fixture/${provider}`,
    spawnProcess: ((_command: string, args: string[]) => { claude.push(args); throw new Error('Fixtures never start providers.'); }) as never,
    openCodexStdio: async options => { codex.push(options); throw new Error('Fixtures never start providers.'); },
    ...(notes ? { firstTurnNotes: notes } : {}) });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const settled = async (id: string) => { for (let i = 0; i < 200 && manager.list().find(run => run.id === id)?.status === 'queued'; i++) await new Promise(resolve => setTimeout(resolve, 10)); };
  return { directory, stateDir, manager, native, codex, claude, settled };
}

test('instructions reach the provider beside the request, and never leave the worker', async t => {
  const f = await fixture(t);
  const { run } = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Look at the Slack request' },
    { origin: { kind: 'slack', workflowId: 'w' }, untrustedInput: true, instructions: { text: 'Coordinator policy', required: true } });
  assert.equal(run.instructions, undefined, 'the answer to the page leaves them out');
  await f.settled(run.id);
  assert.equal(f.codex[0].prompt, 'Look at the Slack request', 'the request is its own block');
  assert.equal(f.codex[0].instructions, 'Coordinator policy');
  assert.ok(f.manager.list().every(item => item.instructions === undefined), 'pages never receive them');
  assert.doesNotMatch(await readFile(join(f.stateDir, 'runs.json'), 'utf8'), /Coordinator policy/, 'their text never reaches disk, where an older Tower could show it');

  const claude = await f.manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Owner reply' }, { origin: { kind: 'owner' }, instructions: { text: 'Receipt' } });
  await f.settled(claude.run.id);
  assert.ok(!f.claude[0]!.includes('--append-system-prompt'), 'Claude keeps a conversation’s first system prompt, so instructions go in the message');
  await assert.rejects(f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'x' }, { instructions: { text: 'x'.repeat(48_001) } }), { statusCode: 413 });
});

test('a new conversation’s first turn gets its notes; a later turn does not', async t => {
  const asked: string[] = [];
  const f = await fixture(t, async run => { asked.push(run.prompt); return '## Possibly related earlier sessions\n- claude:earlier'; });
  const created = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Fix the payment webhook' }, { origin: { kind: 'owner' }, instructions: { text: 'Policy', required: true } });
  await f.settled(created.run.id);
  assert.equal(f.codex[0].instructions, 'Policy\n\n## Possibly related earlier sessions\n- claude:earlier', 'added after what the turn already had');
  const next = await f.manager.enqueue(f.native.id, 'Continue', {}, { origin: { kind: 'owner' } });
  await f.settled(next.id);
  assert.deepEqual(asked, ['Fix the payment webhook']);
  assert.equal(f.codex[1].instructions, undefined);
  // Work from a controlling computer is not told about this computer's sessions.
  const remote = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Remote task' }, { origin: { kind: 'owner', controllerId: 'c'.repeat(32) } });
  await f.settled(remote.run.id);
  assert.deepEqual(asked, ['Fix the payment webhook']);
});

test('notes that fail or take too long never hold up or break the turn', async t => {
  const f = await fixture(t, async () => { throw new Error('judgment unavailable'); });
  const { run } = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Task' }, { origin: { kind: 'owner' } });
  await f.settled(run.id);
  assert.equal(f.codex.length, 1);
  assert.equal(f.codex[0].instructions, undefined);
});

test('a continuation keeps the instructions its turn could not go without, and is not started without them after a restart', async t => {
  const after: Run = { id: '50000000-0000-4000-8000-000000000001', sessionId: `codex:${NATIVE}`, origin: { kind: 'owner' }, prompt: 'Approve 1', status: 'completed', createdAt: now, output: '',
    instructions: { text: 'Receipt: owner approved reply 1', required: true } };
  const f = await fixture(t);
  const internals = f.manager as unknown as { runs: Map<string, Run>; scheduleContinuation(run: Run, wakeup: { prompt: string; at: number }): void };
  internals.runs.set(after.id, after);
  internals.scheduleContinuation(after, { prompt: 'Check the task', at: Date.now() + 3_600_000 });
  const scheduled = [...internals.runs.values()].find(run => run.scheduled)!;
  assert.deepEqual(scheduled.instructions, after.instructions);
  internals.runs.set('50000000-0000-4000-8000-000000000002', { ...after, id: '50000000-0000-4000-8000-000000000002', sessionId: 'codex:another', instructions: { text: 'Possibly related' } });
  internals.scheduleContinuation(internals.runs.get('50000000-0000-4000-8000-000000000002')!, { prompt: 'Later', at: Date.now() + 3_600_000 });
  const plain = [...internals.runs.values()].find(run => run.scheduled && run.id !== scheduled.id)!;
  assert.equal(plain.instructions, undefined, 'a first turn’s notes do not go on');
  await f.manager.flushState();
  const saved = await readFile(join(f.stateDir, 'runs.json'), 'utf8');
  assert.doesNotMatch(saved, /Receipt: owner approved/);
  const g = await fixture(t, undefined, { runs: JSON.parse(saved) as unknown[] });
  const restored = new Map(g.manager.list().map(run => [run.id, run]));
  assert.equal(restored.get(scheduled.id)?.status, 'cancelled', 'never started without what it needed');
  assert.match(restored.get(scheduled.id)!.error!, /without the instructions/);
  assert.equal(restored.get(plain.id)?.status, 'queued', 'other continuations wait as before');
});

test('the conversation leaves out exactly Tower’s own instruction blocks', () => {
  const block = towerInstructionsBlock('Coordinator policy');
  const [claude] = parseMessages('claude', { type: 'user', uuid: 'u', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'Look at the request' }, { type: 'text', text: block }] } });
  assert.equal(claude!.text, 'Look at the request');
  const [codex] = parseMessages('codex', { type: 'response_item', timestamp: now, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look at the request' }, { type: 'input_text', text: block }] } });
  assert.equal(codex!.text, 'Look at the request');
  // What someone wrote stays whole, even when it quotes such a block.
  const quoted = `Please check this:\n\n${block}\nand fix it`;
  assert.equal(parseMessages('claude', { type: 'user', uuid: 'q', timestamp: now, message: { role: 'user', content: quoted } })[0]!.text, quoted);
  assert.equal(parseMessages('codex', { type: 'response_item', timestamp: now, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: quoted }] } })[0]!.text, quoted);
  // An assistant quoting one is shown as written.
  assert.match(parseMessages('claude', { type: 'assistant', uuid: 'a', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: block }] } })[0]!.text, /Coordinator policy/);
});
