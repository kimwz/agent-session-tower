import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import { parseMessages } from '../../../server/sessions/parser.js';
import type { CodexStdioOptions } from '../../../server/runs/codex-stdio.js';
import type { Run, Session } from '../../../shared/types.js';

const NATIVE = '40000000-0000-4000-8000-000000000001';
const now = '2026-09-28T00:00:00.000Z';

/** A manager whose providers never start: each launch is recorded, then refused. */
async function fixture(t: TestContext, notes?: (run: Run, session: Session) => Promise<string | undefined>, saved?: { runs: unknown[]; instructions: unknown[] }) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-run-instructions-'));
  const stateDir = join(directory, 'state');
  await mkdir(stateDir, { recursive: true });
  if (saved) {
    await writeFile(join(stateDir, 'runs.json'), JSON.stringify(saved.runs), { mode: 0o600 });
    await writeFile(join(stateDir, 'run-instructions.json'), JSON.stringify(saved.instructions), { mode: 0o600 });
  }
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
  // Codex gets them at the end of the message, in a block the conversation view leaves out.
  assert.equal(f.codex[0].prompt, 'Look at the Slack request\n\n<tower-instructions>\nCoordinator policy\n</tower-instructions>');
  const [shownMessage] = parseMessages('codex', { type: 'response_item', timestamp: now, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: f.codex[0].prompt }] } });
  assert.equal(shownMessage!.text, 'Look at the Slack request', 'the conversation shows only the request');
  assert.ok(f.manager.list().every(item => item.instructions === undefined), 'pages never receive them');
  assert.doesNotMatch(await readFile(join(f.stateDir, 'runs.json'), 'utf8'), /Coordinator policy/, 'an older Tower reading runs.json never sees them');

  const claude = await f.manager.create({ provider: 'claude', cwd: f.directory, prompt: 'Owner reply' }, { origin: { kind: 'owner' }, instructions: { text: 'Receipt' } });
  await f.settled(claude.run.id);
  const args = f.claude[0]!;
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'Receipt');
  await assert.rejects(f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'x' }, { instructions: { text: 'x'.repeat(48_001) } }), { statusCode: 413 });
});

test('a new conversation’s first turn gets its notes; a later turn does not', async t => {
  const asked: string[] = [];
  const f = await fixture(t, async run => { asked.push(run.prompt); return '## Possibly related earlier sessions\n- claude:earlier'; });
  const created = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Fix the payment webhook' }, { origin: { kind: 'owner' }, instructions: { text: 'Policy', required: true } });
  await f.settled(created.run.id);
  assert.match(f.codex[0].prompt, /<tower-instructions>\nPolicy\n\n## Possibly related earlier sessions\n- claude:earlier\n<\/tower-instructions>$/, 'added after what the turn already had');
  const next = await f.manager.enqueue(f.native.id, 'Continue', {}, { origin: { kind: 'owner' } });
  await f.settled(next.id);
  assert.deepEqual(asked, ['Fix the payment webhook']);
  assert.equal(f.codex[1].prompt, 'Continue');
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
  assert.equal(f.codex[0].prompt, 'Task');
});

test('a continuation keeps the instructions its turn could not go without, also across a restart', async t => {
  const after: Run = { id: '50000000-0000-4000-8000-000000000001', sessionId: `codex:${NATIVE}`, origin: { kind: 'owner' }, prompt: 'Approve 1', status: 'completed', createdAt: now, output: '',
    instructions: { text: 'Receipt: owner approved reply 1', required: true } };
  const f = await fixture(t);
  (f.manager as unknown as { runs: Map<string, Run> }).runs.set(after.id, after);
  (f.manager as unknown as { scheduleContinuation(run: Run, wakeup: { prompt: string; at: number }): void }).scheduleContinuation(after, { prompt: 'Check the task', at: Date.now() + 3_600_000 });
  const scheduled = [...(f.manager as unknown as { runs: Map<string, Run> }).runs.values()].find(run => run.scheduled)!;
  assert.deepEqual(scheduled.instructions, after.instructions);
  const notes: Run = { ...after, id: '50000000-0000-4000-8000-000000000002', instructions: { text: 'Possibly related' } };
  (f.manager as unknown as { scheduleContinuation(run: Run, wakeup: { prompt: string; at: number }): void }).scheduleContinuation(notes, { prompt: 'Later', at: Date.now() + 3_600_000 });
  await f.manager.flushState();
  const kept = JSON.parse(await readFile(join(f.stateDir, 'run-instructions.json'), 'utf8')) as Array<[string, unknown]>;
  assert.deepEqual(kept, [[scheduled.id, after.instructions]], 'only turns still to run, only what they must have');

  const { runs } = { runs: JSON.parse(await readFile(join(f.stateDir, 'runs.json'), 'utf8')) as unknown[] };
  const g = await fixture(t, undefined, { runs, instructions: [...kept, ['unknown-run', { text: 'x' }], [scheduled.id + 'x', 'invalid']] });
  assert.deepEqual((g.manager as unknown as { runs: Map<string, Run> }).runs.get(scheduled.id)?.instructions, after.instructions, 'restored after a restart');
});
