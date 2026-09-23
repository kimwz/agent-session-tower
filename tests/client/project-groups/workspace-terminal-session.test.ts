import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceTerminalSession, forgetWorkspaceTerminal, MAX_TERMINAL_TABS, nextTerminalTab, readTerminalTabs, saveTerminalTabs, terminalSlot } from '../../../client/src/workspace/terminal-session.js';

const firstId = '10000000-0000-4000-8000-000000000001';
const secondId = '10000000-0000-4000-8000-000000000002';

test('terminal creation is coalesced across component effect remounts', async () => {
  let creations = 0;
  let finish!: (id: string) => void;
  const create = () => { creations++; return new Promise<string>(resolve => { finish = resolve; }); };
  const first = workspaceTerminalSession('/fixture/coalesce', async () => {}, create);
  const remount = workspaceTerminalSession('/fixture/coalesce', async () => {}, create);
  finish(firstId);
  assert.deepEqual(await Promise.all([first, remount]), [firstId, firstId]);
  assert.equal(creations, 1);
  let resumed = '';
  assert.equal(await workspaceTerminalSession('/fixture/coalesce', async id => { resumed = id; }, create), firstId);
  assert.equal(resumed, firstId);
  assert.equal(creations, 1);
  forgetWorkspaceTerminal('/fixture/coalesce', firstId);
});

test('saved terminal IDs reconnect after a browser reload and explicit close forgets them', async t => {
  const values = new Map([['agent-monitor.workspace-terminal:/fixture/reload', firstId]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  let creations = 0;
  assert.equal(await workspaceTerminalSession('/fixture/reload', async id => { assert.equal(id, firstId); }, async () => { creations++; return secondId; }), firstId);
  assert.equal(creations, 0);
  forgetWorkspaceTerminal('/fixture/reload', firstId);
  assert.equal(values.size, 0);
  assert.equal(await workspaceTerminalSession('/fixture/reload', async () => {}, async () => { creations++; return secondId; }), secondId);
  assert.equal(creations, 1);
  forgetWorkspaceTerminal('/fixture/reload', secondId);
});

test('a connection failure never creates a replacement for a possibly running shell', async () => {
  const cwd = '/fixture/offline';
  await workspaceTerminalSession(cwd, async () => {}, async () => firstId);
  let creations = 0;
  const create = async () => { creations++; return secondId; };
  await assert.rejects(workspaceTerminalSession(cwd, async () => { throw new Error('network unavailable'); }, create), /network unavailable/);
  assert.equal(creations, 0);
  assert.equal(await workspaceTerminalSession(cwd, async () => { throw Object.assign(new Error('gone'), { status: 404 }); }, create), secondId);
  assert.equal(creations, 1);
  forgetWorkspaceTerminal(cwd, secondId);
});

test('terminal tabs persist per folder, keep the first tab on the pre-tab slot and give later tabs their own shells', async t => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const cwd = '/fixture/tabs';
  const [main] = readTerminalTabs(cwd);
  assert.deepEqual(main, { key: 'main', number: 1 });
  assert.equal(terminalSlot(cwd, main), cwd);
  const second = nextTerminalTab([main]);
  assert.equal(second.number, 2);
  assert.notEqual(terminalSlot(cwd, second), cwd);
  saveTerminalTabs(cwd, [second]);
  assert.deepEqual(readTerminalTabs(cwd), [second]);
  assert.deepEqual(readTerminalTabs('/fixture/other'), [{ key: 'main', number: 1 }]);
  assert.equal(nextTerminalTab([second]).number, 3);
  saveTerminalTabs(cwd, []);
  assert.deepEqual(readTerminalTabs(cwd), [], 'closing every tab is remembered');
  for (const invalid of ['not json', JSON.stringify([{ key: 'Bad Key', number: 1 }]), JSON.stringify([main, main]),
    JSON.stringify(Array.from({ length: MAX_TERMINAL_TABS + 1 }, (_, index) => ({ key: `t${index}`, number: index + 1 })))]) {
    values.set(`agent-monitor.workspace-terminal-tabs:${cwd}`, invalid);
    assert.deepEqual(readTerminalTabs(cwd), [{ key: 'main', number: 1 }]);
  }
  let created = 0;
  const create = async () => [firstId, secondId][created++];
  assert.equal(await workspaceTerminalSession(terminalSlot(cwd, main), async () => {}, create), firstId);
  assert.equal(await workspaceTerminalSession(terminalSlot(cwd, second), async () => {}, create), secondId);
  assert.equal(created, 2);
  forgetWorkspaceTerminal(terminalSlot(cwd, main), firstId);
  forgetWorkspaceTerminal(terminalSlot(cwd, second), secondId);
});
