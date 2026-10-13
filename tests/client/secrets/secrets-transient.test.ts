import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as jsxRuntime from 'react/jsx-runtime';
import type { ReactElement } from 'react';
import * as secretTypes from '../../../shared/secrets.js';
import * as secretsClient from '../../../client/src/secrets/secrets-client.js';
import { ApiError } from '../../../client/src/common/lib.js';
import type { SecretSessionView, SecretSettingsView } from '../../../shared/secrets.js';

type Element = ReactElement<Record<string, any>>;
function descendants(element: unknown): Element[] {
  if (!element || typeof element !== 'object' || !('props' in element)) return [];
  const node = element as Element;
  return [node, ...[node.props.children].flat(Infinity).flatMap(descendants)];
}
const text = (element: Element): string => [element.props.children].flat(Infinity).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : child && typeof child === 'object' && 'props' in child ? text(child as Element) : '').join('');

/** A sibling component stands in as a named function, so tests read the props it is given without rendering it. */
const stubs = new Map<string, Record<string, unknown>>();
function stubModule(name: string): Record<string, unknown> {
  if (!stubs.has(name)) {
    const cache = new Map<string, unknown>();
    stubs.set(name, new Proxy({}, { get: (_target, key) => {
      if (typeof key !== 'string' || key === 'then') return undefined;
      if (!cache.has(key)) cache.set(key, { [key]: () => null }[key]);
      return cache.get(key);
    } }));
  }
  return stubs.get(name)!;
}
const stub = (name: string, key: string) => stubModule(name)[key] as (props: unknown) => null;

/**
 * Runs one client file with a hook-slot React: state persists between renders, effects run after a render when their
 * dependencies changed, and the component's own children are returned as elements, not rendered.
 */
function fixture(file: string, component: string, props: Record<string, unknown>, options: { context?: unknown; real?: Record<string, unknown>; globals?: Record<string, unknown> } = {}) {
  let cursor = 0;
  const slots: any[] = [];
  const cleanups: (() => void)[] = [];
  const pending: (() => void)[] = [];
  const react = {
    createContext: () => ({}),
    useContext: () => options.context,
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(slots[index]) : value; }];
    },
    useRef(initial: unknown) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const index = cursor++; const previous = slots[index];
      if (previous && deps && previous.deps.length === deps.length && previous.deps.every((value: unknown, at: number) => Object.is(value, deps[at]))) return;
      slots[index] = { deps: deps ?? [] };
      pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); if (cleanup) { slots[index].cleanup = cleanup; cleanups.push(cleanup); } });
    },
    useCallback: (callback: unknown) => callback,
    useMemo: (build: () => unknown) => build(),
    useId: () => 'fixture',
  };
  const t = (value: string, values: Record<string, unknown> = {}) => value.replace(/\{(\w+)\}/g, (match, name) => name in values ? String(values[name]) : match);
  const module = { exports: {} as Record<string, (props: unknown) => Element> };
  const code = transformSync(readFileSync(new URL(`../../../client/src/${file.includes('/') ? file : `secrets/${file}`}`, import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  runInNewContext(code, { module, exports: module.exports, Uint8Array, btoa, AbortController, ...options.globals, require(name: string) {
    if (name in (options.real ?? {})) return options.real![name];
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'react-dom') return { createPortal: (node: unknown) => node };
    if (name.endsWith('/shared/secrets')) return secretTypes;
    if (name === '../i18n/i18n') return { useI18n: () => ({ t }) };
    if (name === '../common/lib') return { copyText: async () => true, relativeTime: () => 'now' };
    if (name === './secrets-client') return secretsClient;
    if (name === 'lucide-react' || name.startsWith('./') || name.startsWith('../')) return stubModule(name);
    throw new Error(`Unexpected fixture import: ${name}`);
  } });
  const render = () => { cursor = 0; const root = module.exports[component](props); while (pending.length) pending.shift()!(); return root; };
  return { render, props, exports: module.exports, cleanup: () => cleanups.forEach(cleanup => cleanup()) };
}

/** A `change` whose answers the test gives one by one. */
function changes() {
  const sent: [string, any][] = [];
  const answers: ((value: boolean) => void)[] = [];
  return { sent, change: async (action: string, body: unknown) => { sent.push([action, JSON.parse(JSON.stringify(body))]); return new Promise<boolean>(resolve => { answers.push(resolve); }); }, answer: (value = true) => answers.shift()!(value) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const formEvent = { preventDefault() {}, stopPropagation() {} };
const find = (root: Element, match: (element: Element) => boolean) => descendants(root).find(match)!;
const byType = (type: string) => (element: Element) => element.type === type;
const node = 'c'.repeat(32);
const device = { id: 'source', name: 'Source', signingKey: 's', encryptionKey: 'e', fingerprint: 'f' };
const sessionView = (patch: Partial<SecretSessionView> = {}): SecretSessionView => ({
  status: { initialized: true, locked: false },
  available: [{ id: 'global_key', name: 'GLOBAL_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: 'r', basis: ['global'], operations: ['env'] }],
  connectable: [{ id: 'lonely_key', name: 'LONELY_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: 'r' }, { id: 'global_key', name: 'GLOBAL_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: 'r' }],
  usage: [], unavailableSources: [], ...patch,
});
const settingsView: SecretSettingsView = { status: { initialized: true, locked: false }, device, peers: [{ device: { ...device, id: 'peer' }, routeId: node, direction: 'node', enabled: true }],
  secrets: [{ id: 'folder_key', name: 'FOLDER_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: 'r', sourceHostId: 'source', sharing: { revision: 5, global: false, folders: [{ hostId: 'source', root: '/work/app' }] } },
    { id: 'legacy_key', name: 'LEGACY_KEY', groupId: 'g', kind: 'scalar', version: 1, reference: 'r', sourceHostId: 'source', legacy: { global: [], folders: [{ hostId: 'peer', root: '/srv/app' }], limited: false } },
    { id: 'remote_key', name: 'REMOTE_KEY', groupId: 'g', kind: 'scalar', version: 1, reference: 'r', sourceHostId: 'elsewhere' }] };

test('a chat paste clears the value before the request resolves, never submits the chat, and connects it to this session only', async () => {
  const { sent, change, answer } = changes(); let connected = 0;
  const paste = fixture('SecretPaste.tsx', 'SecretPaste', { view: sessionView(), sessionId: `@${node}/codex:session`, cwd: `@${node}//srv/app`, busy: false, change, onConnected() { connected++; } });
  find(paste.render(), byType('textarea')).props.onChange({ target: { value: 'FAKE_PASTE_CANARY' } });
  let prevented = false; let stopped = false;
  find(paste.render(), byType('form')).props.onSubmit({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true);
  assert.deepEqual(sent, [['create', { name: 'SESSION_SECRET', kind: 'scalar', value: 'FAKE_PASTE_CANARY', connect: 'session', temporary: true, sessionId: 'codex:session', nodeId: node }]]);
  assert.equal(find(paste.render(), byType('textarea')).props.value, '', 'cleared before the answer');
  answer(); await tick(); assert.equal(connected, 1); paste.cleanup();
});

test('saving a paste to the vault sends the chosen sharing instead of a temporary value', async () => {
  const { sent, change, answer } = changes();
  const paste = fixture('SecretPaste.tsx', 'SecretPaste', { view: sessionView(), sessionId: 'claude:session', cwd: '/work/app', busy: false, change, onConnected() {} });
  find(paste.render(), byType('textarea')).props.onChange({ target: { value: 'API=FAKE' } });
  find(paste.render(), element => element.type === 'input' && element.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  const radios = descendants(paste.render()).filter(element => element.type === 'input' && element.props.type === 'radio');
  assert.equal(radios.length, 3, 'not shared, this folder, GLOBAL');
  radios[1]!.props.onChange();
  const submit = find(paste.render(), element => element.type === 'button' && element.props.type === 'submit');
  assert.equal(submit.props.disabled, false); assert.equal(text(submit), '저장하고 이 세션에 연결');
  find(paste.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(sent[0], ['create', { name: 'API', kind: 'env', value: 'API=FAKE', connect: 'session', sharing: { global: false, folders: [{ cwd: '/work/app' }] }, sessionId: 'claude:session' }]);
  answer(); await tick(); paste.cleanup();
});

test('a locked vault unlocks inline first, and unlock alone sends only the password', async () => {
  const locked = sessionView({ status: { initialized: true, locked: true }, error: 'locked' });
  const only = changes();
  const unlock = fixture('SecretPaste.tsx', 'SecretPaste', { view: locked, sessionId: 's', busy: false, change: only.change, onConnected() {} });
  find(unlock.render(), element => element.type === 'input' && element.props.type === 'password').props.onChange({ target: { value: 'FAKE_UNLOCK_PASSWORD' } });
  find(unlock.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(only.sent, [['unlock', { password: 'FAKE_UNLOCK_PASSWORD' }]]);
  assert.equal(find(unlock.render(), element => element.type === 'input' && element.props.type === 'password').props.value, '');
  only.answer(); await tick(); assert.equal(only.sent.length, 1); unlock.cleanup();
  const both = changes();
  const paste = fixture('SecretPaste.tsx', 'SecretPaste', { view: locked, sessionId: 's', busy: false, change: both.change, onConnected() {} });
  find(paste.render(), byType('textarea')).props.onChange({ target: { value: 'FAKE_VALUE' } });
  find(paste.render(), element => element.type === 'input' && element.props.type === 'password').props.onChange({ target: { value: 'FAKE_UNLOCK_PASSWORD' } });
  find(paste.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(both.sent.map(([action]) => action), ['unlock']);
  both.answer(); await tick();
  assert.deepEqual(both.sent.map(([action]) => action), ['unlock', 'create']); assert.equal(both.sent[1]![1].value, 'FAKE_VALUE');
  both.answer(); await tick(); paste.cleanup();
});

test('a paste that cannot reach this session is not sent, and closing a pending paste never reports it connected later', async () => {
  const blocked = changes();
  const closedSession = fixture('SecretPaste.tsx', 'SecretPaste', { view: sessionView({ error: 'session-closed', permanent: true }), sessionId: 's', busy: false, change: blocked.change, onConnected() {} });
  find(closedSession.render(), byType('textarea')).props.onChange({ target: { value: 'FAKE' } });
  assert.equal(find(closedSession.render(), element => element.type === 'button' && element.props.type === 'submit').props.disabled, true);
  find(closedSession.render(), byType('form')).props.onSubmit(formEvent); assert.deepEqual(blocked.sent, []);
  const { change, answer } = changes(); let connected = false;
  const paste = fixture('SecretPaste.tsx', 'SecretPaste', { view: sessionView(), sessionId: 's', busy: false, change, onConnected() { connected = true; } });
  find(paste.render(), byType('textarea')).props.onChange({ target: { value: 'FAKE_PENDING' } });
  find(paste.render(), byType('form')).props.onSubmit(formEvent); paste.cleanup(); answer();
  await tick(); assert.equal(connected, false);
});

test('a secret added in the settings is saved without a session, with the folders picked, and its value cleared at once', async () => {
  const { sent, change, answer } = changes(); let closed = false;
  const add = fixture('SecretAddForm.tsx', 'SecretAddForm', { view: settingsView, choices: [], busy: false, change, onClose() { closed = true; } });
  find(add.render(), element => element.type === 'input' && element.props.maxLength === 128).props.onChange({ target: { value: 'DEPLOY_KEY' } });
  find(add.render(), byType('textarea')).props.onChange({ target: { value: 'FAKE_ADD_CANARY' } });
  find(add.render(), element => element.type === stub('./SecretSharingEditor', 'SecretFolderPicker')).props.onKeys(['/work/app', `@${node}//srv/app`]);
  find(add.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(sent, [['create', { name: 'DEPLOY_KEY', kind: 'scalar', value: 'FAKE_ADD_CANARY', sharing: { global: false, folders: [{ cwd: '/work/app' }, { cwd: `@${node}//srv/app` }] } }]]);
  assert.equal(find(add.render(), byType('textarea')).props.value, '');
  answer(); await tick(); assert.equal(closed, true); add.cleanup();
});

test('an added empty file is accepted as its canonical empty base64 and named after the file', async () => {
  const { sent, change, answer } = changes();
  const add = fixture('SecretAddForm.tsx', 'SecretAddForm', { view: settingsView, choices: [], busy: false, change, onClose() {} });
  find(add.render(), element => element.type === 'select').props.onChange({ target: { value: 'file' } });
  await find(add.render(), element => element.type === 'input' && element.props.type === 'file').props.onChange({ target: { files: [{ name: 'empty.bin', size: 0, arrayBuffer: async () => new ArrayBuffer(0) }] }, currentTarget: { value: '' } });
  await tick();
  assert.equal(find(add.render(), element => element.type === 'button' && element.props.type === 'submit').props.disabled, false);
  find(add.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(sent[0], ['create', { name: 'empty.bin', kind: 'file', content: '' }]);
  answer(); await tick(); add.cleanup();
});

test('saving sharing sends the stored revision, GLOBAL and the picked folders as canvas keys', async () => {
  const { sent, change, answer } = changes(); let closed = false;
  const editor = fixture('SecretSharingEditor.tsx', 'SecretSharingEditor', { view: settingsView, item: settingsView.secrets[0], choices: [], busy: false, change, onClose() { closed = true; } });
  const picker = () => find(editor.render(), element => element.type === editor.exports.SecretFolderPicker);
  assert.deepEqual(picker().props.keys, ['/work/app']);
  find(editor.render(), element => element.type === 'input' && element.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  picker().props.onKeys(['/work/app', `@${node}//srv/app`]);
  find(editor.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(sent, [['sharing', { secretId: 'folder_key', revision: 5, global: true, folders: [{ cwd: '/work/app' }, { cwd: `@${node}//srv/app` }] }]]);
  answer(); await tick(); assert.equal(closed, true); editor.cleanup();
  const legacy = changes();
  const prefilled = fixture('SecretSharingEditor.tsx', 'SecretSharingEditor', { view: settingsView, item: settingsView.secrets[1], choices: [], busy: false, change: legacy.change, onClose() {} });
  find(prefilled.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(legacy.sent, [['sharing', { secretId: 'legacy_key', revision: 0, global: false, folders: [{ cwd: `@${node}//srv/app` }] }]], 'what the rules shared, exactly as shown');
  legacy.answer(); await tick(); prefilled.cleanup();
});

test('the available tab changes the session only through its buttons', async () => {
  const { sent, change, answer } = changes(); const asked: string[] = []; let pasted = 0;
  const available = fixture('SecretAvailable.tsx', 'SecretAvailable', { view: sessionView(), busy: false, change, onPaste() { pasted++; }, onSharing(id: string) { asked.push(id); } });
  find(available.render(), element => element.props['aria-expanded'] === false).props.onClick();
  assert.deepEqual(sent, [], 'opening the picker connects nothing');
  find(available.render(), element => element.props['aria-label'] === 'LONELY_KEY 이 세션에 연결').props.onClick();
  assert.deepEqual(sent, [['session-connect', { secretIds: ['lonely_key'] }]]); answer(); await tick();
  find(available.render(), element => element.props['aria-label'] === 'GLOBAL_KEY 이 세션에서 끊기').props.onClick();
  assert.deepEqual(sent[1], ['session-disconnect', { secretIds: ['global_key'] }]); answer(); await tick();
  find(available.render(), element => element.props['aria-label'] === 'GLOBAL_KEY 공유 설정').props.onClick();
  find(available.render(), element => element.type === 'button' && text(element) === '새 시크릿 추가').props.onClick();
  assert.deepEqual(asked, ['global_key']); assert.equal(pasted, 1); assert.equal(sent.length, 2);
  available.cleanup();
});

/** The composer's shared state as the chat dialog reads it. */
function composer(patch: Record<string, unknown> = {}) {
  const calls: unknown[][] = []; const settings: unknown[] = [];
  const state = { token: 'token', sessionId: 'claude:session', cwd: '/work/app', view: sessionView(), error: '', busy: false, tab: undefined as string | undefined,
    change: async (...args: unknown[]) => { calls.push(['change', ...args]); return true; }, reload: () => calls.push(['reload']),
    show: (tab: string) => calls.push(['show', tab]), close: () => calls.push(['close']), ...patch };
  const globals = { document: { body: {}, activeElement: null }, window: {} };
  const real = { '../settings/settings-open': { openSettings: (request: unknown) => { settings.push(JSON.parse(JSON.stringify(request))); return true; } } };
  return { state, calls, settings, load: (name: string, props: Record<string, unknown> = {}) => fixture('SecretChatDialog.tsx', name, props, { context: state, globals, real }) };
}

test('the composer button always opens the paste tab, and chips of used secrets open the available tab', () => {
  const chat = composer();
  find(chat.load('SecretComposer').render(), element => element.type === 'button').props.onClick();
  assert.deepEqual(chat.calls, [['show', 'paste']]);
  assert.equal(chat.load('SecretChips').render(), null, 'no chips before anything is used');
  const used = composer({ view: sessionView({ usage: [{ at: 2, secretId: 'a', name: 'A_KEY', operation: 'env', outcome: 'delivered', review: 'exempt' }, { at: 1, secretId: 'a', name: 'A_KEY', operation: 'pipe', outcome: 'delivered', review: 'exempt' }] }) });
  const chips = descendants(used.load('SecretChips').render()).filter(element => element.type === 'button');
  assert.equal(chips.length, 1); assert.match(text(chips[0]!), /A_KEY/);
  chips[0]!.props.onClick();
  assert.deepEqual(used.calls, [['show', 'available']]);
});

test('switching tabs and closing the dialog never change the session; sharing opens the settings on that secret', () => {
  const chat = composer({ tab: 'paste' });
  const portal = find(chat.load('SecretComposer').render(), element => typeof element.type === 'function' && element.type.name === 'SecretChatDialog');
  const dialog = chat.load('SecretChatDialog', portal.props);
  let root = dialog.render();
  const tabs = descendants(root).filter(element => element.props.role === 'tab');
  assert.deepEqual(tabs.map(tab => tab.props['aria-selected']), [true, false]);
  assert.ok(find(root, element => element.type === stub('./SecretPaste', 'SecretPaste')), 'the paste tab shows the paste form');
  tabs[1]!.props.onClick();
  tabs[1]!.props.onClick();
  find(root, element => element.props.role === 'tablist').props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  let prevented = false;
  find(root, byType('dialog')).props.onCancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(chat.calls, [['show', 'available'], ['show', 'available'], ['show', 'available'], ['close']]);
  const available = composer({ tab: 'available' });
  const second = available.load('SecretChatDialog', { state: available.state, tab: 'available' });
  root = second.render();
  assert.ok(find(root, element => element.type === stub('./SecretBrokerApproval', 'SecretBrokerApproval')), 'the broker approval stays until PR2');
  find(root, element => element.type === stub('./SecretAvailable', 'SecretAvailable')).props.onSharing('global_key');
  assert.deepEqual(available.calls, [['close']]);
  assert.deepEqual(available.settings, [{ section: 'secrets', secretId: 'global_key' }]);
  assert.ok(!available.calls.some(([kind]) => kind === 'change'));
});

test('settings opened for one secret open its sharing editor once, and only for a secret this vault owns', () => {
  const opened = fixture('SecretSettings.tsx', 'SecretSettingsWorkspace', { view: settingsView, choices: [], busy: false, change: async () => true, focus: 'legacy_key' });
  opened.render();
  const editor = opened.render();
  assert.equal(editor.type, stub('./SecretSharingEditor', 'SecretSharingEditor')); assert.equal(editor.props.item.id, 'legacy_key');
  editor.props.onClose();
  assert.notEqual(opened.render().type, stub('./SecretSharingEditor', 'SecretSharingEditor'), 'closing it stays closed');
  const remote = fixture('SecretSettings.tsx', 'SecretSettingsWorkspace', { view: settingsView, choices: [], busy: false, change: async () => true, focus: 'remote_key' });
  remote.render();
  assert.notEqual(remote.render().type, stub('./SecretSharingEditor', 'SecretSharingEditor'));
});

test('the settings read their view once when shown, and a stale sharing save reloads it and says so', async () => {
  let reads = 0; const posted: unknown[] = [];
  const client = { ...secretsClient,
    readSecretSettings: async () => { reads++; return settingsView; },
    postSecret: async (action: string, _token: string, body: unknown) => { posted.push([action, body]); throw new ApiError('conflict', 409); } };
  const panel = fixture('SecretsPanel.tsx', 'SecretsPanel', { token: 'token', folders: [] }, { context: { active: true }, real: { './secrets-client': client } });
  panel.render(); await tick(); panel.render(); panel.render();
  assert.equal(reads, 1, 'never polled');
  const workspace = () => find(panel.render(), element => element.type === stub('./SecretSettings', 'SecretSettingsWorkspace'));
  assert.equal(await workspace().props.change('sharing', { secretId: 'folder_key', revision: 4, global: true, folders: [] }), false);
  const root = panel.render(); await tick();
  assert.equal(reads, 2, 'the conflict reloads what is stored now');
  assert.match(text(find(root, element => element.props.role === 'status' && element.type === 'p')), /다른 곳에서 바뀌었습니다/);
  assert.deepEqual(posted, [['sharing', { secretId: 'folder_key', revision: 4, global: true, folders: [] }]]);
  panel.cleanup();
});

test('the settings dialog hands every computer’s folders and the asked secret to the secrets section', () => {
  const secretFolders = [{ key: `@${node}//srv/app`, label: 'app', computer: 'Build server' }];
  const context = { token: 'token', providers: [], projects: [], secretFolders, computers: [], targets: () => ({ projects: [], sessions: [] }), controlledBy: [], showHidden: false, onShowHiddenChange() {}, onOpenSession() {} };
  const dialog = fixture('settings/SettingsDialog.tsx', 'SettingsDialog', { place: { section: 'secrets', secretId: 'folder_key' }, sections: ['secrets'], attention: {}, context, onPlace() {}, onChanged() {}, onClose() {} }, { globals: { document: { body: {}, activeElement: null } } });
  const panel = find(dialog.render(), element => element.type === stub('../secrets/SecretsPanel', 'SecretsPanel'));
  assert.equal(panel.props.folders, secretFolders); assert.equal(panel.props.focus, 'folder_key'); assert.equal(panel.props.token, 'token');
});

test('pending import sends only the selected ID and transient source password and clears input immediately', async () => {
  const { sent, change, answer } = changes();
  const fixtureImport = fixture('SecretRecovery.tsx', 'SecretPendingImport', { ids: ['backup-a', 'backup-b'], busy: false, change, onClose() {} });
  let root = fixtureImport.render();
  find(root, byType('select')).props.onChange({ target: { value: 'backup-b' } });
  find(root, byType('input')).props.onChange({ target: { value: 'original-source-password' } });
  root = fixtureImport.render();
  const pending = root.props.onSubmit(formEvent);
  assert.deepEqual(sent, [['import', { id: 'backup-b', password: 'original-source-password' }]]);
  assert.equal(find(fixtureImport.render(), byType('input')).props.value, '');
  answer(); await pending; fixtureImport.cleanup();
});

test('value replacement submits the existing ID and new value without putting it in metadata or leaving it on screen', async () => {
  const { sent, change, answer } = changes();
  const secret = { id: 'key', name: 'TOKEN', kind: 'scalar', version: 3, groupId: 'group', reference: 'tower-secret://v/key@3' };
  const editor = fixture('SecretRecovery.tsx', 'SecretValueEditor', { secret, busy: false, change, onClose() {} });
  find(editor.render(), byType('textarea')).props.onChange({ target: { value: 'next-value-canary' } });
  const pending = editor.render().props.onSubmit(formEvent);
  assert.deepEqual(sent, [['update', { id: 'key', value: 'next-value-canary' }]]);
  assert.equal(find(editor.render(), byType('textarea')).props.value, '');
  assert.doesNotMatch(JSON.stringify(secret), /next-value-canary/);
  answer(); await pending; editor.cleanup();
});
