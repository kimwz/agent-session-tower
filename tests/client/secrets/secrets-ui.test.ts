import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SecretPeer, SecretSessionView, SecretSettingsItem, SecretSettingsView } from '../../../shared/secrets.js';
import {
  addPayload, describeFolder, folderIdentity, folderKey, pastePayload, pollDelay, quickSecretKind, secretFolderChoices, secretSession, secretSessionPath,
  secretFailure, sessionBlocked, sharingDraft, sharingPayload, sharingSummary, suggestedSecretName, usedSecrets, WORKER_PENDING, type SecretFolderChoice,
} from '../../../client/src/secrets/secrets-client.js';
import { ApiError } from '../../../client/src/common/lib.js';
import { SecretAccess } from '../../../client/src/secrets/SecretAccess.js';
import { SecretSettingsWorkspace } from '../../../client/src/secrets/SecretSettings.js';
import { SecretSharingEditor } from '../../../client/src/secrets/SecretSharingEditor.js';
import { SecretAvailable } from '../../../client/src/secrets/SecretAvailable.js';
import { SecretPaste } from '../../../client/src/secrets/SecretPaste.js';
import { SecretTrustEditor, parseSecretDevice } from '../../../client/src/secrets/SecretAdvanced.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';

const original = getLanguage();
test.beforeEach(() => setLanguage('ko'));
test.afterEach(() => setLanguage(original));
const noop = () => {};
const change = async () => true;
const node = 'a'.repeat(32);
const other = 'b'.repeat(32);
const device = { id: 'source', name: '원본 맥', signingKey: 'public-signing', encryptionKey: 'public-encryption', fingerprint: 'public-fingerprint' };
const peer: SecretPeer = { device: { ...device, id: 'peer-device', name: '빌드 서버' }, routeId: node, direction: 'node', enabled: true };
const controller: SecretPeer = { device: { ...device, id: 'controller-device', name: '상위 Tower' }, routeId: other, direction: 'controller', enabled: true };
const reference = (id: string) => `tower-secret://vault/${id}@1`;
const item = (id: string, patch: Partial<SecretSettingsItem> = {}): SecretSettingsItem => ({ id, name: id.toUpperCase(), groupId: 'tower', kind: 'scalar', version: 1, reference: reference(id), sourceHostId: device.id, ...patch });
const view: SecretSettingsView = {
  status: { initialized: true, locked: false }, device, peers: [peer, controller],
  secrets: [
    item('global_key', { sharing: { revision: 3, global: true, folders: [] } }),
    item('folder_key', { kind: 'env', fields: ['DATABASE_URL'], sharing: { revision: 1, global: false, folders: [{ hostId: device.id, root: '/work/app' }, { hostId: peer.device.id, root: '/srv/app' }] } }),
    item('lonely_key', { sharing: { revision: 1, global: false, folders: [] } }),
    item('legacy_key', { legacy: { global: [{ hostId: device.id }], folders: [{ hostId: 'gone-device', root: '/old/app' }], limited: true } }),
    item('withheld_key', { withheld: true, sharing: { revision: 2, global: false, folders: [{ hostId: device.id, root: '/work/app' }] } }),
  ],
};
const choices: SecretFolderChoice[] = [
  { key: '/work/app', label: 'app', computer: '원본 맥' },
  { key: `@${node}//srv/app`, label: 'app', computer: '빌드 서버' },
  { key: `@${other}//elsewhere`, label: 'elsewhere', computer: '모르는 컴퓨터' },
];
const sessionView = (patch: Partial<SecretSessionView> = {}): SecretSessionView => ({
  status: { initialized: true, locked: false },
  available: [
    { id: 'global_key', name: 'GLOBAL_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: reference('global_key'), basis: ['global', 'session'], operations: ['env'] },
    { id: 'remote_key', name: 'REMOTE_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: reference('remote_key'), sourceHostId: 'peer-device', basis: ['remote'], operations: ['env'] },
  ],
  connectable: [{ id: 'lonely_key', name: 'LONELY_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: reference('lonely_key') }, { id: 'global_key', name: 'GLOBAL_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: reference('global_key') }],
  usage: [], unavailableSources: [], ...patch,
});

test('joined-session requests address the source vault and pass only canonical session and node identities', () => {
  assert.deepEqual(secretSession(`@${node}/codex:session`), { sessionId: 'codex:session', nodeId: node });
  assert.deepEqual(secretSession('claude:local'), { sessionId: 'claude:local' });
  const query = new URL(secretSessionPath(`@${node}/codex:session`), 'http://source');
  assert.equal(query.pathname, '/api/secrets/session');
  assert.equal(query.searchParams.get('sessionId'), 'codex:session'); assert.equal(query.searchParams.get('nodeId'), node);
  assert.doesNotMatch(secretSessionPath(`@${node}/codex:session`), /\/api\/nodes\//);
});

test('a stored folder maps to its canvas key and back: this computer by path, a trusted node by its route', () => {
  assert.equal(folderKey(view, { hostId: device.id, root: '/work/app' }), '/work/app');
  assert.equal(folderKey(view, { hostId: peer.device.id, root: '/srv/app' }), `@${node}//srv/app`, 'the same key the canvas uses for that folder');
  assert.equal(folderKey(view, { hostId: 'gone-device', root: '/old/app' }), undefined);
  assert.equal(folderKey(view, { hostId: controller.device.id, root: '/x' }), undefined, 'a controller is not a computer of the canvas');
  assert.deepEqual(folderIdentity(view, '/work/app'), { hostId: device.id, root: '/work/app' });
  assert.deepEqual(folderIdentity(view, `@${node}//srv/app`), { hostId: peer.device.id, root: '/srv/app' });
  assert.equal(folderIdentity(view, `@${other}//elsewhere`), undefined, 'a joined computer not trusted for secrets');
  for (const key of ['/work/app', `@${node}//srv/app`]) assert.equal(folderKey(view, folderIdentity(view, key)!), key);
});

test('settings get every canvas folder of every computer, named with its computer', () => {
  const projects: [string, string][] = [['/work/app', 'app'], [`@${node}//srv/app`, 'app'], [`@${other}//x`, 'x']];
  const hosts = [{ name: '원본 맥' }, { node, name: '빌드 서버' }];
  assert.deepEqual(secretFolderChoices(projects, hosts), [
    { key: '/work/app', label: 'app', computer: '원본 맥' },
    { key: `@${node}//srv/app`, label: 'app', computer: '빌드 서버' },
    { key: `@${other}//x`, label: 'x', computer: '' },
  ]);
});

test('a row summary names folders by canvas label, path and computer, and an unknown computer by its raw ID', () => {
  const folders = sharingSummary(view, view.secrets[1]!, choices).folders;
  assert.deepEqual(folders, [{ key: '/work/app', label: 'app', root: '/work/app', computer: '원본 맥' }, { key: `@${node}//srv/app`, label: 'app', root: '/srv/app', computer: '빌드 서버' }]);
  assert.deepEqual(describeFolder(view, { hostId: 'gone-device', root: '/old/app' }, choices), { label: 'app', root: '/old/app', computer: 'gone-device' });
  const legacy = sharingSummary(view, view.secrets[3]!, choices);
  assert.equal(legacy.legacy, true); assert.equal(legacy.global, true); assert.deepEqual(legacy.globalComputers, ['원본 맥']); assert.equal(legacy.limited, true);
  assert.equal(sharingSummary(view, view.secrets[4]!, choices).withheld, true);
});

test('the sharing editor starts from stored sharing or the legacy summary and saves folders as canvas keys with the revision', () => {
  const shared = sharingDraft(view, view.secrets[1]!, choices);
  assert.deepEqual(shared, { global: false, keys: ['/work/app', `@${node}//srv/app`], kept: [], dropped: [] });
  assert.deepEqual(sharingPayload(view.secrets[1]!, shared), { secretId: 'folder_key', revision: 1, global: false, folders: [{ cwd: '/work/app' }, { cwd: `@${node}//srv/app` }] });
  const legacy = sharingDraft(view, view.secrets[3]!, choices);
  assert.equal(legacy.global, true); assert.deepEqual(legacy.keys, []); assert.deepEqual(legacy.kept, []); assert.deepEqual(legacy.dropped.map(folder => folder.root), ['/old/app']);
  assert.deepEqual(sharingPayload(view.secrets[3]!, { global: true, keys: [], kept: [] }), { secretId: 'legacy_key', revision: 0, global: true, folders: [] }, 'a legacy secret saves with revision 0');
  assert.equal(sharingPayload(view.secrets[0]!, { global: false, keys: [], kept: [] }).revision, 3);
  const away = item('away_key', { sharing: { revision: 7, global: false, folders: [{ hostId: device.id, root: '/work/app' }, { hostId: 'gone-device', root: '/old/app' }] } });
  const draft = sharingDraft(view, away, choices);
  assert.deepEqual(draft.kept, [{ hostId: 'gone-device', root: '/old/app' }], 'a stored folder of a computer no longer trusted is kept as it was received');
  assert.deepEqual(sharingPayload(away, draft).folders, [{ cwd: '/work/app' }, { hostId: 'gone-device', root: '/old/app' }]);
});

test('a refused save names its reason: a disconnected joined computer, an outdated worker, or the generic hint', () => {
  const t = (key: string) => key;
  assert.equal(secretFailure(new ApiError('그 컴퓨터가 지금 연결되어 있지 않습니다.', 503), t), '그 컴퓨터가 지금 연결되어 있지 않습니다.');
  assert.equal(secretFailure(new ApiError('ignored', 503, undefined, 'worker-update-pending'), t), WORKER_PENDING);
  assert.equal(secretFailure(new ApiError('internal detail', 500), t), '시크릿 요청을 완료하지 못했습니다. 잠금 상태와 입력을 확인하세요.');
  assert.equal(secretFailure(new ApiError('폴더가 아닙니다.', 400), t), '폴더가 아닙니다.');
});

test('a chat paste is temporary and connected by default; saving keeps it in the vault with the chosen sharing', () => {
  const raw = '# dotenv\nexport TOKEN=FAKE_TOKEN\nOTHER=FAKE_OTHER';
  assert.equal(quickSecretKind(raw, 'auto'), 'env'); assert.equal(quickSecretKind(raw, 'scalar'), 'scalar'); assert.equal(quickSecretKind('fake-password', 'auto'), 'scalar');
  const base = { raw, format: 'auto' as const, name: '', sessionId: `@${node}/codex:session`, cwd: `@${node}//srv/app` };
  assert.deepEqual(pastePayload({ ...base, destination: 'session' }), { name: 'TOKEN', kind: 'env', value: raw, connect: 'session', temporary: true, sessionId: 'codex:session', nodeId: node });
  assert.deepEqual(pastePayload({ ...base, destination: 'none' }), { name: 'TOKEN', kind: 'env', value: raw, connect: 'session', sessionId: 'codex:session', nodeId: node });
  assert.deepEqual(pastePayload({ ...base, destination: 'folder' }).sharing, { global: false, folders: [{ cwd: `@${node}//srv/app` }] });
  assert.deepEqual(pastePayload({ ...base, destination: 'global' }).sharing, { global: true, folders: [] });
  assert.equal('temporary' in pastePayload({ ...base, destination: 'global' }), false);
  const file = pastePayload({ ...base, raw: 'AAECAw==', format: 'file', fileName: 'key.pem', destination: 'session' });
  assert.equal(file.content, 'AAECAw=='); assert.equal(file.value, undefined); assert.equal(file.name, 'key.pem');
  assert.equal(pastePayload({ ...base, raw: 'x', name: '  NAMED  ', destination: 'session' }).name, 'NAMED');
  assert.equal(suggestedSecretName('fake', 'scalar'), 'SESSION_SECRET');
});

test('a secret added in the settings has no session and is unshared unless sharing is chosen', () => {
  const plain = addPayload({ raw: 'private-value', format: 'auto', name: 'API_KEY', global: false, keys: [] });
  assert.deepEqual(plain, { name: 'API_KEY', kind: 'scalar', value: 'private-value' });
  const shared = addPayload({ raw: 'private-value', format: 'auto', name: 'API_KEY', global: false, keys: ['/work/app', `@${node}//srv/app`] });
  assert.deepEqual(shared.sharing, { global: false, folders: [{ cwd: '/work/app' }, { cwd: `@${node}//srv/app` }] });
  assert.equal('sessionId' in shared, false); assert.equal('connect' in shared, false);
});

test('composer chips are the distinct secrets this session used, newest first', () => {
  const use = (secretId: string, at: number, outcome: 'delivered' | 'blocked' = 'delivered') => ({ at, secretId, name: secretId.toUpperCase(), operation: 'env' as const, outcome, review: 'exempt' as const });
  assert.deepEqual(usedSecrets([use('b', 3), use('a', 2), use('b', 1, 'blocked')]).map(entry => [entry.secretId, entry.at]), [['b', 3], ['a', 2]]);
  assert.deepEqual(usedSecrets([]), []);
});

test('the session view is read every 10 s while open and 60 s while closed, and not again after a permanent state', () => {
  assert.equal(pollDelay(undefined, true), 10_000); assert.equal(pollDelay({}, false), 60_000);
  assert.equal(pollDelay({ permanent: false }, true), 10_000);
  assert.equal(pollDelay({ permanent: true }, true), undefined); assert.equal(pollDelay({ permanent: true }, false), undefined);
  assert.equal(sessionBlocked('not-eligible'), true); assert.equal(sessionBlocked('session-closed'), true); assert.equal(sessionBlocked('worker-update-pending'), true);
  assert.equal(sessionBlocked('locked'), false); assert.equal(sessionBlocked(undefined), false);
});

test('settings list every secret once with its masked value, sharing summary and row actions, never a value or reference', () => {
  const markup = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view, choices, busy: false, change }));
  for (const name of ['GLOBAL_KEY', 'FOLDER_KEY', 'LONELY_KEY', 'LEGACY_KEY', 'WITHHELD_KEY']) assert.equal(markup.split(`<strong>${name}</strong>`).length, 2, name);
  assert.match(markup, /GLOBAL/); assert.match(markup, /공유 안 함/); assert.match(markup, /빌드 서버/); assert.match(markup, /title="app · \/srv\/app · 빌드 서버"/);
  assert.match(markup, /기존 규칙/); assert.match(markup, /GLOBAL · 원본 맥/); assert.match(markup, /기존 규칙에 사용 방식·필드·기간 제한이 있습니다/);
  assert.match(markup, /구버전에서 규칙이 바뀌었습니다. 공유를 다시 저장하세요/);
  assert.match(markup, /••••••••/); assert.match(markup, />공유 편집</); assert.match(markup, />값 교체</); assert.match(markup, />삭제</);
  assert.match(markup, /시크릿 추가/); assert.match(markup, /잠금 해제됨/); assert.match(markup, />잠그기</); assert.match(markup, /<details class="secret-advanced"/);
  assert.doesNotMatch(markup, /tower-secret:\/\/|public-signing|public-encryption/);
  assert.doesNotMatch(markup, /프로젝트 자동 연결|공유 규칙|프로젝트 등록|규칙 추가/, 'no second tab, project registration or rule editor');
  const locked = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: { ...view, status: { initialized: true, locked: true } }, choices, busy: false, change }));
  assert.doesNotMatch(locked, /GLOBAL_KEY/); assert.match(locked, /잠금 해제/);
});

test('a pending import opens the advanced section; a remote secret stays read-only', () => {
  const markup = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: { ...view, status: { initialized: true, locked: false, pendingImports: 1, pendingImportIds: ['backup'] }, secrets: [item('remote', { sourceHostId: 'peer-device', sharing: { revision: 1, global: true, folders: [] } })] }, choices, busy: false, change }));
  assert.match(markup, /<details class="secret-advanced" open=""/); assert.match(markup, /보관함 가져오기/); assert.match(markup, /보관함 비밀번호 변경/); assert.match(markup, /빌드 서버/);
  assert.match(markup, /원본에서 관리/); assert.doesNotMatch(markup, />공유 편집<|>값 교체<|>삭제</);
});

test('the sharing editor offers every computer’s folders with path and computer, keeps chosen folders off the canvas and refuses untrusted computers', () => {
  const selected = item('picked', { sharing: { revision: 4, global: false, folders: [{ hostId: device.id, root: '/work/app' }, { hostId: device.id, root: '/hidden/folder' }] } });
  const markup = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: selected, choices, busy: false, change, onClose: noop }));
  assert.match(markup, /폴더 이름, 경로, 컴퓨터 검색/); assert.match(markup, /\/srv\/app/); assert.match(markup, /빌드 서버/);
  assert.match(markup, /folder<\/strong><small>\/hidden\/folder<\/small><small>원본 맥<\/small><small>캔버스에 없음/, 'a chosen folder the canvas no longer lists stays removable');
  assert.match(markup, /aria-label="folder 선택 해제"/);
  assert.match(markup, /disabled=""[^>]*\/><span><strong>elsewhere<\/strong><small>\/elsewhere<\/small><small>모르는 컴퓨터 · 시크릿 연결을 승인하지 않은 컴퓨터/);
  assert.doesNotMatch(markup, /기존 규칙/);
  const legacy = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: view.secrets[3]!, choices, busy: false, change, onClose: noop }));
  assert.match(legacy, /기존 규칙/); assert.match(legacy, /type="checkbox" checked=""/); assert.match(legacy, /사용 방식·필드·기간 제한은 저장하면 사라집니다/);
  assert.match(legacy, /승인이 해제된 컴퓨터의 폴더는 저장하면 빠집니다/); assert.match(legacy, /gone-device/);
  const away = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: item('away', { sharing: { revision: 1, global: false, folders: [{ hostId: 'gone-device', root: '/old/app' }] } }), choices, busy: false, change, onClose: noop }));
  assert.match(away, /승인을 해제한 컴퓨터의 폴더입니다/); assert.match(away, /aria-label="app 선택 해제"/); assert.doesNotMatch(away, /저장하면 빠집니다/);
  const withheld = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: view.secrets[4]!, choices, busy: false, change, onClose: noop }));
  assert.match(withheld, /구버전에서 규칙이 바뀌었습니다/);
});

test('the available tab shows each basis, never offers sharing for a remote source, and tells each state apart', () => {
  const markup = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ usage: [{ at: Date.now(), secretId: 'global_key', name: 'GLOBAL_KEY', operation: 'env', outcome: 'delivered', review: 'exempt' }] }), busy: false, change, onPaste: noop, onSharing: noop }));
  assert.match(markup, />GLOBAL</); assert.match(markup, />이 세션</); assert.match(markup, />원격 원본</); assert.match(markup, /최근 사용 · /); assert.match(markup, /아직 사용하지 않음/);
  assert.match(markup, /aria-label="GLOBAL_KEY 공유 설정"/); assert.doesNotMatch(markup, /REMOTE_KEY 공유 설정/); assert.match(markup, /REMOTE_KEY 이 세션에서 끊기/);
  const temporary = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ connectable: [] }), busy: false, change, onPaste: noop, onSharing: noop }));
  assert.doesNotMatch(temporary, /공유 설정/, 'a value pasted for this session alone has no sharing to edit');
  assert.match(markup, /기존 시크릿 연결/); assert.match(markup, /새 시크릿 추가/);
  const titles = { locked: '잠김', 'source-unavailable': '원본 컴퓨터 연결 실패', 'session-closed': '종료된 세션', 'not-eligible': '이 세션은 사용할 수 없음', 'worker-update-pending': '새 실행 워커 적용 대기', uninitialized: '보관함 없음' } as const;
  for (const [error, title] of Object.entries(titles)) {
    const state = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ error: error as keyof typeof titles, available: [] }), busy: false, change, onPaste: noop, onSharing: noop }));
    assert.match(state, new RegExp(`secret-state-${error}"><strong>${title}</strong>`));
    for (const [otherError, otherTitle] of Object.entries(titles)) if (otherError !== error) assert.doesNotMatch(state, new RegExp(`<strong>${otherTitle}</strong>`));
  }
  const locked = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ error: 'locked', status: { initialized: true, locked: true } }), busy: false, change, onPaste: noop, onSharing: noop }));
  assert.match(locked, /type="password"/); assert.doesNotMatch(locked, /GLOBAL_KEY/);
});

test('the paste tab shows the paste input first, even before vault setup, and connects to this session by default', () => {
  const setup = renderToStaticMarkup(createElement(SecretPaste, { view: sessionView({ status: { initialized: false, locked: true }, error: 'uninitialized', permanent: true }), sessionId: 's', busy: false, change, onConnected: noop }));
  assert.ok(setup.indexOf('시크릿 붙여넣기') < setup.indexOf('비밀번호 확인'));
  assert.match(setup, /textarea autofocus/); assert.match(setup, /처음 한 번/); assert.match(setup, /보관함에 저장/);
  const ready = renderToStaticMarkup(createElement(SecretPaste, { view: sessionView(), sessionId: 's', cwd: '/work/app', busy: false, change, onConnected: noop }));
  assert.match(ready, /class="secret-primary" disabled="">이 세션에 연결/); assert.doesNotMatch(ready, /잠금 해제|공유 규칙|허용할 사용 방식/);
  assert.match(ready, /placeholder="SESSION_SECRET"/);
});

test('password setup requires confirmation and 12 characters while locked vault offers owner-only unlock', () => {
  const setup = renderToStaticMarkup(createElement(SecretAccess, { status: { initialized: false, locked: true }, busy: false, change }));
  assert.match(setup, /시크릿 보관함 만들기/); assert.match(setup, /minLength="12"/); assert.match(setup, /비밀번호 확인/); assert.match(setup, /type="submit" disabled/);
  const locked = renderToStaticMarkup(createElement(SecretAccess, { status: { initialized: true, locked: true }, busy: false, change }));
  assert.match(locked, /잠금 해제/); assert.match(locked, /autoComplete="current-password"/); assert.doesNotMatch(locked, /비밀번호 확인/);
});

test('peer public code parsing drops extra properties and rejects malformed codes without reflecting pasted data', () => {
  assert.deepEqual(parseSecretDevice(JSON.stringify({ ...device, password: 'private-canary' })), device);
  assert.throws(() => parseSecretDevice(JSON.stringify({ id: 'source', password: 'private-canary' })), /Invalid public device/);
});

test('remote approval chooses a known connection by name while still requiring public-code fingerprint verification', () => {
  const markup = renderToStaticMarkup(createElement(SecretTrustEditor, { device, busy: false, change, onClose: noop, computers: [{ node: 'connected-id', name: '테스트 서버', connected: true }, { node: 'offline-id', name: '꺼진 서버', connected: false }] }));
  assert.match(markup, /연결된 컴퓨터/); assert.match(markup, /테스트 서버/); assert.match(markup, /value="offline-id" disabled/); assert.match(markup, /이 컴퓨터의 공개 코드 복사/);
  assert.doesNotMatch(markup, /원격 연결 ID/); assert.match(markup, /지문 확인/); assert.match(markup, /disabled="">컴퓨터 승인/);
});

test('secret controls have English translations while key names remain exact', () => {
  setLanguage('en');
  const settings = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view, choices, busy: false, change }));
  assert.match(settings, /Edit sharing/); assert.match(settings, /Replace value/); assert.match(settings, /Not shared/); assert.match(settings, /Earlier rules/); assert.match(settings, /Add secret/); assert.match(settings, /FOLDER_KEY/);
  const available = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ error: 'worker-update-pending' }), busy: false, change, onPaste: noop, onSharing: noop }));
  assert.match(available, /Waiting for the new execution worker/); assert.match(available, /Connect a saved secret/); assert.match(available, /This session/);
  const visible = (markup: string) => markup.replace(/<[^>]*>/g, ' ');
  for (const markup of [settings, available]) assert.doesNotMatch(visible(markup).replace(/원본 맥|빌드 서버|상위 Tower/g, ''), /[가-힣]/, 'every control is translated; computer names stay as they are');
});

test('pending encrypted vault restores remain waiting and direct the owner to Secrets settings', async () => {
  const { RestoreStatus } = await import('../../../client/src/backup/BackupPanel.js');
  const report = { id: 'restore', status: 'waiting-secrets' as const, requestedAt: '2026-10-02', from: 'source', createdAt: '2026-10-02', applied: [], worker: [], errors: [], pendingSecretImports: ['vault-id'] };
  const markup = renderToStaticMarkup(createElement(RestoreStatus, { report, busy: false, onCancel: noop }));
  assert.match(markup, /시크릿 보관함 가져오기를 기다립니다/); assert.match(markup, /원본 보관함 비밀번호/); assert.match(markup, /시크릿 설정 열기/);
  assert.doesNotMatch(markup, /복원을 적용했습니다|복원을 취소했습니다/);
});

test('partial remote source failure is shown as a generic alert without reflecting server error details', () => {
  const markup = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: { ...view, status: { ...view.status, error: 'source-private-error-canary' } }, choices, busy: false, change }));
  assert.match(markup, /role="alert"/); assert.match(markup, /원본 컴퓨터의 연결과 잠금 상태/); assert.doesNotMatch(markup, /source-private-error-canary/);
});
