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
import type { SecretSessionView, SecretSettingsView, SecretValue } from '../../../shared/secrets.js';

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
  usage: [], unavailableSources: [], updatePendingSources: [], ...patch,
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

const unlockFields = (root: Element) => find(root, element => element.type === stub('./SecretAccess', 'SecretUnlockFields'));
test('a locked vault unlocks inline first, and unlock alone sends only the password', async () => {
  const locked = sessionView({ status: { initialized: true, locked: true }, error: 'locked' });
  const only = changes();
  const unlock = fixture('SecretPaste.tsx', 'SecretPaste', { view: locked, sessionId: 's', busy: false, change: only.change, onConnected() {} });
  assert.equal(unlockFields(unlock.render()).props.mode, 'vault', 'without Tower-password support the vault password opens it, as before');
  unlockFields(unlock.render()).props.onPassword('FAKE_UNLOCK_PASSWORD');
  find(unlock.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(only.sent, [['unlock', { password: 'FAKE_UNLOCK_PASSWORD' }]]);
  assert.equal(unlockFields(unlock.render()).props.password, '');
  only.answer(); await tick(); assert.equal(only.sent.length, 1); unlock.cleanup();
  const both = changes();
  const paste = fixture('SecretPaste.tsx', 'SecretPaste', { view: locked, sessionId: 's', busy: false, change: both.change, onConnected() {} });
  find(paste.render(), byType('textarea')).props.onChange({ target: { value: 'FAKE_VALUE' } });
  unlockFields(paste.render()).props.onPassword('FAKE_UNLOCK_PASSWORD');
  find(paste.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(both.sent.map(([action]) => action), ['unlock']);
  both.answer(); await tick();
  assert.deepEqual(both.sent.map(([action]) => action), ['unlock', 'create']); assert.equal(both.sent[1]![1].value, 'FAKE_VALUE');
  both.answer(); await tick(); paste.cleanup();
});

test('the paste tab opens a vault linked to the Tower password with it, and asks for the recovery password with it when the server needs it', async () => {
  const ready = sessionView({ status: { initialized: true, locked: true, towerPassword: 'ready' }, error: 'locked' });
  const sent: [string, any][] = [];
  const change = async (action: string, body: unknown, refused?: (code: string) => boolean) => { sent.push([action, body]); return sent.length === 1 ? (assert.equal(refused?.('needs-recovery'), true), false) : true; };
  const paste = fixture('SecretPaste.tsx', 'SecretPaste', { view: ready, sessionId: 's', busy: false, change, onConnected() {} });
  assert.equal(unlockFields(paste.render()).props.mode, 'tower');
  unlockFields(paste.render()).props.onPassword('FAKE_TOWER_PASSWORD');
  find(paste.render(), byType('form')).props.onSubmit(formEvent); await tick();
  assert.deepEqual(sent, [['view-unlock', { password: 'FAKE_TOWER_PASSWORD' }]]);
  const fields = unlockFields(paste.render()).props;
  assert.equal(fields.mode, 'both'); assert.equal(fields.password, 'FAKE_TOWER_PASSWORD', 'the Tower password stays; only the recovery password is asked for');
  fields.onRecoveryPassword('FAKE_RECOVERY_PASSWORD');
  find(paste.render(), byType('form')).props.onSubmit(formEvent); await tick();
  assert.deepEqual(sent[1], ['view-unlock', { password: 'FAKE_TOWER_PASSWORD', recoveryPassword: 'FAKE_RECOVERY_PASSWORD' }]);
  assert.equal(unlockFields(paste.render()).props.recoveryPassword, '');
  paste.cleanup();
});

test('settings and the chat open a locked vault per its Tower-password state, with a switch to the recovery password', async () => {
  const status = (towerPassword?: 'ready' | 'missing') => ({ initialized: true, locked: true, ...(towerPassword ? { towerPassword } : {}) });
  const open = (towerPassword?: 'ready' | 'missing', change: (...args: any[]) => Promise<boolean> = async () => true) => {
    const access = fixture('SecretAccess.tsx', 'SecretAccess', { status: status(towerPassword), busy: false, change });
    const fields = () => find(access.render(), element => element.type === access.exports.SecretUnlockFields).props;
    const submit = async () => { find(access.render(), byType('form')).props.onSubmit(formEvent); await tick(); };
    return { access, fields, submit };
  };
  const sent: [string, any][] = []; const record = async (action: string, body: unknown) => { sent.push([action, body]); return true; };
  const ready = open('ready', record);
  assert.equal(ready.fields().mode, 'tower');
  ready.fields().onPassword('FAKE_TOWER'); await ready.submit();
  assert.deepEqual(sent.pop(), ['view-unlock', { password: 'FAKE_TOWER' }]); assert.equal(ready.fields().password, '');
  ready.fields().onRecovery(true);
  assert.equal(ready.fields().mode, 'recovery');
  ready.fields().onPassword('FAKE_RECOVERY'); await ready.submit();
  assert.deepEqual(sent.pop(), ['unlock', { password: 'FAKE_RECOVERY' }], 'the switch opens the vault alone with the recovery password');
  ready.fields().onRecovery(false); assert.equal(ready.fields().mode, 'tower');
  const missing = open('missing', record);
  assert.equal(missing.fields().mode, 'both');
  missing.fields().onPassword('FAKE_TOWER'); missing.fields().onRecoveryPassword('FAKE_RECOVERY'); await missing.submit();
  assert.deepEqual(sent.pop(), ['view-unlock', { password: 'FAKE_TOWER', recoveryPassword: 'FAKE_RECOVERY' }]);
  const vault = open(undefined, record);
  assert.equal(vault.fields().mode, 'vault');
  vault.fields().onPassword('FAKE_VAULT'); await vault.submit();
  assert.deepEqual(sent.pop(), ['unlock', { password: 'FAKE_VAULT' }]);
  // A needs-recovery answer switches to both fields with the Tower password kept; other refusals stay the hook's to show.
  const codes: boolean[] = [];
  const asking = open('ready', async (action: string, body: unknown, refused?: (code: string) => boolean) => { sent.push([action, body]); codes.push(refused!('login-required'), refused!('needs-recovery')); return false; });
  asking.fields().onPassword('FAKE_TOWER'); await asking.submit();
  assert.deepEqual(codes, [false, true]);
  assert.equal(asking.fields().mode, 'both'); assert.equal(asking.fields().password, 'FAKE_TOWER');
  asking.fields().onRecoveryPassword('FAKE_RECOVERY'); await asking.submit();
  assert.deepEqual(sent.slice(-1), [['view-unlock', { password: 'FAKE_TOWER', recoveryPassword: 'FAKE_RECOVERY' }]]);
});

test('a paste that cannot reach this session is not sent', () => {
  const blocked = changes();
  const closedSession = fixture('SecretPaste.tsx', 'SecretPaste', { view: sessionView({ error: 'session-closed', permanent: true }), sessionId: 's', busy: false, change: blocked.change, onConnected() {} });
  find(closedSession.render(), byType('textarea')).props.onChange({ target: { value: 'FAKE' } });
  assert.equal(find(closedSession.render(), element => element.type === 'button' && element.props.type === 'submit').props.disabled, true);
  find(closedSession.render(), byType('form')).props.onSubmit(formEvent); assert.deepEqual(blocked.sent, []);
});

test('closing a pending quick dialog prevents its response from closing a later dialog', async () => {
  const { change, answer } = changes(); let connected = false;
  const paste = fixture('SecretPaste.tsx', 'SecretPaste', { view: sessionView(), sessionId: 's', busy: false, change, onConnected() { connected = true; } });
  find(paste.render(), byType('textarea')).props.onChange({ target: { value: 'FAKE_PENDING' } });
  find(paste.render(), byType('form')).props.onSubmit(formEvent); paste.cleanup(); answer();
  await tick(); assert.equal(connected, false);
});

test('a secret added in the settings is saved without a session, with the folders picked, and its value cleared at once', async () => {
  const { sent, change, answer } = changes(); let closed = false;
  const add = fixture('SecretAddForm.tsx', 'SecretAddForm', { view: settingsView, canvas: { folders: [], hosts: [] }, busy: false, change, onClose() { closed = true; } });
  find(add.render(), element => element.type === 'input' && element.props.maxLength === 128).props.onChange({ target: { value: 'DEPLOY_KEY' } });
  find(add.render(), byType('textarea')).props.onChange({ target: { value: 'FAKE_ADD_CANARY' } });
  find(add.render(), element => element.type === stub('./SecretSharingEditor', 'SecretFolderPicker')).props.onKeys(['/work/app', `@${node}//srv/app`]);
  find(add.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(sent, [['create', { name: 'DEPLOY_KEY', kind: 'scalar', value: 'FAKE_ADD_CANARY', sharing: { global: false, folders: [{ cwd: '/work/app' }, { cwd: `@${node}//srv/app` }] } }]]);
  assert.equal(find(add.render(), byType('textarea')).props.value, '');
  answer(); await tick(); assert.equal(closed, true); add.cleanup();
});

test('registration accepts empty uploaded file bytes and sends their canonical empty base64', async () => {
  const { sent, change, answer } = changes();
  const add = fixture('SecretAddForm.tsx', 'SecretAddForm', { view: settingsView, canvas: { folders: [], hosts: [] }, busy: false, change, onClose() {} });
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
  const stored = { ...settingsView.secrets[0]!, sharing: { revision: 5, global: false, folders: [{ hostId: 'source', root: '/work/app' }, { hostId: 'gone', root: '/old' }] } };
  const editor = fixture('SecretSharingEditor.tsx', 'SecretSharingEditor', { view: settingsView, item: stored, canvas: { folders: [], hosts: [] }, busy: false, change, onClose() { closed = true; } });
  const picker = () => find(editor.render(), element => element.type === editor.exports.SecretFolderPicker);
  assert.deepEqual(picker().props.keys, ['/work/app']);
  find(editor.render(), element => element.type === 'input' && element.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  picker().props.onKeys(['/work/app', `@${node}//srv/app`]);
  find(editor.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(sent, [['sharing', { secretId: 'folder_key', revision: 5, global: true, folders: [{ hostId: 'source', root: '/work/app' }, { cwd: `@${node}//srv/app` }, { hostId: 'gone', root: '/old' }] }]],
    'saved folders stay as they were received; only the newly picked one is a canvas key');
  answer(); await tick(); assert.equal(closed, true); editor.cleanup();
  const removing = changes();
  const trimmed = fixture('SecretSharingEditor.tsx', 'SecretSharingEditor', { view: settingsView, item: stored, canvas: { folders: [], hosts: [] }, busy: false, change: removing.change, onClose() {} });
  find(trimmed.render(), element => element.props['aria-label'] === 'old 선택 해제').props.onClick();
  find(trimmed.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(removing.sent[0]![1].folders, [{ hostId: 'source', root: '/work/app' }]);
  removing.answer(); await tick(); trimmed.cleanup();
  const legacy = changes();
  const prefilled = fixture('SecretSharingEditor.tsx', 'SecretSharingEditor', { view: settingsView, item: settingsView.secrets[1], canvas: { folders: [], hosts: [] }, busy: false, change: legacy.change, onClose() {} });
  find(prefilled.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(legacy.sent, [['sharing', { secretId: 'legacy_key', revision: 0, global: false, folders: [{ cwd: `@${node}//srv/app` }] }]], 'what the rules shared, exactly as shown');
  legacy.answer(); await tick(); prefilled.cleanup();
});

test('connecting a saved secret offers only those this session cannot use now, named by kind as in the settings', () => {
  const { sent, change } = changes();
  const available = fixture('SecretAvailable.tsx', 'SecretAvailable', { view: sessionView(), busy: false, change, onPaste() {}, onSharing() {} });
  find(available.render(), element => element.props['aria-expanded'] === false).props.onClick();
  const root = available.render();
  const offered = descendants(root).filter(element => typeof element.props['aria-label'] === 'string' && element.props['aria-label'].endsWith(' 이 세션에 연결')).map(element => element.props['aria-label']);
  assert.deepEqual(offered, ['LONELY_KEY 이 세션에 연결'], 'GLOBAL_KEY is already available here; a secret disconnected here is not, so it is offered');
  assert.ok(descendants(root).some(element => element.type === 'small' && text(element) === '단일 값'));
  assert.ok(!descendants(root).some(element => element.type === 'small' && text(element) === 'scalar'));
  const everything = fixture('SecretAvailable.tsx', 'SecretAvailable', { view: sessionView({ connectable: [sessionView().connectable[1]!] }), busy: false, change, onPaste() {}, onSharing() {} });
  find(everything.render(), element => element.props['aria-expanded'] === false).props.onClick();
  assert.ok(descendants(everything.render()).some(element => text(element) === '저장한 시크릿을 모두 이 세션에서 쓸 수 있습니다.'));
  assert.deepEqual(sent, []);
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
  find(root, element => element.type === stub('./SecretAvailable', 'SecretAvailable')).props.onSharing('global_key');
  assert.deepEqual(available.calls, [['close']]);
  assert.deepEqual(available.settings, [{ section: 'secrets', secretId: 'global_key' }]);
  assert.ok(!available.calls.some(([kind]) => kind === 'change'));
});

test('settings opened for one secret open its sharing editor once, and only for a secret this vault owns', () => {
  const opened = fixture('SecretSettings.tsx', 'SecretSettingsWorkspace', { view: settingsView, canvas: { folders: [], hosts: [] }, busy: false, change: async () => true, focus: 'legacy_key' });
  opened.render();
  const editor = opened.render();
  assert.equal(editor.type, stub('./SecretSharingEditor', 'SecretSharingEditor')); assert.equal(editor.props.item.id, 'legacy_key');
  editor.props.onClose();
  assert.notEqual(opened.render().type, stub('./SecretSharingEditor', 'SecretSharingEditor'), 'closing it stays closed');
  const remote = fixture('SecretSettings.tsx', 'SecretSettingsWorkspace', { view: settingsView, canvas: { folders: [], hosts: [] }, busy: false, change: async () => true, focus: 'remote_key' });
  remote.render();
  assert.notEqual(remote.render().type, stub('./SecretSharingEditor', 'SecretSharingEditor'));
});

test('the settings read their view once when shown, and a stale sharing save reloads it and says so', async () => {
  let reads = 0; const posted: unknown[] = [];
  const client = { ...secretsClient,
    readSecretSettings: async () => { reads++; return settingsView; },
    postSecret: async (action: string, _token: string, body: unknown) => { posted.push([action, body]); throw new ApiError('conflict', 409); } };
  const panel = fixture('SecretsPanel.tsx', 'SecretsPanel', { token: 'token' }, { context: { active: true }, real: { './secrets-client': client } });
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
  const secretCanvas = { folders: [{ key: `@${node}//srv/app`, label: 'app', computer: 'Build server' }], hosts: [{ name: 'Mac' }, { node, name: 'Build server' }] };
  const context = { token: 'token', providers: [], projects: [], secretCanvas, computers: [], targets: () => ({ projects: [], sessions: [] }), controlledBy: [], showHidden: false, onShowHiddenChange() {}, onOpenSession() {} };
  const dialog = fixture('settings/SettingsDialog.tsx', 'SettingsDialog', { place: { section: 'secrets', secretId: 'folder_key' }, sections: ['secrets'], attention: {}, context, onPlace() {}, onChanged() {}, onClose() {} }, { globals: { document: { body: {}, activeElement: null } } });
  const panel = find(dialog.render(), element => element.type === stub('../secrets/SecretsPanel', 'SecretsPanel'));
  assert.equal(panel.props.canvas, secretCanvas); assert.equal(panel.props.focus, 'folder_key'); assert.equal(panel.props.token, 'token');
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

test('the old value replacement form and its update action are gone', () => {
  assert.equal('SecretValueEditor' in fixture('SecretRecovery.tsx', 'SecretPendingImport', {}).exports, false);
  assert.doesNotMatch(readFileSync(new URL('../../../client/src/secrets/SecretSettings.tsx', import.meta.url), 'utf8'), /'update'/);
});

/** A `reveal` whose answers the test gives one by one. */
function reveals() {
  const asked: [string, number][] = []; const answers: ((value: SecretValue | undefined) => void)[] = [];
  return { asked, reveal: (secretId: string, expectedVersion: number) => { asked.push([secretId, expectedVersion]); return new Promise<SecretValue | undefined>(resolve => { answers.push(resolve); }); },
    answer: (value?: SecretValue) => answers.shift()!(value) };
}
const fakeValue = (patch: Partial<SecretValue> = {}): SecretValue => ({ id: 'folder_key', version: 1, kind: 'scalar', value: 'FAKE_VALUE', ...patch });
/** State made inside the fixture's context, compared as plain data. */
const plain = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

test('a value is read only once the Tower password turned value viewing on, and leaves state on hide, view lock, a lost view and a new version', async () => {
  const { sent, change, answer } = changes(); const read = reveals();
  const workspace = fixture('SecretSettings.tsx', 'SecretSettingsWorkspace', { view: settingsView, canvas: { folders: [], hosts: [] }, busy: false, change, reveal: read.reveal });
  const row = (id = 'folder_key') => find(workspace.render(), element => element.type === workspace.exports.SecretSettingsRow && element.props.secret.id === id).props;
  const panel = (id = 'folder_key') => find(workspace.exports.SecretSettingsRow!(row(id)), element => element.type === stub('./SecretValueView', 'SecretValuePanel'));
  const secret = settingsView.secrets[0]!;
  row().values.open(secret, false);
  assert.deepEqual(plain(row().values.slot), { id: 'folder_key', edit: false, want: false }); assert.deepEqual(read.asked, [], 'nothing is read before value viewing is on');
  assert.equal(panel().props.valueView, false, 'the row asks for the Tower password');
  const unlocking = row().values.unlock('FAKE_TOWER_PASSWORD');
  assert.deepEqual(sent, [['view-unlock', { password: 'FAKE_TOWER_PASSWORD' }]]);
  // The unlock's answer replaces the view before the change resolves.
  workspace.props.view = { ...settingsView, valueView: true }; answer(); await unlocking; workspace.render();
  assert.equal(row().values.slot.loading, true); assert.deepEqual(read.asked, [['folder_key', 1]], 'read once, at the version shown');
  read.answer(fakeValue()); await tick();
  assert.deepEqual(plain(row().values.slot), { id: 'folder_key', edit: false, value: fakeValue() });
  row().values.close();
  assert.equal(row().values.slot, undefined, 'hiding drops the value');
  row().values.open(secret, false); row();
  read.answer(fakeValue()); await tick();
  assert.equal(row().values.slot.value.value, 'FAKE_VALUE'); assert.equal(read.asked.length, 2);
  // Value viewing lost on the server (`view-locked`): the value goes, and the same row asks for the password again.
  workspace.props.view = { ...settingsView, valueView: false }; workspace.render();
  assert.deepEqual(plain(row().values.slot), { id: 'folder_key', edit: false }); assert.equal(panel().props.valueView, false);
  const again = row().values.unlock('FAKE_TOWER_PASSWORD');
  workspace.props.view = { ...settingsView, valueView: true }; answer(); await again; row();
  read.answer(fakeValue()); await tick();
  assert.equal(row().values.slot.value.value, 'FAKE_VALUE');
  // Saved elsewhere since: the shown value is stale and goes.
  workspace.props.view = { ...settingsView, valueView: true, secrets: settingsView.secrets.map(entry => entry.id === 'folder_key' ? { ...entry, version: 2 } : entry) }; workspace.render();
  assert.equal(row().values.slot, undefined);
  // The header lock ends value viewing for this browser and drops what is open.
  row().values.open(secret, false); row(); read.answer(fakeValue({ version: 2 })); await tick();
  assert.equal(row().values.slot.value.version, 2);
  find(workspace.render(), element => element.type === 'button' && text(element) === '값 보기 잠그기').props.onClick();
  assert.deepEqual(sent.at(-1), ['view-lock', {}]); assert.equal(row().values.slot, undefined);
  answer(); await tick(); workspace.cleanup();
});

test('editing reads the value first, opens the form on it, and a read answered after another open is dropped', async () => {
  const { change } = changes(); const read = reveals();
  const workspace = fixture('SecretSettings.tsx', 'SecretSettingsWorkspace', { view: { ...settingsView, valueView: true }, canvas: { folders: [], hosts: [] }, busy: false, change, reveal: read.reveal });
  const values = () => find(workspace.render(), element => element.type === workspace.exports.SecretSettingsRow).props.values;
  values().open(settingsView.secrets[0]!, true); workspace.render();
  values().open(settingsView.secrets[1]!, true); workspace.render();
  assert.deepEqual(read.asked, [['folder_key', 1], ['legacy_key', 1]]);
  read.answer(fakeValue()); await tick();
  assert.deepEqual(plain(values().slot), { id: 'legacy_key', edit: true, loading: true }, 'the first answer came too late');
  read.answer(fakeValue({ id: 'legacy_key', value: 'FAKE_LEGACY' })); await tick();
  const form = workspace.render();
  assert.equal(form.type, stub('./SecretValueView', 'SecretValueForm')); assert.equal(form.props.secret.id, 'legacy_key'); assert.equal(form.props.value.value, 'FAKE_LEGACY');
  form.props.onClose();
  assert.notEqual(workspace.render().type, stub('./SecretValueView', 'SecretValueForm')); assert.equal(values().slot, undefined, 'closing the form drops the value');
  // Showing first, then editing, needs no second read.
  values().open(settingsView.secrets[0]!, false); workspace.render(); read.answer(fakeValue()); await tick();
  values().open(settingsView.secrets[0]!, true);
  assert.equal(workspace.render().type, stub('./SecretValueView', 'SecretValueForm')); assert.equal(read.asked.length, 3);
  // Another editor never keeps a value open behind it.
  workspace.render().props.onClose(); values().open(settingsView.secrets[0]!, false); workspace.render(); read.answer(fakeValue()); await tick();
  find(workspace.render(), element => element.type === workspace.exports.SecretSettingsRow).props.onSharing();
  assert.equal(workspace.render().type, stub('./SecretSharingEditor', 'SecretSharingEditor'));
  workspace.render().props.onClose(); assert.equal(values().slot, undefined);
  workspace.cleanup();
});

test('a value read or saved against a moved version reloads and says so; a view lost on the server turns value viewing off and asks again', async () => {
  let reads = 0; const posted: unknown[] = []; let failure: Error = new Error('unset');
  const client = { ...secretsClient,
    readSecretSettings: async () => { reads++; return { ...settingsView, valueView: true }; },
    readSecretValue: async (_token: string, secretId: string, expectedVersion: number) => { posted.push(['value', { secretId, expectedVersion }]); if (failure.message === 'none') return fakeValue(); throw failure; },
    postSecret: async (action: string, _token: string, body: unknown) => { posted.push([action, body]); throw failure; } };
  const panel = fixture('SecretsPanel.tsx', 'SecretsPanel', { token: 'token' }, { context: { active: true }, real: { './secrets-client': client } });
  panel.render(); await tick();
  const workspace = () => find(panel.render(), element => element.type === stub('./SecretSettings', 'SecretSettingsWorkspace')).props;
  const line = (role: string) => descendants(panel.render()).filter(element => element.type === 'p' && element.props.role === role).map(text).join(' ');
  failure = new Error('none');
  assert.deepEqual(await workspace().reveal('folder_key', 1), fakeValue()); assert.deepEqual(posted.pop(), ['value', { secretId: 'folder_key', expectedVersion: 1 }]);
  failure = new ApiError('버전이 바뀌었습니다.', 409, undefined, 'conflict');
  assert.equal(await workspace().change('value-update', { secretId: 'folder_key', expectedVersion: 1, value: 'FAKE' }), false);
  panel.render(); await tick();
  assert.equal(reads, 2, 'what is stored now is read again'); assert.match(line('status'), /값이 다른 곳에서 바뀌었습니다/); assert.equal(line('alert'), '');
  failure = new ApiError('없음', 404, undefined, 'not-found');
  assert.equal(await workspace().reveal('gone_key', 1), undefined); panel.render(); await tick();
  assert.equal(reads, 3);
  failure = new ApiError('잠김', 403, undefined, 'view-locked');
  assert.equal(await workspace().reveal('folder_key', 1), undefined);
  assert.equal(workspace().view.valueView, false); assert.match(line('status'), /Tower 비밀번호를 다시 입력하세요/);
  workspace().reload(); panel.render(); await tick();
  assert.equal(reads, 4); assert.equal(workspace().view.valueView, true);
  failure = new ApiError('Login required', 401, undefined, 'login-required');
  assert.equal(await workspace().change('value-update', { secretId: 'folder_key', expectedVersion: 1, value: 'FAKE' }), false);
  assert.equal(workspace().view.valueView, false, 'a value without a sign-in asks for the Tower password, which signs this page in again');
  failure = new ApiError('Login required', 401, undefined, 'login-required');
  assert.equal(await workspace().change('view-unlock', { password: 'FAKE_WRONG' }), false);
  assert.match(line('alert'), /Tower 비밀번호가 맞지 않습니다/, 'at the unlock it is a wrong password');
  assert.equal(reads, 4, 'a lost view or a wrong password reads nothing again');
  panel.cleanup();
});

test('editing sends the read version with the new value and keeps the draft until the answer; a file is replaced by a picked file', async () => {
  const { sent, change, answer } = changes(); let closed = 0;
  const secret = settingsView.secrets[0]!;
  const form = fixture('SecretValueView.tsx', 'SecretValueForm', { secret, value: fakeValue({ version: 7, value: 'FAKE_OLD' }), busy: false, change, onClose() { closed++; } });
  const submit = () => find(form.render(), element => element.type === 'button' && element.props.type === 'submit');
  assert.equal(find(form.render(), byType('textarea')).props.value, 'FAKE_OLD'); assert.equal(submit().props.disabled, true, 'nothing to save until it changes');
  find(form.render(), byType('textarea')).props.onChange({ target: { value: 'FAKE_NEW' } });
  assert.equal(submit().props.disabled, false);
  const first = find(form.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(sent, [['value-update', { secretId: 'folder_key', expectedVersion: 7, value: 'FAKE_NEW' }]]);
  assert.equal(find(form.render(), byType('textarea')).props.value, 'FAKE_NEW', 'a refused save can be sent again; an emptied form is never saved by mistake');
  answer(false); await first; assert.equal(closed, 0);
  const second = find(form.render(), byType('form')).props.onSubmit(formEvent); answer(true); await second;
  assert.equal(closed, 1); assert.equal(sent.length, 2); form.cleanup();
  const files = changes();
  const fileForm = fixture('SecretValueView.tsx', 'SecretValueForm', { secret: { ...secret, kind: 'file' }, value: fakeValue({ version: 2, kind: 'file', value: undefined, content: 'AAEC' }), busy: false, change: files.change, onClose() {} });
  assert.equal(find(fileForm.render(), element => element.type === 'button' && element.props.type === 'submit').props.disabled, true);
  await find(fileForm.render(), element => element.type === 'input' && element.props.type === 'file').props.onChange({ target: { files: [{ name: 'new.pem', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }] }, currentTarget: { value: '' } });
  await tick();
  find(fileForm.render(), byType('form')).props.onSubmit(formEvent);
  assert.deepEqual(files.sent, [['value-update', { secretId: 'folder_key', expectedVersion: 2, content: 'AQID' }]]);
  files.answer(); await tick(); fileForm.cleanup();
});

test('a file value is saved through a Blob URL that is revoked right after the download started', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const created: Blob[] = []; const revoked: string[] = []; const clicked: unknown[] = [];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, document: Object.getOwnPropertyDescriptor(globalThis, 'document') };
  const link: Record<string, any> = { click() { clicked.push({ href: link.href, download: link.download }); }, remove() { link.removed = true; } };
  URL.createObjectURL = (blob: Blob) => { created.push(blob); return 'blob:fixture/1'; };
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => { assert.equal(tag, 'a'); return link; }, body: { append: (node: unknown) => assert.equal(node, link) } } });
  try {
    secretsClient.saveSecretFile('key.pem', Buffer.from('FAKE_FILE').toString('base64'));
    assert.deepEqual(clicked, [{ href: 'blob:fixture/1', download: 'key.pem' }]); assert.equal(link.removed, true, 'the link leaves the page at once');
    assert.deepEqual(revoked, []);
    context.mock.timers.tick(1000);
    assert.deepEqual(revoked, ['blob:fixture/1']);
    assert.equal(Buffer.from(await created[0]!.arrayBuffer()).toString(), 'FAKE_FILE');
  } finally {
    URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke;
    if (original.document) Object.defineProperty(globalThis, 'document', original.document); else Reflect.deleteProperty(globalThis, 'document');
  }
});
