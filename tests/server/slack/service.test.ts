import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackService } from '../../../server/slack/service.js';
import type { SlackSocketOptions } from '../../../server/slack/socket.js';

test('Slack connection stays private, admits only personal mentions, and pauses without losing accepted work', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-slack-service-'));
  let socket: SlackSocketOptions | undefined;
  let starts = 0, stops = 0;
  const service = new SlackService({ stateDir, runs: { list: () => [] }, autoPrompts: { get: () => undefined, submit: async () => { throw new Error('Must not execute'); } }, refresh: async () => {} }, {
    client: () => ({ auth: async () => ({ teamId: 'T1', userId: 'U1' }), thread: async () => [], reply: async () => { throw new Error('Must not send'); } }),
    socket: options => { socket = options; return { start: () => { starts++; }, stop: () => { stops++; } }; },
    model: async () => { throw new Error('Must not start a provider'); },
  });
  t.after(async () => { service.close(); await rm(stateDir, { recursive: true, force: true }); });
  await service.start();
  const credentials = { appToken: 'xapp-test-1234567890', userToken: 'xoxp-test-1234567890' };
  await service.mutate('connect', credentials);
  assert.equal(starts, 0);
  assert.equal(service.overview().enabled, false);
  assert.equal(JSON.stringify(service.overview()).includes(credentials.userToken), false);
  assert.equal((await stat(join(stateDir, 'slack-connection.json'))).mode & 0o777, 0o600);
  await service.mutate('settings', { enabled: true });
  assert.equal(starts, 1); assert.equal(service.hasActive(), true);
  const event = { type: 'message', channel: 'C1', user: 'U2', ts: '100.001', text: '<@U1> review please' };
  for (const payload of [
    { team_id: 'T2', event_id: 'other-team', event },
    { team_id: 'T1', event_id: 'bot', event: { ...event, bot_id: 'B1' } },
    { team_id: 'T1', event_id: 'self', event: { ...event, user: 'U1' } },
    { team_id: 'T1', event_id: 'unmentioned', event: { ...event, text: 'hello' } },
    { team_id: 'T1', event_id: 'edit', event: { ...event, subtype: 'message_changed' } },
  ]) await socket!.onEvent(payload);
  assert.equal(service.overview().events.length, 0);
  await socket!.onEvent({ team_id: 'T1', event_id: 'Ev1', event });
  await socket!.onEvent({ team_id: 'T1', event_id: 'Ev1', event });
  assert.equal(service.overview().events.length, 1);
  await service.mutate('settings', { enabled: false });
  assert.equal(stops, 1);
  assert.equal(service.hasActive(), true, 'accepted events retain worker lifetime while monitoring is paused');
  await assert.rejects(service.mutate('disconnect', {}), /진행 중/);
  await service.automation.tick();
  assert.equal(service.overview().events[0].status, 'ignored');
  assert.equal(service.hasActive(), false);
  await service.mutate('disconnect', {});
  assert.equal((await readFile(join(stateDir, 'slack-connection.json'), 'utf8')).includes('xoxp'), false);
  assert.equal(service.overview().connected, false);
  await assert.rejects(service.mutate('rules', { rules: [{}] }), { statusCode: 400 });
  await assert.rejects(service.mutate('settings', { enabled: true, extra: true }), { statusCode: 400 });
});
