import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** JSON-RPC fixture for the native Codex app-server contract used by runner tests. */
export function startCodexFixture({ defaultId, otherId, created = false }) {
  const mode = process.env.FIXTURE_MODE;
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  let threadId;
  let threadMethod;
  let threadParams;
  const turnId = 'fixture-turn';
  let received;
  const finish = status => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, ...(status === 'failed' ? { error: { message: 'provider declined' } } : {}) } } });
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      if (mode === 'fail') { process.stderr.write('authentication expired'); process.exit(2); }
      if (mode === 'empty') { process.exit(0); }
      if (mode === 'invalid-event') { send(null); return; }
      send({ id: request.id, result: {} });
    } else if (request.method === 'thread/start' || request.method === 'thread/resume') {
      if (request.params.approvalsReviewer && mode === 'refuse-reviewer') { send({ id: request.id, error: { code: -32600, message: 'Invalid request: unknown variant `auto_review`, expected `user` for approvalsReviewer' } }); return; }
      if (request.params.approvalsReviewer && mode === 'refuse-thread') { send({ id: request.id, error: { code: -32600, message: 'Invalid request: thread is not available' } }); return; }
      threadMethod = request.method; threadParams = request.params;
      threadId = request.params.threadId || defaultId;
      if (mode === 'hold-before-id') return;
      if (mode === 'break-registry') { rmSync(process.env.CREATED_PATH, { force: true }); mkdirSync(process.env.CREATED_PATH); }
      const actual = mode === 'invalid-id' ? 'bad-id' : mode === 'mismatch' ? otherId : threadId;
      send({ id: request.id, result: { thread: { id: actual, status: { type: 'idle' } }, approvalsReviewer: mode === 'old-reviewer' ? 'user' : request.params.approvalsReviewer || 'user' } });
    } else if (request.method === 'turn/start') {
      received = { prompt: request.params.input[0].text, args: process.argv.slice(2), cwd: process.cwd(), nested: process.env.CLAUDECODE, threadMethod, threadParams, input: request.params.input, turnEffort: request.params.effort };
      writeFileSync(process.env.RECEIVED_PATH, JSON.stringify(received));
      if (mode === 'unconfirmed-turn') { send({ id: request.id, result: { turn: {} } }); return; }
      send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      if (mode === 'orphan') { setTimeout(() => { spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', process.stdout, process.stderr] }); process.exit(0); }, 10); return; }
      if (mode === 'hold') return;
      if (mode === 'approval') {
        send({ id: 'fixture-approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command', command: 'gh pr view 1', cwd: process.cwd(), reason: 'Allow this command?' } });
        return;
      }
      setTimeout(() => {
        if (mode === 'stream-error') { finish('failed'); return; }
        send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'reply', type: 'agentMessage', text: mode === 'large' ? 'a'.repeat(100000) : created ? 'Created Codex' : 'Hello Codex' } } });
        finish('completed');
      }, mode === 'slow' ? 150 : 5);
    } else if (request.method === 'turn/interrupt') {
      send({ id: request.id, result: {} }); finish('interrupted');
    } else if (request.id === 'fixture-approval' && request.result) {
      received.approvalResponse = request.result;
      writeFileSync(process.env.RECEIVED_PATH, JSON.stringify(received));
      finish('completed');
    }
  });
}
