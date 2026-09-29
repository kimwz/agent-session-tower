import test from 'node:test';
import assert from 'node:assert/strict';
import type { MasterFilter } from '../../shared/master.js';
import { runScreenCommand, type MasterControls } from '../../client/src/master/screen.js';
import { onOpenSettings, type SettingsRequest } from '../../client/src/settings/settings-open.js';

/** The page's controls, recording what the master asked of them. */
function page() {
  const done: unknown[][] = [];
  const controls: MasterControls = {
    selectSession: id => done.push(['selectSession', id]),
    openNewSession: (cwd, draft) => done.push(['openNewSession', cwd, draft]),
    openAutoPrompt: (cwd, node) => done.push(['openAutoPrompt', cwd, node]),
    showHelp: () => done.push(['showHelp']),
    showSessions: () => done.push(['showSessions']),
    filter: (filter: MasterFilter) => done.push(['filter', filter]),
  };
  return { controls, done };
}

test('screen commands go through the page\'s own controls, sessions and folders on joined computers included', () => {
  const { controls, done } = page();
  const node = 'b'.repeat(32);
  assert.deepEqual(runScreenCommand({ kind: 'openSession', sessionId: 'codex:1', node }, controls), { result: 'done' });
  runScreenCommand({ kind: 'close' }, controls);
  runScreenCommand({ kind: 'openPanel', panel: 'newSession', cwd: '/work/app', node, prompt: 'fix it' }, controls);
  runScreenCommand({ kind: 'openPanel', panel: 'autoPrompt' }, controls);
  runScreenCommand({ kind: 'openPanel', panel: 'autoPrompt', node }, controls);
  runScreenCommand({ kind: 'openPanel', panel: 'sessions' }, controls);
  runScreenCommand({ kind: 'filter', filter: { query: 'login' } }, controls);
  assert.deepEqual(done, [
    ['selectSession', `@${node}/codex:1`], ['selectSession', null],
    ['openNewSession', `@${node}//work/app`, { title: '', prompt: 'fix it' }],
    ['openAutoPrompt', undefined, ''], ['openAutoPrompt', undefined, node],
    ['showSessions'], ['filter', { query: 'login' }],
  ]);
});

test('a settings panel opens through the settings, as the owner\'s button would; one the page cannot show is reported, never guessed', t => {
  const asked: SettingsRequest[] = [];
  // Stands in for the settings button: this page offers triggers but not account management.
  const stop = onOpenSettings(request => { asked.push(request); return request.section !== 'account'; });
  t.after(stop);
  const { controls } = page();
  assert.deepEqual(runScreenCommand({ kind: 'openPanel', panel: 'triggers' }, controls), { result: 'done' });
  assert.deepEqual(runScreenCommand({ kind: 'openPanel', panel: 'skills' }, controls), { result: 'done' });
  const account = runScreenCommand({ kind: 'openPanel', panel: 'account' }, controls);
  assert.equal(account.result, 'unavailable');
  assert.match(String(account.note), /this computer/);
  assert.deepEqual(asked, [{ section: 'triggers' }, { section: 'skills' }, { section: 'account' }]);
  stop();
  assert.equal(runScreenCommand({ kind: 'openPanel', panel: 'remote' }, controls).result, 'unavailable', 'without a settings button on the page nothing opens');
});
