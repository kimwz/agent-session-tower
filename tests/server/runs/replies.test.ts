import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import { MAX_REPLIES, MAX_REPLY_CHARS, ReplyLog } from '../../../server/runs/replies.js';
import type { Run, Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.js';

const nativeId = '10000000-0000-4000-8000-00000000abcd';

test('a reply only grows: never cut at its start; too long it stops growing, and past the bounds the oldest whole replies go', () => {
  const run = { replies: undefined } as unknown as Run;
  const log = new ReplyLog(run);
  assert.equal(log.add('m1:0', ''), true, 'a reply opens empty');
  assert.equal(log.add('m1:0', '안녕하세요. '), true);
  assert.equal(log.add('m1:0', '확인할게요.'), true);
  assert.equal(log.finish('m1:0'), true);
  assert.equal(log.add('m1:0', ' 늦은 글'), false, 'a finished reply takes nothing more');
  assert.deepEqual(run.replies, [{ id: 'm1:0', text: '안녕하세요. 확인할게요.', done: true }]);
  assert.equal(run.repliesTrimmed, undefined);
  log.add('m2:0', 'x'.repeat(MAX_REPLY_CHARS + 10));
  const long = run.replies!.find(reply => reply.id === 'm2:0')!;
  assert.equal(long.text.length, MAX_REPLY_CHARS);
  assert.equal(long.cut, true);
  assert.equal(run.repliesTrimmed, true);
  assert.equal(run.replies![0].id, 'm2:0', 'the oldest went to make room; the newest stays');
  const many = { } as Run;
  const other = new ReplyLog(many);
  for (let index = 0; index < MAX_REPLIES + 5; index++) other.add(`m${index}:0`, '짧은 글.', true);
  assert.equal(many.replies!.length, MAX_REPLIES);
  assert.equal(many.replies!.at(-1)!.id, `m${MAX_REPLIES + 4}:0`);
  assert.equal(many.repliesTrimmed, true);
});

/** A Claude session in `folder` whose process writes `events`, run by a manager with fake sign-in check and process. */
async function fixture(t: TestContext, folder: (stateDir: string) => string, events: unknown[]) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-replies-'));
  const cwd = folder(stateDir);
  await mkdir(cwd, { recursive: true });
  const session: Session = { id: `claude:${nativeId}`, nativeId, provider: 'claude', title: 'Fixture', cwd, project: 'fixture', status: 'completed', statusReason: 'Done',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const manager = new RunManager({ stateDir, getSession: id => id === session.id ? session : undefined, refreshSessions: async () => {}, findExecutable: async () => '/fixture/claude', pollMs: 10,
    checkClaudeSubscription: async () => {},
    spawnProcess: () => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      const exit = () => { if (child.exitCode !== null) return; Object.assign(child, { exitCode: 0 }); child.emit('close', 0, null); };
      let sent = false;
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: () => { exit(); return true; },
        stdin: new Writable({ write(_chunk, _encoding, done) {
          if (!sent) {
            sent = true;
            setImmediate(() => {
              for (const event of events) child.stdout.push(JSON.stringify(event) + '\n');
              child.stdout.push(JSON.stringify({ type: 'result', session_id: nativeId, is_error: false }) + '\n');
              child.stdout.push(null);
              exit();
            });
          }
          done();
        } }) });
      return child;
    } });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(stateDir, { recursive: true, force: true }); });
  const run = await manager.enqueue(session.id, 'hello', {}, { origin: { kind: 'owner' } });
  await until(() => ['completed', 'error'].includes(manager.list().find(item => item.id === run.id)?.status ?? '') || undefined);
  return manager.list().find(item => item.id === run.id)!;
}

const turn = [
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '세션 목록을 ' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '볼게요.' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: '세션 목록을 볼게요.' }] } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'tower_query' } } },
  { type: 'stream_event', event: { type: 'message_stop' } },
  // A subagent's words are not the master's.
  { type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '하위 에이전트' } } },
  // A message that came without partial text.
  { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: '두 개가 돌고 있어요.' }] } },
];

test('the master\'s turn keeps its words block by block, as they stream, without tool notes, subagents or repeats', async t => {
  const run = await fixture(t, stateDir => join(stateDir, 'master-session'), turn);
  assert.deepEqual(run.replies, [
    { id: 'msg_1:1', text: '세션 목록을 볼게요.', done: true },
    { id: 'msg_2:a0', text: '두 개가 돌고 있어요.', done: true },
  ]);
  assert.equal(run.repliesTrimmed, undefined);
  assert.match(run.output, /\[tower_query\]|세션 목록을/, 'the output shows as before');
});

test('other sessions\' turns carry no replies, so ordinary snapshots do not grow', async t => {
  const run = await fixture(t, stateDir => join(stateDir, 'project'), turn);
  assert.equal(run.replies, undefined);
});
