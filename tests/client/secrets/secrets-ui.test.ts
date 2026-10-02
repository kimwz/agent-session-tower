import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SecretOverview } from '../../../shared/secrets.js';
import { registrationPayload, secretOverviewPath, secretSession, type Registration } from '../../../client/src/secrets/secrets-client.js';
import { SecretAccess } from '../../../client/src/secrets/SecretAccess.js';
import { SecretRegistration } from '../../../client/src/secrets/SecretRegistration.js';
import { SecretWorkspace } from '../../../client/src/secrets/SecretsPanel.js';
import { SecretRuleEditor, parseSecretDevice } from '../../../client/src/secrets/SecretManagement.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';

const original = getLanguage();
test.beforeEach(() => setLanguage('ko'));
test.afterEach(() => setLanguage(original));
const noop = () => {};
const change = async () => true;
const node = 'a'.repeat(32);
const device = { id: 'source', name: '원본 컴퓨터', signingKey: 'public-signing', encryptionKey: 'public-encryption', fingerprint: 'public-fingerprint' };
const overview: SecretOverview = {
  status: { initialized: true, locked: false }, device, peers: [], projects: [],
  groups: [{ id: 'group', name: '배포 키', scope: 'global' }],
  secrets: [{ id: 'secret', name: 'API_TOKEN', groupId: 'group', kind: 'scalar', version: 1, reference: 'tower-secret://vault/secret@1' }],
  rules: [{ id: 'rule', groupId: 'group', secretIds: ['secret'], hostId: device.id, activation: 'auto', operations: ['discover'], enabled: true, revision: 1 }],
  connected: ['secret'], task: { id: 'task', hostId: device.id, sessionId: 'session', root: '/work', status: 'open', createdAt: 1, excluded: [] },
};
const form: Registration = { name: 'API_TOKEN', kind: 'scalar', scope: 'task', groupId: '', groupName: '배포 키', projectId: '', activation: 'manual', operations: ['discover', 'env'], connect: true };

test('joined-session requests address the source vault and pass only canonical session and node identities', () => {
  assert.deepEqual(secretSession(`@${node}/codex:session`), { sessionId: 'codex:session', nodeId: node });
  const path = secretOverviewPath(`@${node}/codex:session`, `@${node}/work/project`);
  assert.match(path, /^\/api\/secrets\/overview\?/);
  const query = new URL(path, 'http://source').searchParams;
  assert.equal(query.get('sessionId'), 'codex:session'); assert.equal(query.get('nodeId'), node); assert.equal(query.get('cwd'), 'work/project');
  assert.doesNotMatch(path, /\/api\/nodes\//);
});

test('registration puts transient values only in the owner request, preserving scope, activation and selected operations', () => {
  const raw = 'canary-value-that-never-enters-a-draft';
  const input = registrationPayload(form, raw, `@${node}/session`);
  assert.equal(input.value, raw); assert.equal(input.scope, 'task'); assert.equal(input.activation, 'manual'); assert.deepEqual(input.operations, ['discover', 'env']);
  assert.equal(input.sessionId, 'session'); assert.equal(input.nodeId, node); assert.equal(input.connect, true);
  assert.equal(input.target, undefined); assert.equal(input.projectId, undefined); assert.doesNotMatch(JSON.stringify(form), new RegExp(raw));
  const auto = registrationPayload({ ...form, scope: 'project', projectId: 'project', activation: 'auto', kind: 'env', connect: false }, 'A=value\nB=', 'session');
  assert.equal(auto.value, 'A=value\nB='); assert.equal(auto.content, undefined); assert.equal(auto.projectId, 'project'); assert.equal(auto.activation, 'auto'); assert.equal(auto.connect, false);
  const file = registrationPayload({ ...form, kind: 'file' }, 'AAECAw==', 'session'); assert.equal(file.content, 'AAECAw=='); assert.equal(file.value, undefined);
});

test('password setup requires confirmation and 12 characters while locked vault offers owner-only unlock', () => {
  const setup = renderToStaticMarkup(createElement(SecretAccess, { status: { initialized: false, locked: true }, busy: false, change }));
  assert.match(setup, /시크릿 보관함 만들기/); assert.match(setup, /minLength="12"/); assert.match(setup, /비밀번호 확인/); assert.match(setup, /type="submit" disabled/); assert.doesNotMatch(setup, /localStorage|draft/);
  const locked = renderToStaticMarkup(createElement(SecretAccess, { status: { initialized: true, locked: true }, busy: false, change }));
  assert.match(locked, /잠금 해제/); assert.match(locked, /autoComplete="current-password"/); assert.doesNotMatch(locked, /비밀번호 확인/);
});

test('registration defaults to this task for a conversation and supports manual and automatic connection', () => {
  const markup = renderToStaticMarkup(createElement(SecretRegistration, { overview, sessionId: 'session', token: 'token', busy: false, change, onClose: noop }));
  assert.match(markup, /value="task" selected=""/); assert.match(markup, /value="manual" selected=""/); assert.match(markup, /value="auto"/); assert.match(markup, /현재 작업에 연결/);
  assert.doesNotMatch(markup, /1회|한 번/);
  const settings = renderToStaticMarkup(createElement(SecretRegistration, { overview, token: 'token', busy: false, change, onClose: noop }));
  assert.doesNotMatch(settings, /value="task"/);
});

test('management shows names and policy operations with explicit task close and revoke controls', () => {
  const markup = renderToStaticMarkup(createElement(SecretWorkspace, { overview, token: 'token', sessionId: 'session', busy: false, change }));
  assert.match(markup, /API_TOKEN/); assert.match(markup, /배포 키/); assert.match(markup, /작업 종료/); assert.match(markup, /선택한 키 권한 회수/);
  assert.match(markup, /자동 · 목록 확인/); assert.doesNotMatch(markup, /public-signing|public-encryption|tower-secret:\/\/vault/);
  const locked = renderToStaticMarkup(createElement(SecretWorkspace, { overview: { ...overview, status: { initialized: true, locked: true } }, token: 'token', sessionId: 'session', busy: false, change }));
  assert.doesNotMatch(locked, /API_TOKEN|배포 키/); assert.match(locked, /잠금 해제/);
});

test('discover-only rule editor retains the selected key and allows field and operation policies', () => {
  const markup = renderToStaticMarkup(createElement(SecretRuleEditor, { overview, rule: overview.rules[0], busy: false, change, onClose: noop }));
  assert.match(markup, /공유할 키/); assert.match(markup, /허용할 사용 방식/); assert.match(markup, /목록 확인/); assert.match(markup, /환경 변수/); assert.match(markup, /규칙 활성화/);
  assert.match(markup, /value="auto" selected=""/); assert.match(markup, /작업 내 최대 사용 시간/);
});

test('peer public code parsing drops extra properties and rejects malformed codes without reflecting pasted data', () => {
  assert.deepEqual(parseSecretDevice(JSON.stringify({ ...device, password: 'private-canary' })), device);
  assert.throws(() => parseSecretDevice(JSON.stringify({ id: 'source', password: 'private-canary' })), /Invalid public device/);
});

test('secret controls have English translations while key names remain exact', () => {
  setLanguage('en');
  const markup = renderToStaticMarkup(createElement(SecretWorkspace, { overview: { ...overview, status: { ...overview.status, pendingImports: 1, pendingImportIds: ['pending'] } }, token: 'token', sessionId: 'session', busy: false, change }));
  assert.match(markup, /Connect selected keys/); assert.match(markup, /Replace value/); assert.match(markup, /Import vault/); assert.match(markup, /API_TOKEN/);
  assert.doesNotMatch(markup, /선택한 키|시크릿 등록|가져오기 대기 중/);
});

test('project edit renders all existing host bindings and keeps unknown public host IDs visible', async () => {
  const { SecretProjectEditor } = await import('../../../client/src/secrets/SecretManagement.js');
  const project = { id: 'logical-project', name: 'app', bindings: [{ hostId: device.id, root: '/source/app' }, { hostId: 'former-peer', root: '/peer/app' }] };
  const markup = renderToStaticMarkup(createElement(SecretProjectEditor, { overview, project, busy: false, change, onClose: noop }));
  assert.match(markup, /프로젝트 편집/); assert.match(markup, /former-peer/); assert.match(markup, /value="\/source\/app"/); assert.match(markup, /value="\/peer\/app"/); assert.match(markup, /위치 추가/);
});

test('pending encrypted vault restores remain waiting and direct the owner to Secrets settings', async () => {
  const { RestoreStatus } = await import('../../../client/src/backup/BackupPanel.js');
  const report = { id: 'restore', status: 'waiting-secrets' as const, requestedAt: '2026-10-02', from: 'source', createdAt: '2026-10-02', applied: [], worker: [], errors: [], pendingSecretImports: ['vault-id'] };
  const markup = renderToStaticMarkup(createElement(RestoreStatus, { report, busy: false, onCancel: noop }));
  assert.match(markup, /시크릿 보관함 가져오기를 기다립니다/); assert.match(markup, /원본 보관함 비밀번호/); assert.match(markup, /시크릿 설정 열기/);
  assert.doesNotMatch(markup, /복원을 적용했습니다|복원을 취소했습니다/);
});

test('global registration shares only a selected project unless the owner explicitly opts into all projects', () => {
  const global = { ...form, scope: 'global' as const, projectId: 'selected-project', allProjects: false, activation: 'auto' as const };
  const scoped = registrationPayload(global, 'private-value');
  assert.equal(scoped.projectId, 'selected-project'); assert.equal(scoped.allProjects, false); assert.equal(scoped.scope, 'global');
  const everywhere = registrationPayload({ ...global, allProjects: true }, 'private-value');
  assert.equal(everywhere.allProjects, true); assert.equal(everywhere.projectId, undefined);
  const current = registrationPayload({ ...global, projectId: '', allProjects: false }, 'private-value', 'session');
  assert.equal(current.allProjects, false); assert.equal(current.projectId, undefined); assert.equal(current.sessionId, 'session'); assert.equal(current.target, undefined);
  const task = registrationPayload({ ...form, allProjects: true }, 'private-value', 'session');
  assert.equal(task.allProjects, undefined);
});

test('remote metadata remains visible but remote keys and synthetic groups cannot be edited in the local vault', async () => {
  const { localSecretOverview } = await import('../../../client/src/secrets/secrets-client.js');
  const remoteOverview: SecretOverview = { ...overview, groups: [{ id: 'remote-group', name: 'Source A · remote-group', scope: 'global' }],
    secrets: [{ ...overview.secrets[0], id: 'remote-key', groupId: 'remote-group', name: 'REMOTE_TOKEN', sourceHostId: 'source-A', activation: 'auto' }], rules: [], connected: ['remote-key'] };
  const markup = renderToStaticMarkup(createElement(SecretWorkspace, { overview: remoteOverview, token: 'token', sessionId: 'session', busy: false, change }));
  assert.match(markup, /REMOTE_TOKEN/); assert.match(markup, /Source A/); assert.match(markup, /자동 연결/); assert.match(markup, /원본에서 관리/);
  assert.doesNotMatch(markup, />값 교체<|>삭제<|시크릿을 보관함에서 삭제/);
  assert.match(markup, /disabled="">규칙 추가/);
  const editable = localSecretOverview(remoteOverview); assert.deepEqual(editable.secrets, []); assert.deepEqual(editable.groups, []);
});

test('partial remote source failure is shown as a generic alert without reflecting server error details', async () => {
  const { SecretSourceNotice } = await import('../../../client/src/secrets/SecretsPanel.js');
  const error = 'source-private-error-canary';
  const remote = { ...overview, status: { ...overview.status, error } };
  const workspace = renderToStaticMarkup(createElement(SecretWorkspace, { overview: remote, token: 'token', sessionId: 'session', busy: false, change }));
  assert.match(workspace, /role="alert"/); assert.match(workspace, /원본 컴퓨터의 연결과 잠금 상태/); assert.doesNotMatch(workspace, /source-private-error-canary/);
  const notice = renderToStaticMarkup(createElement(SecretSourceNotice, { statusError: error }));
  assert.match(notice, /원본 컴퓨터의 연결과 잠금 상태/); assert.doesNotMatch(notice, /source-private-error-canary/);
  assert.equal(renderToStaticMarkup(createElement(SecretSourceNotice, {})), '');
});
