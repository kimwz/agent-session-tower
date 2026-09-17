import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeControl } from '../server/runs/claude-control.js';
import type { RunApproval } from '../shared/types.js';

function fixture(timeout = 5000, steerTimeout = 5000) {
  const written: Record<string, any>[] = [];
  const approvals: RunApproval[] = [];
  const cancelled: string[] = [];
  const errors: Error[] = [];
  let failWrites = false;
  const control = new ClaudeControl({
    write: async message => { if (failWrites) throw new Error('private transport error'); written.push(message); },
    onApproval: approval => approvals.push(approval), onCancelled: id => cancelled.push(id), onError: error => errors.push(error), initializeTimeoutMs: timeout, steerTimeoutMs: steerTimeout,
  });
  const input = { type: 'user', session_id: 'native-session', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'literal $(not a command)' }] } };
  control.start(input);
  const initialize = () => control.handle({ type: 'control_response', response: { subtype: 'success', request_id: written[0].request_id, response: { account: { private: true } } } });
  const ask = (id = 'permission-1', input: object = { command: 'gh --version' }) => control.handle({ type: 'control_request', request_id: id,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool-1', input, description: 'Read the CLI version' } });
  return { control, written, approvals, cancelled, errors, initialize, input, ask, failWrites: () => { failWrites = true; } };
}

test('Claude initializes its control channel before submitting the user input exactly once', t => {
  const f = fixture(); t.after(() => f.control.close());
  assert.equal(f.written.length, 1);
  assert.deepEqual(f.written[0].request, { subtype: 'initialize' });
  f.initialize(); f.initialize();
  assert.deepEqual(f.written.slice(1), [f.input]);
  assert.equal(f.written.some(message => JSON.stringify(message).includes('permission_mode')), false);
});

test('a pending permission waits for an explicit response and retains the exact original input', async t => {
  const f = fixture(); t.after(() => f.control.close()); f.initialize();
  f.ask();
  assert.equal(f.written.length, 2); assert.equal(f.approvals.length, 1);
  f.approvals[0].input.command = 'browser must not replace the command';
  await assert.rejects(f.control.respond('permission-1', 'invalid' as 'allow'), { statusCode: 409 });
  await f.control.respond('permission-1', 'allow');
  assert.deepEqual(f.written[2], { type: 'control_response', response: { subtype: 'success', request_id: 'permission-1',
    response: { behavior: 'allow', updatedInput: { command: 'gh --version' }, toolUseID: 'tool-1' } } });
  assert.deepEqual(f.cancelled, ['permission-1']);
  await assert.rejects(f.control.respond('permission-1', 'allow'), { statusCode: 409 });
  assert.equal(f.written.length, 3);
});

test('denial is one-shot and does not change persisted permission rules', async t => {
  const f = fixture(); t.after(() => f.control.close()); f.initialize(); f.ask();
  await f.control.respond('permission-1', 'deny');
  const response = f.written.at(-1)!.response.response;
  assert.equal(response.behavior, 'deny'); assert.match(response.message, /user denied/);
  assert.equal(response.updatedPermissions, undefined); assert.equal(response.interrupt, undefined);
  await assert.rejects(f.control.respond('unknown', 'deny'), { statusCode: 409 });
});

test('native cancellation and process closure retire pending requests without answering them', async () => {
  const f = fixture(); f.initialize(); f.ask();
  f.control.handle({ type: 'control_cancel_request', request_id: 'permission-1' });
  await assert.rejects(f.control.respond('permission-1', 'allow'), { statusCode: 409 });
  f.ask('permission-2'); f.control.close();
  await assert.rejects(f.control.respond('permission-2', 'allow'), { statusCode: 409 });
  assert.deepEqual(f.cancelled, ['permission-1', 'permission-2']); assert.equal(f.written.length, 2);
});

test('duplicate pending frames are idempotent but changed input cannot reuse approval', t => {
  const f = fixture(); t.after(() => f.control.close()); f.initialize(); f.ask(); f.ask();
  assert.equal(f.approvals.length, 1);
  f.ask('permission-1', { command: 'changed command' });
  assert.match(f.errors[0].message, /changed a pending permission/); assert.equal(f.written.length, 2);
});

test('invalid and oversized approval input stops the permission connection without granting anything', t => {
  const f = fixture(); t.after(() => f.control.close()); f.initialize();
  f.ask('permission-1', { text: 'x'.repeat(64_001) });
  assert.match(f.errors[0].message, /oversized/); assert.equal(f.approvals.length, 0);
  assert.equal(f.written.length, 2);
});

test('a failed initialization never submits an instruction and unknown controls are not permissions', t => {
  const f = fixture(); t.after(() => f.control.close());
  f.control.handle({ type: 'control_response', response: { subtype: 'error', request_id: f.written[0].request_id, error: 'private SDK error' } });
  assert.equal(f.written.length, 1); assert.equal(f.errors.length, 1); assert.doesNotMatch(f.errors[0].message, /private/);
  const g = fixture(); t.after(() => g.control.close()); g.initialize();
  g.control.handle({ type: 'control_request', request_id: 'unsupported', request: { subtype: 'hook_callback' } });
  assert.equal(g.written.at(-1)!.response.subtype, 'error'); assert.equal(g.approvals.length, 0);
  g.control.handle({ type: 'control_request', request_id: 'dialog', request: { subtype: 'request_user_dialog' } });
  assert.equal(g.written.at(-1)!.response.response.behavior, 'cancelled');
});

test('a lost approval response is not retried or silently reported as sent', async t => {
  const f = fixture(); t.after(() => f.control.close()); f.initialize(); f.ask(); f.failWrites();
  await assert.rejects(f.control.respond('permission-1', 'allow'), /not sent again/);
  await assert.rejects(f.control.respond('permission-1', 'allow'), { statusCode: 409 });
  assert.equal(f.errors.length, 1); assert.equal(f.written.length, 2);
});

test('an unresponsive initialization times out before the first user message', async t => {
  const f = fixture(10); t.after(() => f.control.close());
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.errors.length, 1); assert.equal(f.written.length, 1);
});

test('steering sends once at next priority and waits for the matching conversation replay', async t => {
  const f = fixture(); t.after(() => f.control.close());
  const input = { ...f.input, uuid: 'steer-1', priority: 'now' };
  assert.equal(f.control.canSteer(), false);
  await assert.rejects(f.control.steer(input), { disposition: 'rejected' });
  f.initialize(); assert.equal(f.control.canSteer(), true);
  const sent = f.control.steer(input);
  assert.equal(f.control.hasPendingSteers(), true);
  assert.deepEqual(f.written.at(-1), { ...input, priority: 'next' });
  await assert.rejects(f.control.steer(input), { disposition: 'uncertain' });
  const replay = { ...input, isReplay: true };
  for (const mismatch of [{ uuid: 'other' }, { session_id: 'other' }, { isReplay: false }, { parent_tool_use_id: 'subagent' }]) {
    assert.equal(f.control.handle({ ...replay, ...mismatch }), false);
    assert.equal(f.control.hasPendingSteers(), true);
  }
  assert.equal(f.control.handle(replay), true);
  assert.equal(f.control.hasPendingSteers(), false);
  await sent;
  await assert.rejects(f.control.steer(input), { disposition: 'uncertain' });
  assert.equal(f.written.length, 3); assert.deepEqual(f.errors, []);
});

test('steering rejects a different session without writing', async t => {
  const f = fixture(); t.after(() => f.control.close()); f.initialize();
  await assert.rejects(f.control.steer({ ...f.input, uuid: 'steer-1', session_id: 'other' }), { disposition: 'rejected' });
  assert.equal(f.written.length, 2); assert.equal(f.control.hasPendingSteers(), false);
});

test('a steering write failure is uncertain and does not kill the running permission channel', async t => {
  const f = fixture(); t.after(() => f.control.close()); f.initialize(); f.failWrites();
  await assert.rejects(f.control.steer({ ...f.input, uuid: 'steer-1' }), { disposition: 'uncertain' });
  assert.equal(f.control.hasPendingSteers(), false);
  assert.equal(f.control.canSteer(), true); assert.deepEqual(f.errors, []);
});

test('steering timeout remains uncertain without cancelling the current turn', async t => {
  const f = fixture(5000, 10); t.after(() => f.control.close()); f.initialize();
  const rejection = assert.rejects(f.control.steer({ ...f.input, uuid: 'steer-1' }), { disposition: 'uncertain' });
  await new Promise(resolve => setTimeout(resolve, 30)); await rejection;
  assert.equal(f.control.hasPendingSteers(), false);
  assert.equal(f.control.canSteer(), true); assert.deepEqual(f.errors, []);
  f.ask(); assert.equal(f.approvals.length, 1);
});

test('closing the process rejects every pending steering request as uncertain', async () => {
  const f = fixture(); f.initialize();
  const first = assert.rejects(f.control.steer({ ...f.input, uuid: 'steer-1' }), { disposition: 'uncertain' });
  const second = assert.rejects(f.control.steer({ ...f.input, uuid: 'steer-2' }), { disposition: 'uncertain' });
  f.control.close(); await Promise.all([first, second]);
  assert.equal(f.control.canSteer(), false); assert.equal(f.control.hasPendingSteers(), false);
  assert.deepEqual(f.errors, []);
});

test('steering registers its replay handler before transport write returns', async t => {
  let control: ClaudeControl;
  const written: Record<string, any>[] = [];
  control = new ClaudeControl({
    write: async message => {
      written.push(message);
      if (message.uuid) control.handle({ ...message, isReplay: true });
    }, onApproval: () => {}, onCancelled: () => {}, onError: error => { throw error; },
  });
  t.after(() => control.close());
  const input = { type: 'user', session_id: 'native-session', parent_tool_use_id: null, message: { role: 'user', content: 'hello' } };
  control.start(input);
  control.handle({ type: 'control_response', response: { subtype: 'success', request_id: written[0].request_id } });
  await control.steer({ ...input, uuid: 'steer-1' });
  assert.equal(control.hasPendingSteers(), false);
});
