import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RunManager } from '../server/runner.js';
import type { Session } from '../shared/types.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-auto-runner-'));
  const nativeId = randomUUID();
  const session: Session = { id: `codex:${nativeId}`, nativeId, provider: 'codex', cwd: directory, project: 'fixture', title: 'Existing', status: 'idle', statusReason: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
  const options = { stateDir: directory, getSession: (id: string) => id === session.id ? session : undefined, refreshSessions: async () => {}, maxConcurrent: 0,
    findExecutable: async () => '/fixture/codex', spawnProcess: () => { throw new Error('These tests must never launch a provider'); } };
  const manager = new RunManager(options); await manager.start();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { manager, session, directory, options };
}

test('new sessions retain blank attachment prompts and persist Auto Prompt correlation before execution', async t => {
  const f = await fixture(t);
  const autoPromptId = randomUUID();
  const attachments = [{ name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('Original bytes').toString('base64') }];
  const { run, session } = await f.manager.create({ provider: 'codex', cwd: f.directory, prompt: '', attachments }, { autoPromptId });
  assert.equal(run.prompt, ''); assert.equal(run.autoPromptId, autoPromptId); assert.equal(run.status, 'queued');
  assert.equal(session.title, '첨부 파일 확인');
  assert.equal(run.attachments?.length, 1);
  const stored = await f.manager.attachment(run.attachments![0].id);
  assert.equal(stored.content.toString(), 'Original bytes');
  const persisted = JSON.parse(await readFile(join(f.directory, 'runs.json'), 'utf8'));
  assert.equal(persisted[0].autoPromptId, autoPromptId);
  assert.equal(persisted[0].attachments[0].id, run.attachments![0].id);
  await assert.rejects(f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Duplicate' }, { autoPromptId }), { statusCode: 409 });
});

test('correlation survives restart and old queued instructions are not replayed', async t => {
  const f = await fixture(t);
  const autoPromptId = randomUUID();
  const run = await f.manager.enqueue(f.session.id, '  Original\n prompt  ', {}, { autoPromptId });
  await f.manager.close();
  const restarted = new RunManager(f.options); await restarted.start();
  const restored = restarted.list().find(value => value.id === run.id)!;
  assert.equal(restored.autoPromptId, autoPromptId);
  assert.equal(restored.prompt, '  Original\n prompt  ');
  assert.equal(restored.status, 'cancelled');
  await assert.rejects(restarted.enqueue(f.session.id, 'Duplicate', {}, { autoPromptId }), { statusCode: 409 });
  await restarted.close();
});

test('internal admission revalidation rolls back prepared attachments for both create and resume', async t => {
  for (const action of ['create', 'resume'] as const) await t.test(action, async t => {
    const f = await fixture(t);
    const attachments = [{ name: 'notes.txt', mimeType: 'text/plain', data: 'YQ==' }];
    let valid = true;
    const internal = { autoPromptId: randomUUID(), validate: () => { if (!valid) throw Object.assign(new Error('Route changed'), { statusCode: 409 }); } };
    const operation = action === 'create' ? f.manager.create({ provider: 'codex', cwd: f.directory, prompt: 'Task', attachments }, internal)
      : f.manager.enqueue(f.session.id, 'Task', { attachments }, internal);
    valid = false;
    await assert.rejects(operation, { statusCode: 409 });
    assert.deepEqual(f.manager.list(), []);
    assert.deepEqual(await readdir(join(f.directory, 'attachments')), []);
  });
});

test('new-session attachment validation happens before any run or placeholder is accepted', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.create({ provider: 'codex', cwd: f.directory, prompt: '', attachments: [{ name: '../escape.txt', mimeType: 'text/plain', data: 'YQ==' }] }));
  assert.deepEqual(f.manager.list(), []);
  assert.deepEqual(f.manager.sessionList([]), []);
});
