import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { startSlackMonitorPoll } from '../../../client/src/slack/slack-monitor-poll.js';
import { slackChatSelection } from '../../../client/src/slack/slack-chat-selection.js';
import type { SlackPublicStatus } from '../../../shared/slack.js';

type HookResult = { slack: SlackPublicStatus | null; error: string; loadError: string; refresh(): Promise<void> };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** Run the real hook's effects against deterministic HTTP fixtures, without a browser or native provider. */
function fixture(languageFailure = false) {
  let cursor = 0;
  const slots: Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }> = [];
  let effects: Array<() => void> = [];
  const pending: Array<{ resolve(value: SlackPublicStatus): void; reject(cause: Error): void }> = [];
  const calls: string[] = [];
  const react = {
    useState(initial: unknown) {
      const slot = slots[cursor++] ??= { value: initial };
      return [slot.value, (value: unknown) => { slot.value = value; }];
    },
    useRef(initial: unknown) { const slot = slots[cursor++] ??= { value: { current: initial } }; return slot.value; },
    useCallback(callback: unknown) { return callback; },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) {
      const slot = slots[cursor++] ??= {};
      if (slot.deps && deps.every((value, index) => Object.is(value, slot.deps![index]))) return;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; });
      slot.deps = deps;
    },
  };
  const window = new EventTarget();
  const module = { exports: {} as { useSlackMonitor(connected: boolean, token?: string): HookResult } };
  const code = transformSync(readFileSync(new URL('../../../client/src/slack/use-slack-monitor.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  runInNewContext(code, { module, exports: module.exports, window, Error, require(name: string) {
    if (name === 'react') return react;
    if (name === './slack-monitor-poll') return { startSlackMonitorPoll };
    if (name === '../i18n/i18n') return { useI18n: () => ({ language: 'ko' }), translate: (value: string) => value };
    if (name === '../../../shared/app-identity') return { REQUEST_TOKEN_HEADER: 'X-Agent-Monitor-Token' };
    if (name === '../common/lib') return { api(path: string) {
      calls.push(path);
      if (path === '/api/slack/settings') return languageFailure ? Promise.reject(new Error('language failed')) : Promise.resolve();
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    } };
    throw new Error(`Unexpected import ${name}`);
  } });
  return {
    calls, pending,
    render(connected: boolean, token = '') {
      cursor = 0;
      const result = module.exports.useSlackMonitor(connected, token);
      const next = effects; effects = []; next.forEach(effect => effect());
      return result;
    },
    dispose() { slots.forEach(slot => slot.cleanup?.()); },
  };
}
const overview: SlackPublicStatus = { connected: false, enabled: false, status: 'off', rules: [], events: [{ id: 'workflow', mode: 'conversation', sessionId: 'coordinator',
  mention: { id: 'mention', teamId: 'test', channel: 'test', user: 'test', ts: '1', threadTs: '1', text: '' }, status: 'completed', createdAt: '', updatedAt: '', rules: [] }] };

test('first overview stays missing until its response; language errors do not become visibility errors', async () => {
  const f = fixture(true);
  try {
    assert.equal(f.render(false).slack, null);
    assert.equal(f.render(true, 'token').slack, null);
    await flush();
    const pending = f.render(true, 'token');
    assert.equal(pending.slack, null);
    assert.equal(pending.error, 'language failed');
    assert.equal(pending.loadError, '');
    f.pending[0].resolve(overview); await flush();
    const loaded = f.render(true, 'token');
    assert.equal(loaded.slack, overview, 'disabled Slack is a successful empty-account overview');
    assert.equal(loaded.loadError, '');
    assert.deepEqual(f.calls, ['/api/slack', '/api/slack/settings']);
  } finally { f.dispose(); }
});

test('reconnect and failed reload retain coordinator selection and the last successful visibility data', async () => {
  const f = fixture();
  try {
    f.render(true); f.pending[0].resolve(overview); await flush();
    const loaded = f.render(true);
    assert.equal(slackChatSelection(loaded.slack!.events, undefined, 'coordinator').mentionId, 'workflow');
    assert.equal(f.render(false).slack, overview);
    assert.equal(f.render(true).slack, overview);
    f.pending[1].reject(new Error('temporarily offline')); await flush();
    const stale = f.render(true);
    assert.equal(stale.slack, overview);
    assert.equal(stale.loadError, 'temporarily offline');
    assert.equal(slackChatSelection(stale.slack!.events, undefined, 'coordinator').mentionId, 'workflow');
  } finally { f.dispose(); }
});

test('a failed first overview can be retried without requesting a session snapshot', async () => {
  const f = fixture();
  try {
    f.render(true); f.pending[0].reject(new Error('offline')); await flush();
    const failed = f.render(true);
    assert.equal(failed.slack, null);
    assert.equal(failed.loadError, 'offline');
    const retry = failed.refresh();
    f.pending[1].resolve(overview); await retry;
    assert.equal(f.render(true).slack, overview);
    assert.deepEqual(f.calls, ['/api/slack', '/api/slack']);
  } finally { f.dispose(); }
});
