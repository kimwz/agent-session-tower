import test from 'node:test';
import assert from 'node:assert/strict';
import type { MasterFilter } from '../../shared/master.js';
import { runScreenCommand, type MasterControls } from '../../client/src/master/screen.js';

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

test('a header panel opens by pressing its own button; one the page does not offer is reported, never guessed', t => {
  const pressed: string[] = [];
  const buttons: Record<string, { disabled: boolean; click(): void }> = {
    triggers: { disabled: false, click: () => pressed.push('triggers') },
    remote: { disabled: true, click: () => pressed.push('remote') },
  };
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { querySelector: (selector: string) => buttons[/data-master-panel="([a-z]+)"/.exec(selector)![1]] ?? null };
  t.after(() => { (globalThis as { document?: unknown }).document = previous; });
  const { controls } = page();
  assert.deepEqual(runScreenCommand({ kind: 'openPanel', panel: 'triggers' }, controls), { result: 'done' });
  assert.equal(runScreenCommand({ kind: 'openPanel', panel: 'remote' }, controls).result, 'unavailable');
  assert.match(String(runScreenCommand({ kind: 'openPanel', panel: 'account' }, controls).note), /this computer/);
  assert.deepEqual(pressed, ['triggers']);
});
