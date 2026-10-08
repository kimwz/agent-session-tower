import assert from 'node:assert/strict';
import test from 'node:test';
import { heartbeatRequest } from '../../server/master/heartbeat-request.js';
import { parseMessages } from '../../server/sessions/parser.js';
import { TOWER_NOTICE } from '../../shared/task-notification.js';
import type { Run, Session, SessionDetail } from '../../shared/types.js';
const at = (seconds: number) => new Date(1_700_000_000_000 + seconds * 1000).toISOString();
const original: Run = { id: 'original', sessionId: 'claude:worker', prompt: 'Implement and deploy the feature', createdAt: at(0), status: 'completed', output: '' };
const resumed: Run = { ...original, id: 'resumed', prompt: `${TOWER_NOTICE} Resume after approval`, createdAt: at(60), status: 'running', scheduled: { at: at(60), afterRunId: original.id, resume: 'permission' } };
const detail = (text = original.prompt, timestamp = at(10)): SessionDetail => ({ session: { id: original.sessionId } as Session, hasMore: true, messages: [{ id: 'native-request', role: 'user', timestamp, text }, ...parseMessages('claude', { type: 'user', uuid: 'notice', timestamp: at(65), message: { role: 'user', content: resumed.prompt } })] });
test('Claude system notice continuation follows original native request without timestamp tolerance', async () => {
  assert.equal(detail().messages.at(-1)?.role, 'system');
  assert.deepEqual(await heartbeatRequest([original, resumed], resumed, detail()), { nativeRequestId: 'native-request', requestRunId: original.id });
  const page = detail(); page.previousUser = page.messages.shift();
  assert.deepEqual(await heartbeatRequest([original, resumed], resumed, page), { nativeRequestId: 'native-request', requestRunId: original.id });
});
test('a provider that records the continuation as user correlates that actual request', async () => {
  assert.deepEqual(await heartbeatRequest([original, resumed], resumed, detail(resumed.prompt, at(65))), { nativeRequestId: 'native-request', requestRunId: resumed.id });
});
test('missing, cyclic, foreign-session ancestry and unread history fail closed', async () => {
  for (const runs of [[resumed], [{ ...original, sessionId: 'other' }, resumed], [{ ...original, scheduled: { at: at(0), afterRunId: resumed.id, resume: 'update' as const } }, resumed]]) {
    assert.equal(await heartbeatRequest(runs, resumed, detail()), undefined);
  }
  assert.equal(await heartbeatRequest([original, resumed], resumed, { ...detail(), skipped: 1 }), undefined);
  assert.equal(await heartbeatRequest([original], original, detail(original.prompt, at(-1))), undefined);
});
test('delivered steering supersedes earlier native requests even across continuations', async () => {
  const steering: Run = { ...original, id: 'steering', prompt: 'Use hosted CI and deploy', createdAt: at(30), steering: { targetRunId: original.id, state: 'delivered', requestedAt: at(30) } };
  assert.equal(await heartbeatRequest([original, steering, resumed], resumed, detail()), undefined);
  assert.deepEqual(await heartbeatRequest([original, steering, resumed], resumed, detail(steering.prompt, at(40))), { nativeRequestId: 'native-request', requestRunId: steering.id });
  assert.deepEqual(await heartbeatRequest([original, steering, resumed], resumed, detail(resumed.prompt, at(65))), { nativeRequestId: 'native-request', requestRunId: resumed.id });
});
test('an unrelated owner request never matches tracked ancestry', async () => {
  assert.equal(await heartbeatRequest([original, resumed], resumed, detail('Stop this work and handle another task', at(70))), undefined);
});
