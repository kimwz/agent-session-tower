import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SecretPeer, SecretSettingsItem, SecretSettingsView } from '../../../shared/secrets.js';
import { machineChoices, sharingDraft, sharingPayload, sharingSummary, type SecretCanvas } from '../../../client/src/secrets/secrets-client.js';
import { SecretSharingChips, SecretSharingEditor } from '../../../client/src/secrets/SecretSharingEditor.js';
import { SecretAddForm } from '../../../client/src/secrets/SecretAddForm.js';
import { clearShare, openShareRequest, pendingShare, shareRequestOf } from '../../../client/src/secrets/share-request.js';
import { unlockMode, unlockReady, unlockRequest } from '../../../client/src/secrets/secrets-client.js';
import { SecretAccess } from '../../../client/src/secrets/SecretAccess.js';
import { SecretPaste } from '../../../client/src/secrets/SecretPaste.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';

const original = getLanguage();
test.beforeEach(() => setLanguage('ko'));
test.afterEach(() => { setLanguage(original); clearShare(); });
const node = 'a'.repeat(32);
const device = { id: 'source', name: 'This computer', signingKey: 's', encryptionKey: 'e', fingerprint: 'f' };
const peer: SecretPeer = { device: { ...device, id: 'office-vault', name: 'office-vault' }, routeId: node, direction: 'node', enabled: true };
const canvas: SecretCanvas = { folders: [], hosts: [{ name: '원본 맥' }, { node, name: 'office-tower-1' }] };
const item = (patch: Partial<SecretSettingsItem>): SecretSettingsItem => ({ id: 'token', name: 'GITHUB_TOKEN', groupId: 'tower', kind: 'scalar', version: 1, reference: 'tower-secret://source/token@1', sourceHostId: 'source', ...patch });
const view: SecretSettingsView = { status: { initialized: true, locked: false }, device, peers: [peer], secrets: [] };
const change = async () => true;

test('computers are offered by their canvas names, and a row shows the computers a secret is shared with as a whole', () => {
  assert.deepEqual(machineChoices(view, canvas.hosts), [{ hostId: 'source', name: '원본 맥' }, { hostId: 'office-vault', name: 'office-tower-1' }]);
  const shared = item({ sharing: { revision: 2, allMachines: false, machines: ['office-vault'], folders: [] } });
  assert.deepEqual(sharingSummary(view, shared, canvas).machines, [{ hostId: 'office-vault', name: 'office-tower-1' }]);
  const chips = renderToStaticMarkup(createElement(SecretSharingChips, { summary: sharingSummary(view, shared, canvas) }));
  assert.match(chips, /office-tower-1/); assert.doesNotMatch(chips, /공유 안 함/);
  const draft = sharingDraft(view, shared, canvas);
  assert.deepEqual(draft.machines, ['office-vault']);
  assert.deepEqual(sharingPayload(view, shared, draft), { secretId: 'token', revision: 2, allMachines: false, machines: ['office-vault'], folders: [] });
  const editor = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: shared, canvas, busy: false, change, onClose() {} }));
  for (const label of ['모든 내 머신', '머신 ▸ 전체', '머신 ▸ 특정 프로젝트', 'office-tower-1', '원본 맥']) assert.match(editor, new RegExp(label), label);
});

test('a new secret is for all my machines unless the owner chooses otherwise', () => {
  const markup = renderToStaticMarkup(createElement(SecretAddForm, { view, canvas, busy: false, change, onClose() {} }));
  assert.match(markup, /<input type="checkbox" checked=""[^>]*\/><span><strong>모든 내 머신<\/strong>/);
});

test('a share push opens that secret with a one-tap share to the computer that asked', () => {
  assert.equal(shareRequestOf(new URL('https://tower.example/?session=s')), undefined);
  assert.deepEqual(shareRequestOf(new URL('https://tower.example/?secretShare=token&machine=office-vault')), { secretId: 'token', hostId: 'office-vault' });
  assert.deepEqual(shareRequestOf(new URL('https://tower.example/?secretShare=')), {}, 'the locked-vault push opens the secrets');
  openShareRequest(new URL('https://tower.example/?secretShare=token&machine=office-vault'));
  assert.equal(pendingShare('token'), 'office-vault'); assert.equal(pendingShare('other'), undefined);
  const unshared = item({ sharing: { revision: 1, allMachines: false, machines: [], folders: [] } });
  const asked = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: unshared, canvas, busy: false, change, onClose() {} }));
  assert.match(asked, /office-tower-1 작업이 이 시크릿을 쓰려 합니다/); assert.match(asked, />이 머신에 공유</);
  const already = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: item({ sharing: { revision: 1, allMachines: false, machines: ['office-vault'], folders: [] } }), canvas, busy: false, change, onClose() {} }));
  assert.doesNotMatch(already, /이 머신에 공유/, 'nothing to ask once shared');
});

test('a vault this computer’s machine key opens is opened with one press: no Tower or recovery password asked', () => {
  assert.equal(unlockMode('missing', {}, true), 'machine', 'not the Tower and recovery passwords together');
  assert.equal(unlockMode(undefined, { recovery: true }, true), 'machine');
  assert.equal(unlockMode('missing', {}), 'both', 'any other vault as before');
  assert.deepEqual(unlockRequest('machine', '', ''), ['unlock', {}]);
  assert.equal(unlockReady('machine', '', ''), true);
  const status = { initialized: true, locked: true, machineKey: true as const, towerPassword: 'missing' as const };
  const access = renderToStaticMarkup(createElement(SecretAccess, { status, busy: false, change }));
  assert.doesNotMatch(access, /type="password"/); assert.match(access, /머신 키로 엽니다/);
  assert.match(access, /<button type="submit">잠금 해제<\/button>/, 'ready to press');
  const paste = renderToStaticMarkup(createElement(SecretPaste, { view: { status, available: [], connectable: [], usage: [], unavailableSources: [], updatePendingSources: [], error: 'locked' }, sessionId: 's', busy: false, change, onConnected() {} }));
  assert.doesNotMatch(paste, /type="password"/); assert.match(paste, /머신 키로 엽니다/);
});
