import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as jsxRuntime from 'react/jsx-runtime';
import type { ReactElement } from 'react';
import * as secretTypes from '../../../shared/secrets.js';
import { registrationPayload, isRemoteSecret, localSecretOverview, quickSecretKind, quickSecretPayload, savedSecretMatches } from '../../../client/src/secrets/secrets-client.js';

type Element = ReactElement<Record<string, any>>;
function descendants(element: unknown): Element[] {
  if (!element || typeof element !== 'object' || !('props' in element)) return [];
  const node = element as Element;
  return [node, ...[node.props.children].flat(Infinity).flatMap(descendants)];
}
function componentFixture(component = 'SecretRegistration', file = 'SecretRegistration.tsx', extra: Record<string, unknown> = {}) {
  let cursor = 0;
  const slots: unknown[] = [];
  const cleanups: (() => void)[] = [];
  const react = {
    createContext: () => ({}),
    useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(slots[index]) : value; }]; },
    useRef(initial: unknown) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useEffect(effect: () => (() => void) | void) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
  };
  const module = { exports: {} as Record<string, (props: unknown) => Element> };
  const code = transformSync(readFileSync(new URL(`../../../client/src/secrets/${file}`, import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  runInNewContext(code, { module, exports: module.exports, Uint8Array, btoa, require(name: string) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name.endsWith('/shared/secrets')) return secretTypes;
    if (name === '../i18n/i18n') return { useI18n: () => ({ t: (value: string) => value }) };
    if (name === '../common/lib') return { copyText: async () => true };
    if (name === './SecretRegistration') return { SecretOperations: () => null, scopeLabels: { global: '전역', project: '프로젝트', task: '이번 작업' }, operationLabels: { discover: '목록 확인' } };
    if (name === 'react-dom') return { createPortal: (node: unknown) => node };
    if (name === 'lucide-react') return { KeyRound: () => null, LockKeyhole: () => null, X: () => null, Check: () => null, FileKey: () => null, Search: () => null };
    if (name === './SecretQuickConnect') return {};
    if (name === '../settings/settings-open') return { openSettings() {} };
    if (name === '../settings/SettingsPane') return { SettingsFrameContext: {}, useSettingsGuard() {} };
    if (name === './SecretRecovery' || name === './SecretAccess' || name === './SecretManagement') return {};
    if (name === './secrets-client') return { registrationPayload, isRemoteSecret, localSecretOverview, quickSecretKind, quickSecretPayload, savedSecretMatches };
    if (name === '../master/api') return { post: async () => ({ fields: [] }) };
    throw new Error(`Unexpected fixture import: ${name}`);
  } });
  const overview = { status: { initialized: true, locked: false }, projects: [], groups: [], secrets: [], rules: [], peers: [], connected: [] };
  const sent: unknown[] = [];
  let complete!: (value: boolean) => void;
  const props = { overview, sessionId: 'session', token: 'token', busy: false, onClose() {}, onConnected() {}, onManage() {}, change: async (_action: string, body: unknown) => { sent.push(body); return new Promise<boolean>(resolve => { complete = resolve; }); }, ...extra };
  const render = () => { cursor = 0; return module.exports[component](props); };
  return { render, sent, complete: (value: boolean) => complete(value), cleanup: () => cleanups.forEach(cleanup => cleanup()) };
}

test('secret registration clears the raw input before the request resolves and stops portal submit propagation', async () => {
  const fixture = componentFixture();
  let root = fixture.render();
  const input = (element: Element, type: string) => descendants(element).find(node => node.type === type)!;
  input(root, 'textarea').props.onChange({ target: { value: 'transient-canary' } });
  root = fixture.render();
  assert.equal(input(root, 'textarea').props.value, 'transient-canary');
  let prevented = false; let stopped = false;
  const request = root.props.onSubmit({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true);
  assert.equal((fixture.sent[0] as { value: string }).value, 'transient-canary');
  assert.equal(input(fixture.render(), 'textarea').props.value, '');
  fixture.complete(true); await request; fixture.cleanup();
});

const formEvent = { preventDefault() {}, stopPropagation() {} };
const find = (element: Element, type: string) => descendants(element).find(node => node.type === type)!;
const readPayload = (fixture: ReturnType<typeof componentFixture>, index = 0) => JSON.parse(JSON.stringify(fixture.sent[index])) as Record<string, any>;

test('quick confirmation clears the secret before completion, sends no chat submit and immediately connects task scope', async () => {
  let connected = false;
  const fixture = componentFixture('SecretQuickConnect', 'SecretQuickConnect.tsx', { onConnected() { connected = true; } });
  find(fixture.render(), 'textarea').props.onChange({ target: { value: 'FAKE_QUICK_CANARY' } });
  let prevented = false; let stopped = false;
  find(fixture.render(), 'form').props.onSubmit({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true); assert.equal(readPayload(fixture).value, 'FAKE_QUICK_CANARY');
  assert.equal(readPayload(fixture).notifySession, true); assert.equal(readPayload(fixture).scope, 'task'); assert.equal(readPayload(fixture).connect, true);
  assert.equal(find(fixture.render(), 'textarea').props.value, '');
  fixture.complete(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(connected, true); fixture.cleanup();
});
test('the chat saved picker opts into a notice but unlock alone does not', async () => {
  const overview = { status: { initialized: true, locked: false }, projects: [], groups: [{ id: 'global', scope: 'global', name: 'Global' }], secrets: [{ id: 'saved', groupId: 'global', name: 'FAKE_SAVED', kind: 'scalar', version: 1 }], rules: [], peers: [], connected: [] };
  const picker = componentFixture('SecretQuickConnect', 'SecretQuickConnect.tsx', { overview });
  const button = descendants(picker.render()).find(node => node.props.className === 'secret-saved-key')!;
  const pending = button.props.onClick();
  assert.deepEqual(readPayload(picker), { secretIds: ['saved'], notifySession: true });
  picker.complete(true); await pending; picker.cleanup();
  const locked = componentFixture('SecretQuickConnect', 'SecretQuickConnect.tsx', { overview: { ...overview, status: { initialized: true, locked: true } } });
  const password = descendants(locked.render()).find(node => node.type === 'input' && node.props.type === 'password')!;
  password.props.onChange({ target: { value: 'FAKE_UNLOCK_PASSWORD' } });
  find(locked.render(), 'form').props.onSubmit(formEvent);
  assert.deepEqual(readPayload(locked), { password: 'FAKE_UNLOCK_PASSWORD' });
  locked.complete(true); await new Promise(resolve => setImmediate(resolve)); locked.cleanup();
});

test('closing a pending quick dialog prevents its response from closing a later dialog', async () => {
  let connected = false;
  const fixture = componentFixture('SecretQuickConnect', 'SecretQuickConnect.tsx', { onConnected() { connected = true; } });
  find(fixture.render(), 'textarea').props.onChange({ target: { value: 'FAKE_PENDING' } });
  find(fixture.render(), 'form').props.onSubmit(formEvent); fixture.cleanup(); fixture.complete(true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(connected, false);
});

test('pending import sends only the selected ID and transient source password and clears input immediately', async () => {
  const fixture = componentFixture('SecretPendingImport', 'SecretRecovery.tsx', { ids: ['backup-a', 'backup-b'] });
  let root = fixture.render();
  find(root, 'select').props.onChange({ target: { value: 'backup-b' } });
  find(root, 'input').props.onChange({ target: { value: 'original-source-password' } });
  root = fixture.render();
  const pending = root.props.onSubmit(formEvent);
  assert.deepEqual(readPayload(fixture), { id: 'backup-b', password: 'original-source-password' });
  assert.equal(find(fixture.render(), 'input').props.value, '');
  fixture.complete(true); await pending; fixture.cleanup();
});

test('value rotation submits the existing ID and new value without putting it in metadata or leaving it on screen', async () => {
  const secret = { id: 'key', name: 'TOKEN', kind: 'scalar', version: 3, groupId: 'group', reference: 'tower-secret://v/key@3' };
  const fixture = componentFixture('SecretValueEditor', 'SecretRecovery.tsx', { secret });
  find(fixture.render(), 'textarea').props.onChange({ target: { value: 'next-value-canary' } });
  const pending = fixture.render().props.onSubmit(formEvent);
  assert.deepEqual(readPayload(fixture), { id: 'key', value: 'next-value-canary' });
  assert.equal(find(fixture.render(), 'textarea').props.value, '');
  assert.doesNotMatch(JSON.stringify(secret), /next-value-canary/);
  fixture.complete(true); await pending; fixture.cleanup();
});

test('project editing preserves one logical project ID and submits local and remote bindings together', async () => {
  const project = { id: 'logical-project', name: 'app', bindings: [{ hostId: 'source', root: '/source/app' }, { hostId: 'peer', root: '/peer/app' }] };
  const fixture = componentFixture('SecretProjectEditor', 'SecretManagement.tsx', { project });
  const pending = fixture.render().props.onSubmit(formEvent);
  assert.deepEqual(readPayload(fixture), project);
  fixture.complete(true); await pending; fixture.cleanup();
});

test('global rule uses explicit allProjects and preserves discover-only key and field subsets with TTL and expiry', async () => {
  const overview = { status: { initialized: true, locked: false }, device: { id: 'source', name: 'Source' }, projects: [], peers: [],
    groups: [{ id: 'group', name: 'bundle', scope: 'global' }], secrets: [{ id: 'bundle', groupId: 'group', name: '.env', kind: 'env', fields: ['TOKEN', 'OTHER'] }], rules: [], connected: [] };
  const rule = { id: 'rule', groupId: 'group', hostId: 'source', secretIds: ['bundle'], fields: { bundle: ['TOKEN'] }, operations: ['discover'], activation: 'auto', allProjects: true, enabled: true, revision: 3, maxTtlMs: 600000, expiresAt: Date.parse('2028-01-01T00:00:00Z') };
  const fixture = componentFixture('SecretRuleEditor', 'SecretManagement.tsx', { overview, rule });
  const pending = fixture.render().props.onSubmit(formEvent);
  const body = readPayload(fixture);
  assert.equal(body.allProjects, true); assert.equal(body.projectId, undefined); assert.deepEqual(body.secretIds, ['bundle']); assert.deepEqual(body.fields, { bundle: ['TOKEN'] });
  assert.deepEqual(body.operations, ['discover']); assert.equal(body.activation, 'auto'); assert.equal(body.maxTtlMs, 600000); assert.equal(body.expiresAt, rule.expiresAt); assert.equal(body.revision, undefined);
  fixture.complete(true); await pending; fixture.cleanup();
});

test('registration accepts empty uploaded file bytes and sends their canonical empty base64', async () => {
  const fixture = componentFixture();
  let root = fixture.render();
  const select = descendants(root).find(node => node.type === 'select' && node.props.value === 'scalar')!;
  select.props.onChange({ target: { value: 'file' } });
  root = fixture.render();
  const upload = descendants(root).find(node => node.type === 'input' && node.props.type === 'file')!;
  await upload.props.onChange({ target: { files: [{ name: 'empty.bin', size: 0, arrayBuffer: async () => new ArrayBuffer(0) }] }, currentTarget: { value: '' } });
  root = fixture.render();
  const submit = descendants(root).find(node => node.type === 'button' && node.props.type === 'submit')!;
  assert.equal(submit.props.disabled, false);
  const pending = root.props.onSubmit(formEvent);
  assert.equal(readPayload(fixture).content, ''); assert.equal(readPayload(fixture).name, 'empty.bin');
  fixture.complete(true); await pending; fixture.cleanup();
});

test('settings can save a global key without sharing, while automatic access still requires an explicit project choice', async () => {
  const overview = { status: { initialized: true, locked: false }, projects: [{ id: 'project-a', name: 'A', bindings: [] }], groups: [], secrets: [], rules: [], peers: [], connected: [] };
  const fixture = componentFixture('SecretRegistration', 'SecretRegistration.tsx', { overview, sessionId: undefined });
  let root = fixture.render();
  const name = descendants(root).find(node => node.type === 'input' && node.props.maxLength === 128)!;
  name.props.onChange({ target: { value: 'GLOBAL_KEY' } });
  root = fixture.render();
  const submit = () => descendants(fixture.render()).find(node => node.type === 'button' && node.props.type === 'submit')!;
  assert.equal(submit().props.disabled, false, 'manual vault storage does not grant any project access');
  const stored = fixture.render().props.onSubmit(formEvent);
  assert.equal(readPayload(fixture).allProjects, false); assert.equal(readPayload(fixture).projectId, undefined); assert.equal(readPayload(fixture).activation, 'manual'); assert.equal(readPayload(fixture).connect, false);
  fixture.complete(true); await stored;
  const activation = descendants(root).find(node => node.type === 'select' && node.props.value === 'manual')!;
  activation.props.onChange({ target: { value: 'auto' } });
  assert.equal(submit().props.disabled, true, 'automatic activation does not opt into all projects');
  const checkbox = descendants(fixture.render()).find(node => node.type === 'input' && node.props.type === 'checkbox')!;
  assert.equal(checkbox.props.checked, false);
  checkbox.props.onChange({ target: { checked: true } });
  assert.equal(submit().props.disabled, false);
  const pending = fixture.render().props.onSubmit(formEvent);
  const body = readPayload(fixture, 1);
  assert.equal(body.allProjects, true); assert.equal(body.projectId, undefined); assert.equal(body.activation, 'auto');
  fixture.complete(true); await pending; fixture.cleanup();
});

test('global session registration defaults to the trusted current session binding without all-project permission', async () => {
  const fixture = componentFixture();
  let root = fixture.render();
  const scope = descendants(root).find(node => node.type === 'select' && node.props.value === 'task')!;
  scope.props.onChange({ target: { value: 'global' } });
  root = fixture.render();
  const all = descendants(root).find(node => node.type === 'input' && node.props.type === 'checkbox')!;
  assert.equal(all.props.checked, false);
  const pending = root.props.onSubmit(formEvent);
  const body = readPayload(fixture);
  assert.equal(body.scope, 'global'); assert.equal(body.allProjects, false); assert.equal(body.projectId, undefined); assert.equal(body.sessionId, 'session'); assert.equal(body.target, undefined);
  fixture.complete(true); await pending; fixture.cleanup();
});

test('editing an existing global rule preserves its exact root fallback and does not widen it', async () => {
  const overview = { status: { initialized: true, locked: false }, device: { id: 'source', name: 'Source' }, projects: [], peers: [],
    groups: [{ id: 'group', name: 'key', scope: 'global' }], secrets: [{ id: 'key', groupId: 'group', name: 'TOKEN', kind: 'scalar' }], rules: [], connected: [] };
  const rule = { id: 'rule', groupId: 'group', hostId: 'source', secretIds: ['key'], operations: ['discover', 'env'], activation: 'manual', root: '/exact/project', enabled: true, revision: 1 };
  const fixture = componentFixture('SecretRuleEditor', 'SecretManagement.tsx', { overview, rule });
  const root = fixture.render();
  const submit = descendants(root).find(node => node.type === 'button' && node.props.type === 'submit')!;
  assert.equal(submit.props.disabled, false);
  const pending = root.props.onSubmit(formEvent); const body = readPayload(fixture);
  assert.equal(body.root, '/exact/project'); assert.equal(body.projectId, undefined); assert.notEqual(body.allProjects, true);
  fixture.complete(true); await pending; fixture.cleanup();
});

test('editing a rule whose key or field was removed saves only what still exists, with a whole-millisecond TTL', async () => {
  const overview = { status: { initialized: true, locked: false }, device: { id: 'source', name: 'Source' }, peers: [], projects: [{ id: 'project', name: 'App', bindings: [] }],
    groups: [{ id: 'group', name: 'app', scope: 'project', projectId: 'project' }], secrets: [{ id: 'kept', groupId: 'group', name: 'ENV', kind: 'env', fields: ['A'] }], rules: [], connected: [] };
  const rule = { id: 'rule', groupId: 'group', hostId: 'source', secretIds: ['kept', 'removed'], fields: { kept: ['A', 'GONE'], removed: ['B'] }, operations: ['env'], activation: 'auto', root: '/app', maxTtlMs: 130_000, enabled: true, revision: 3 };
  const fixture = componentFixture('SecretRuleEditor', 'SecretManagement.tsx', { overview, rule });
  const root = fixture.render();
  const pending = root.props.onSubmit(formEvent); const body = readPayload(fixture);
  assert.deepEqual(body.secretIds, ['kept']); assert.deepEqual(body.fields, { kept: ['A'] });
  assert.equal(body.projectId, 'project', 'a project group rule names its group project'); assert.equal(body.root, undefined);
  assert.equal(body.maxTtlMs, 130_000);
  fixture.complete(true); await pending; fixture.cleanup();
});

test('remote and mixed key selections disable attach without silently attaching the local subset, while revoke remains available', async () => {
  const overview = { status: { initialized: true, locked: false }, device: { id: 'local', name: 'Local' }, projects: [], peers: [],
    groups: [{ id: 'group-local', name: 'Local group', scope: 'global' }, { id: 'group-remote', name: 'Source · remote', scope: 'global' }],
    secrets: [{ id: 'local-key', groupId: 'group-local', name: 'LOCAL_KEY', kind: 'scalar', version: 1 }, { id: 'remote-key', groupId: 'group-remote', name: 'REMOTE_KEY', sourceHostId: 'source', kind: 'scalar', version: 1 }], rules: [], connected: ['remote-key'] };
  const fixture = componentFixture('SecretWorkspace', 'SecretsPanel.tsx', { overview });
  let root = fixture.render();
  const checkboxes = descendants(root).filter(node => node.type === 'input' && node.props.type === 'checkbox');
  checkboxes[1].props.onChange({ target: { checked: true } });
  root = fixture.render();
  const button = (text: string) => descendants(fixture.render()).find(node => node.type === 'button' && node.props.children === text)!;
  assert.equal(button('선택한 키 연결').props.disabled, true);
  await button('선택한 키 연결').props.onClick(); assert.deepEqual(fixture.sent, []);
  descendants(root).filter(node => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } });
  assert.equal(button('선택한 키 연결').props.disabled, true);
  await button('선택한 키 연결').props.onClick(); assert.deepEqual(fixture.sent, []);
  assert.equal(button('선택한 키 권한 회수').props.disabled, false);
  const pending = button('선택한 키 권한 회수').props.onClick();
  assert.deepEqual(readPayload(fixture).secretIds, ['remote-key', 'local-key']);
  fixture.complete(true); await pending; fixture.cleanup();
});
