import test from 'node:test';
import assert from 'node:assert/strict';
import { bindWorkspaceTerminal, savedWorkspaceTerminal, settleTerminalRequest, terminalRequest, workspaceTerminalSession, forgetWorkspaceTerminal, MAX_TERMINAL_TABS, nextTerminalTab, readTerminalTabs, saveTerminalTabs, terminalSlot } from '../../../client/src/workspace/terminal-session.js';
import { workspacePath } from '../../../client/src/remote/scope.js';

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
  const joined = { ...nextTerminalTab([main]), joined: true as const };
  saveTerminalTabs(cwd, [main, joined]);
  assert.deepEqual(readTerminalTabs(cwd), [main, joined], 'a tab that joined a shell opened elsewhere is remembered as such');
  for (const invalid of ['not json', JSON.stringify([{ key: 'Bad Key', number: 1 }]), JSON.stringify([main, main]), JSON.stringify([{ ...main, joined: 'yes' }]),
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

test('a tab joining a shell opened elsewhere reconnects to it instead of starting one', async () => {
  const slot = terminalSlot('/fixture/join', { key: 'joined', number: 2 });
  assert.equal(savedWorkspaceTerminal(slot), undefined);
  bindWorkspaceTerminal(slot, secondId);
  assert.equal(savedWorkspaceTerminal(slot), secondId);
  let created = 0;
  let resumed = '';
  assert.equal(await workspaceTerminalSession(slot, async id => { resumed = id; }, async () => { created++; return firstId; }), secondId);
  assert.equal(resumed, secondId);
  assert.equal(created, 0);
  bindWorkspaceTerminal(slot, 'not-an-id');
  assert.equal(savedWorkspaceTerminal(slot), secondId, 'only a shell ID can be joined');
  forgetWorkspaceTerminal(slot, secondId);
});

test('the request that opens a tab’s shell on another computer is kept across reloads until its answer is known', async t => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const slot = terminalSlot('@remote/fixture', { key: 'main', number: 1 });
  let made = 0;
  const create = () => [firstId, secondId][made++];
  assert.deepEqual(terminalRequest(slot, create), { id: firstId, reused: false });
  assert.deepEqual(terminalRequest(slot, create), { id: firstId, reused: true }, 'after a lost answer, and after a reload, the same request goes again');
  settleTerminalRequest(slot, 'unknown');
  settleTerminalRequest(slot, 'refused');
  assert.deepEqual(terminalRequest(slot, create), { id: firstId, reused: true }, 'a refusal after a try that may have run does not free the request');
  settleTerminalRequest(slot);
  assert.deepEqual(terminalRequest(slot, create), { id: secondId, reused: false }, 'once answered, the next shell is a new request');
  settleTerminalRequest(slot, 'refused');
  assert.deepEqual(terminalRequest(slot, create).reused, false, 'a request refused before anything ran is not kept');
});

test('workspace requests for another computer’s folder go to that computer with its own path', () => {
  const node = 'b'.repeat(32);
  assert.equal(workspacePath('/work/app', '/api/workspace/tree', { path: 'src' }), '/api/workspace/tree?cwd=%2Fwork%2Fapp&path=src');
  assert.equal(workspacePath(`@${node}//work/app`, '/api/workspace/file', { path: 'a b.md' }), `/api/nodes/${node}/workspace/file?cwd=%2Fwork%2Fapp&path=a+b.md`);
  assert.equal(workspacePath(`@${node}//work/app`, '/api/workspace/terminals'), `/api/nodes/${node}/workspace/terminals?cwd=%2Fwork%2Fapp`);
});
