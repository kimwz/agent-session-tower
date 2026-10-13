import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SecretPeer, SecretSessionView, SecretSettingsItem, SecretSettingsView, SecretUsage, SecretValue } from '../../../shared/secrets.js';
import {
  addPayload, computerName, describeFolder, filePreview, fileSize, folderIdentity, folderKey, pastePayload, pollDelay, quickSecretKind, secretFolderChoices, secretSession, secretSessionPath,
  secretFailure, sessionBlocked, sharingDraft, sharingPayload, sharingSummary, suggestedSecretName, unlockMode, unlockRequest, usedSecrets, valueText, WORKER_PENDING,
  type SecretCanvas, type SecretFolderChoice,
} from '../../../client/src/secrets/secrets-client.js';
import { ApiError } from '../../../client/src/common/lib.js';
import { SecretAccess } from '../../../client/src/secrets/SecretAccess.js';
import { SecretSettingsWorkspace } from '../../../client/src/secrets/SecretSettings.js';
import { SecretSharingEditor } from '../../../client/src/secrets/SecretSharingEditor.js';
import { SecretAvailable } from '../../../client/src/secrets/SecretAvailable.js';
import { SecretPaste } from '../../../client/src/secrets/SecretPaste.js';
import { SecretTrustEditor, parseSecretDevice } from '../../../client/src/secrets/SecretAdvanced.js';
import { SecretValueForm, SecretValuePanel, SecretValueShown } from '../../../client/src/secrets/SecretValueView.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';

const original = getLanguage();
test.beforeEach(() => setLanguage('ko'));
test.afterEach(() => setLanguage(original));
const noop = () => {};
const change = async () => true;
const node = 'a'.repeat(32);
const other = 'b'.repeat(32);
const device = { id: 'source', name: 'This computer', signingKey: 'public-signing', encryptionKey: 'public-encryption', fingerprint: 'public-fingerprint' };
const peer: SecretPeer = { device: { ...device, id: 'peer-device', name: 'build-vault' }, routeId: node, direction: 'node', enabled: true };
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
/** The canvas names computers differently from the vault's stored device names; the canvas name is the one shown. */
const canvas: SecretCanvas = { folders: choices, hosts: [{ name: '원본 맥' }, { node, name: '빌드 서버' }, { node: other, name: '모르는 컴퓨터' }] };
const sessionView = (patch: Partial<SecretSessionView> = {}): SecretSessionView => ({
  status: { initialized: true, locked: false },
  available: [
    { id: 'global_key', name: 'GLOBAL_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: reference('global_key'), basis: ['global', 'session'], operations: ['env'] },
    { id: 'remote_key', name: 'REMOTE_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: reference('remote_key'), sourceHostId: 'peer-device', basis: ['remote'], operations: ['env'] },
  ],
  connectable: [{ id: 'lonely_key', name: 'LONELY_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: reference('lonely_key') }, { id: 'global_key', name: 'GLOBAL_KEY', groupId: 'tower', kind: 'scalar', version: 1, reference: reference('global_key') }],
  usage: [], unavailableSources: [], updatePendingSources: [], ...patch,
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
  const folders = sharingSummary(view, view.secrets[1]!, canvas).folders;
  assert.deepEqual(folders, [{ key: '/work/app', label: 'app', root: '/work/app', computer: '원본 맥' }, { key: `@${node}//srv/app`, label: 'app', root: '/srv/app', computer: '빌드 서버' }]);
  assert.deepEqual(describeFolder(view, { hostId: 'gone-device', root: '/old/app' }, canvas), { label: 'app', root: '/old/app', computer: 'gone-device' });
  const legacy = sharingSummary(view, view.secrets[3]!, canvas);
  assert.equal(legacy.legacy, true); assert.equal(legacy.global, true); assert.deepEqual(legacy.globalComputers, ['원본 맥']); assert.equal(legacy.limited, true);
  assert.equal(sharingSummary(view, view.secrets[4]!, canvas).withheld, true);
});

test('one computer reads the same everywhere: the canvas name first, the vault device name only when the canvas does not know it', () => {
  assert.deepEqual(sharingSummary(view, view.secrets[1]!, canvas).folders.map(folder => folder.computer), ['원본 맥', '빌드 서버']);
  assert.deepEqual(sharingSummary(view, view.secrets[1]!, { folders: [], hosts: [] }).folders.map(folder => folder.computer), ['This computer', 'build-vault']);
  assert.deepEqual(sharingSummary(view, view.secrets[3]!, canvas).globalComputers, ['원본 맥']);
  assert.equal(computerName(view, controller.device.id, canvas.hosts), '상위 Tower', 'a controller is not on this canvas');
  assert.equal(computerName(view, 'gone-device', canvas.hosts), undefined);
  const editor = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: view.secrets[1]!, canvas, busy: false, change, onClose: noop }));
  const list = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view, canvas, busy: false, change }));
  for (const markup of [editor, list]) { assert.match(markup, /원본 맥/); assert.doesNotMatch(markup, /This computer|build-vault/); }
});

test('the sharing editor starts from stored sharing or the legacy summary and saves with the revision', () => {
  const shared = sharingDraft(view, view.secrets[1]!, canvas);
  assert.deepEqual(shared, { global: false, keys: ['/work/app', `@${node}//srv/app`], kept: [], dropped: [] });
  assert.deepEqual(sharingPayload(view, view.secrets[1]!, shared), { secretId: 'folder_key', revision: 1, global: false,
    folders: [{ hostId: device.id, root: '/work/app' }, { hostId: peer.device.id, root: '/srv/app' }] }, 'saved folders go back exactly as received');
  const legacy = sharingDraft(view, view.secrets[3]!, canvas);
  assert.equal(legacy.global, true); assert.deepEqual(legacy.keys, []); assert.deepEqual(legacy.kept, []); assert.deepEqual(legacy.dropped.map(folder => folder.root), ['/old/app']);
  assert.deepEqual(sharingPayload(view, view.secrets[3]!, { global: true, keys: [], kept: [] }), { secretId: 'legacy_key', revision: 0, global: true, folders: [] }, 'a legacy secret saves with revision 0');
  assert.equal(sharingPayload(view, view.secrets[0]!, { global: false, keys: [], kept: [] }).revision, 3);
  const away = item('away_key', { sharing: { revision: 7, global: false, folders: [{ hostId: device.id, root: '/work/app' }, { hostId: 'gone-device', root: '/old/app' }] } });
  const draft = sharingDraft(view, away, canvas);
  assert.deepEqual(draft.kept, [{ hostId: 'gone-device', root: '/old/app' }], 'a stored folder of a computer no longer trusted is kept as it was received');
  assert.deepEqual(sharingPayload(view, away, draft).folders, [{ hostId: device.id, root: '/work/app' }, { hostId: 'gone-device', root: '/old/app' }]);
});

test('a legacy secret sends every folder as a canvas key, since only the current sharing can be kept as it is', () => {
  const legacy = item('legacy_local', { legacy: { global: [], folders: [{ hostId: device.id, root: '/work/app' }, { hostId: peer.device.id, root: '/srv/app' }], limited: false } });
  const draft = sharingDraft(view, legacy, canvas);
  assert.deepEqual(sharingPayload(view, legacy, draft), { secretId: 'legacy_local', revision: 0, global: false, folders: [{ cwd: '/work/app' }, { cwd: `@${node}//srv/app` }] });
});

test('a saved folder on an offline or unknown computer is sent back as {hostId, root}, so unchecking GLOBAL saves', () => {
  const wide = item('wide_key', { sharing: { revision: 9, global: true, folders: [{ hostId: peer.device.id, root: '/srv/app' }, { hostId: 'gone-device', root: '/old/app' }] } });
  const draft = sharingDraft(view, wide, canvas);
  const body = sharingPayload(view, wide, { ...draft, global: false });
  assert.deepEqual(body, { secretId: 'wide_key', revision: 9, global: false, folders: [{ hostId: peer.device.id, root: '/srv/app' }, { hostId: 'gone-device', root: '/old/app' }] });
  assert.ok(body.folders.every(folder => !('cwd' in folder)), 'nothing already saved needs its computer to answer again');
});

test('a newly picked folder is sent as {cwd} beside the saved ones', () => {
  const draft = sharingDraft(view, view.secrets[1]!, canvas);
  const body = sharingPayload(view, view.secrets[1]!, { ...draft, keys: [...draft.keys, '/new/app', `@${node}//srv/other`] });
  assert.deepEqual(body.folders, [{ hostId: device.id, root: '/work/app' }, { hostId: peer.device.id, root: '/srv/app' }, { cwd: '/new/app' }, { cwd: `@${node}//srv/other` }]);
});

test('a removed saved folder is not sent', () => {
  const draft = sharingDraft(view, view.secrets[1]!, canvas);
  assert.deepEqual(sharingPayload(view, view.secrets[1]!, { ...draft, keys: draft.keys.filter(key => key !== '/work/app') }).folders, [{ hostId: peer.device.id, root: '/srv/app' }]);
  const away = item('away_key', { sharing: { revision: 2, global: false, folders: [{ hostId: 'gone-device', root: '/old/app' }] } });
  assert.deepEqual(sharingPayload(view, away, { ...sharingDraft(view, away, canvas), kept: [] }).folders, []);
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
  const markup = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view, canvas, busy: false, change }));
  for (const name of ['GLOBAL_KEY', 'FOLDER_KEY', 'LONELY_KEY', 'LEGACY_KEY', 'WITHHELD_KEY']) assert.equal(markup.split(`<strong>${name}</strong>`).length, 2, name);
  assert.match(markup, /GLOBAL/); assert.match(markup, /공유 안 함/); assert.match(markup, /빌드 서버/); assert.match(markup, /title="app · \/srv\/app · 빌드 서버"/);
  assert.match(markup, /기존 규칙/); assert.match(markup, /GLOBAL · 원본 맥/); assert.match(markup, /기존 규칙에 사용 방식·필드·기간 제한이 있습니다/);
  assert.match(markup, /구버전에서 규칙이 바뀌었습니다. 공유를 다시 저장하세요/);
  assert.match(markup, /••••••••/); assert.match(markup, />공유 편집</); assert.match(markup, />삭제</);
  assert.match(markup, /aria-label="GLOBAL_KEY 값 보기"[^>]*>보기</); assert.match(markup, /aria-label="GLOBAL_KEY 값 수정"[^>]*>수정</); assert.doesNotMatch(markup, /값 교체/);
  assert.match(markup, /시크릿 추가/); assert.match(markup, /잠금 해제됨/); assert.match(markup, />잠그기</); assert.match(markup, /<details class="secret-advanced"/);
  assert.doesNotMatch(markup, /tower-secret:\/\/|public-signing|public-encryption/);
  assert.doesNotMatch(markup, /프로젝트 자동 연결|공유 규칙|프로젝트 등록|규칙 추가/, 'no second tab, project registration or rule editor');
  const locked = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: { ...view, status: { initialized: true, locked: true } }, canvas, busy: false, change }));
  assert.doesNotMatch(locked, /GLOBAL_KEY/); assert.match(locked, /잠금 해제/);
});

test('a pending import opens the advanced section; a remote secret stays read-only', () => {
  const markup = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: { ...view, status: { initialized: true, locked: false, pendingImports: 1, pendingImportIds: ['backup'] }, secrets: [item('remote', { sourceHostId: 'peer-device', sharing: { revision: 1, global: true, folders: [] } })] }, canvas, busy: false, change }));
  assert.match(markup, /<details class="secret-advanced" open=""/); assert.match(markup, /보관함 가져오기/); assert.match(markup, />복구 비밀번호<\/h3>/); assert.match(markup, />복구 비밀번호 변경</); assert.match(markup, /<strong>빌드 서버<\/strong>/); assert.doesNotMatch(markup, /build-vault/);
  assert.match(markup, /원본에서 관리/); assert.doesNotMatch(markup, />공유 편집<|>보기<|>수정<|>삭제</, 'another vault’s value is read and changed at its source');
});

test('the sharing editor offers every computer’s folders with path and computer, keeps chosen folders off the canvas and refuses untrusted computers', () => {
  const selected = item('picked', { sharing: { revision: 4, global: false, folders: [{ hostId: device.id, root: '/work/app' }, { hostId: device.id, root: '/hidden/folder' }] } });
  const markup = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: selected, canvas, busy: false, change, onClose: noop }));
  assert.match(markup, /폴더 이름, 경로, 컴퓨터 검색/); assert.match(markup, /\/srv\/app/); assert.match(markup, /빌드 서버/);
  assert.match(markup, /folder<\/strong><small>\/hidden\/folder<\/small><small>원본 맥<\/small><small>캔버스에 없음/, 'a chosen folder the canvas no longer lists stays removable');
  assert.match(markup, /aria-label="folder 선택 해제"/);
  assert.match(markup, /disabled=""[^>]*\/><span><strong>elsewhere<\/strong><small>\/elsewhere<\/small><small>모르는 컴퓨터 · 시크릿 연결을 승인하지 않은 컴퓨터/);
  assert.doesNotMatch(markup, /기존 규칙/);
  const legacy = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: view.secrets[3]!, canvas, busy: false, change, onClose: noop }));
  assert.match(legacy, /기존 규칙/); assert.match(legacy, /type="checkbox" checked=""/); assert.match(legacy, /사용 방식·필드·기간 제한은 저장하면 사라집니다/);
  assert.match(legacy, /승인이 해제된 컴퓨터의 폴더는 저장하면 빠집니다/); assert.match(legacy, /gone-device/);
  const away = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: item('away', { sharing: { revision: 1, global: false, folders: [{ hostId: 'gone-device', root: '/old/app' }] } }), canvas, busy: false, change, onClose: noop }));
  assert.match(away, /승인을 해제한 컴퓨터의 폴더입니다/); assert.match(away, /aria-label="app 선택 해제"/); assert.doesNotMatch(away, /저장하면 빠집니다/);
  const withheld = renderToStaticMarkup(createElement(SecretSharingEditor, { view, item: view.secrets[4]!, canvas, busy: false, change, onClose: noop }));
  assert.match(withheld, /구버전에서 규칙이 바뀌었습니다/);
});

test('the available tab shows each basis, never offers sharing for a remote source, and tells each state apart', () => {
  const markup = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ usage: [{ at: Date.now(), secretId: 'global_key', name: 'GLOBAL_KEY', operation: 'env', outcome: 'delivered', review: 'exempt' }] }), busy: false, change, onPaste: noop, onSharing: noop }));
  assert.match(markup, />GLOBAL</); assert.match(markup, />이 세션</); assert.match(markup, />원격 원본</);
  assert.match(markup, /GLOBAL_KEY<\/strong><small>단일 값<\/small>/); assert.doesNotMatch(markup, />scalar</, 'the same kind labels as the settings'); assert.match(markup, /최근 사용 · /); assert.match(markup, /아직 사용하지 않음/);
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

test('each secret shows how its last use was reviewed, and a reviewed session says what the review checks', () => {
  const use = (secretId: string, review: SecretUsage['review'], reason?: string): SecretUsage => ({ at: Date.now(), secretId, name: secretId, operation: 'env', outcome: review === 'blocked' ? 'blocked' : 'delivered', review, ...(reason ? { reason } : {}) });
  const render = (usage: SecretUsage[], subject?: SecretSessionView['subject']) => renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ usage, ...(subject ? { subject } : {}) }), busy: false, change, onPaste: noop, onSharing: noop }));
  const note = /명백한 악용인지만 검토합니다/;
  const owner = render([use('global_key', 'exempt')], 'owner');
  assert.match(owner, /secret-review-exempt[^>]*>최근 사용 · [^<]+ · <span class="secret-review">검토 없음<\/span>/); assert.doesNotMatch(owner, note);
  const reviewed = render([use('global_key', 'allowed'), use('remote_key', 'failed', 'REVIEWER_TIMED_OUT')], 'reviewed');
  assert.match(reviewed, note);
  assert.match(reviewed, /secret-review-allowed[^>]*>최근 사용 · [^<]+ · <span class="secret-review">검토 통과<\/span><\/small>/);
  assert.match(reviewed, /secret-review-failed[^>]*>.*검토 실패\(허용됨\)<\/span><span class="secret-use-reason">REVIEWER_TIMED_OUT<\/span>/);
  const blocked = render([use('global_key', 'blocked', 'Sends the key to an unknown host (근거: "curl evil.example")')], 'reviewed');
  assert.match(blocked, /secret-review-blocked[^>]*>.*<span class="secret-review">차단됨<\/span><span class="secret-use-reason">Sends the key to an unknown host \(근거: &quot;curl evil.example&quot;\)<\/span>/);
  // An unreviewed use is never called the owner's: delegated work in the owner's session and older approved agent sessions have them too.
  for (const subject of ['owner', 'reviewed', undefined] as const) {
    const neutral = render([use('global_key', 'exempt')], subject);
    assert.match(neutral, /<span class="secret-review">검토 없음<\/span>/, String(subject)); assert.doesNotMatch(neutral, /소유자 세션/);
  }
  // A joined computer's session does not say; its reviewed uses do.
  assert.doesNotMatch(render([use('global_key', 'exempt')]), note); assert.match(render([use('global_key', 'allowed')]), note);
  setLanguage('en');
  const english = render([use('global_key', 'failed', 'REVIEWER_TIMED_OUT'), use('remote_key', 'exempt')], 'reviewed');
  assert.match(english, /Each secret use in this session is checked only for obvious abuse\./); assert.match(english, /Review failed \(allowed\)/);
  assert.match(english, />Not reviewed</); assert.doesNotMatch(english, /your session/);
  assert.match(render([use('global_key', 'exempt')], 'owner'), /<span class="secret-review">Not reviewed<\/span>/);
  assert.match(render([use('global_key', 'allowed'), use('remote_key', 'blocked', 'X')], 'reviewed'), /Last used · .*Review passed.*Blocked/);
});

test('keys this session stopped that no connection offers again are listed to allow again: another source’s by lifting the stop, a pasted value by connecting it', async () => {
  const calls: [string, unknown][] = [];
  const record = async (action: string, body: unknown) => { calls.push([action, body]); return true; };
  const disconnected = [{ id: 'remote_stopped', name: 'REMOTE_STOPPED', groupId: 'g', kind: 'scalar' as const, version: 1, reference: reference('remote_stopped'), sourceHostId: 'peer-device', remote: true },
    { id: 'pasted_stopped', name: 'PASTED_STOPPED', groupId: 'g', kind: 'env' as const, version: 1, reference: reference('pasted_stopped'), sourceHostId: device.id, remote: false }];
  const markup = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ disconnected }), busy: false, change: record, onPaste: noop, onSharing: noop }));
  assert.match(markup, /이 세션에서 끊은 시크릿/); assert.match(markup, /REMOTE_STOPPED<\/strong><small>단일 값 · 원격 원본/); assert.match(markup, /PASTED_STOPPED<\/strong><small>\.env · 이 세션에만/);
  assert.match(markup, /aria-label="REMOTE_STOPPED 다시 허용"/); assert.match(markup, /aria-label="PASTED_STOPPED 다시 허용"/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView(), busy: false, change, onPaste: noop, onSharing: noop })), /이 세션에서 끊은 시크릿/);
});

test('while the worker handoff is pending, settings and chat still offer the vault’s lock or unlock, and nothing else', () => {
  const pending = (locked: boolean): SecretSettingsView => ({ status: { initialized: true, locked }, peers: [], secrets: [], workerUpdatePending: true });
  const locked = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: pending(true), canvas, busy: false, change }));
  assert.match(locked, /새 실행 워커 적용 대기 중입니다/); assert.match(locked, /type="password"/); assert.doesNotMatch(locked, /시크릿 추가|등록한 시크릿이 없습니다|고급/);
  const open = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: pending(false), canvas, busy: false, change }));
  assert.match(open, /잠그기/); assert.doesNotMatch(open, /type="password"|시크릿 추가|등록한 시크릿이 없습니다/);
  const none = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: { ...pending(false), status: { initialized: false, locked: true } }, canvas, busy: false, change }));
  assert.doesNotMatch(none, /type="password"|잠그기/, 'a vault is never set up through an older worker');
  const chat = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ error: 'worker-update-pending', status: { initialized: true, locked: true }, available: [], connectable: [] }), busy: false, change, onPaste: noop, onSharing: noop }));
  assert.match(chat, /새 실행 워커 적용 대기/); assert.match(chat, /type="password"/);
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

test('a locked vault shows the Tower password, it with the recovery password and why, or the vault password, in settings and the chat', () => {
  const status = (towerPassword?: 'ready' | 'missing') => ({ initialized: true, locked: true, ...(towerPassword ? { towerPassword } : {}) });
  const render = (towerPassword?: 'ready' | 'missing') => renderToStaticMarkup(createElement(SecretAccess, { status: status(towerPassword), busy: false, change }));
  const fields = (markup: string) => markup.match(/type="password"/g)?.length ?? 0;
  const ready = render('ready');
  assert.equal(fields(ready), 1); assert.match(ready, /<label>Tower 비밀번호<input type="password"/); assert.match(ready, /Tower에 로그인하는 비밀번호로/);
  assert.match(ready, /class="secret-unlock-switch"[^>]*>복구 비밀번호로 열기</); assert.doesNotMatch(ready, /기존 보관함 비밀번호/);
  const missing = render('missing');
  assert.equal(fields(missing), 2); assert.match(missing, /<label>Tower 비밀번호<input/); assert.match(missing, /<label>복구 비밀번호\(기존 보관함 비밀번호\)<input type="password" autoComplete="off"/);
  assert.match(missing, /아직 이 Tower 비밀번호와 연결되지 않았습니다/); assert.match(missing, />복구 비밀번호로 열기</);
  const vault = render();
  assert.equal(fields(vault), 1); assert.match(vault, /보관함 비밀번호를 입력하세요/); assert.doesNotMatch(vault, /Tower|복구 비밀번호|secret-unlock-switch/, 'without Tower-password support nothing changes');
  const chat = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ error: 'locked', status: status('missing'), available: [] }), busy: false, change, onPaste: noop, onSharing: noop }));
  assert.equal(fields(chat), 2); assert.match(chat, /복구 비밀번호로 열기/);
  const paste = renderToStaticMarkup(createElement(SecretPaste, { view: sessionView({ error: 'locked', status: status('ready') }), sessionId: 's', busy: false, change, onConnected: noop }));
  assert.match(paste, /<label>Tower 비밀번호<input type="password"/); assert.match(paste, />복구 비밀번호로 열기</);
  setLanguage('en');
  const english = render('missing').replace(/<[^>]*>/g, ' ');
  assert.match(english, /Tower password/); assert.match(english, /Recovery password \(the earlier vault password\)/); assert.match(english, /Open with the recovery password/);
  assert.doesNotMatch(english, /[가-힣]/);
});

test('the unlock request follows the mode: the Tower password turns on value viewing, the recovery password alone only opens the vault', () => {
  assert.equal(unlockMode(undefined, { recovery: true, asked: true }), 'vault');
  assert.equal(unlockMode('ready', {}), 'tower'); assert.equal(unlockMode('ready', { asked: true }), 'both'); assert.equal(unlockMode('missing', {}), 'both');
  assert.equal(unlockMode('ready', { recovery: true }), 'recovery'); assert.equal(unlockMode('missing', { recovery: true, asked: true }), 'recovery');
  assert.deepEqual(unlockRequest('tower', 'T', 'R'), ['view-unlock', { password: 'T' }]);
  assert.deepEqual(unlockRequest('both', 'T', 'R'), ['view-unlock', { password: 'T', recoveryPassword: 'R' }]);
  assert.deepEqual(unlockRequest('recovery', 'R', ''), ['unlock', { password: 'R' }]); assert.deepEqual(unlockRequest('vault', 'V', ''), ['unlock', { password: 'V' }]);
  const t = (key: string) => key;
  assert.equal(secretFailure(new ApiError('Login required', 401, undefined, 'login-required'), t), 'Tower 비밀번호가 맞지 않습니다.');
  assert.equal(secretFailure(new ApiError('로컬 계정 관리에서 Tower 계정을 먼저 설정하세요.', 409, undefined, 'account-required'), t), '로컬 계정 관리에서 Tower 계정을 먼저 설정하세요.');
});

const base64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64');
const textValue = (patch: Partial<SecretValue>): SecretValue => ({ id: 'folder_key', version: 4, kind: 'scalar', ...patch });

test('each row’s value is masked with show and edit, and value viewing adds one lock to the header', () => {
  const closed = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view, canvas, busy: false, change }));
  assert.equal(closed.match(/>보기</g)?.length, view.secrets.length); assert.equal(closed.match(/>수정</g)?.length, view.secrets.length);
  assert.doesNotMatch(closed, /값 보기 잠그기/, 'nothing to lock before value viewing is on');
  const open = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: { ...view, valueView: true }, canvas, busy: false, change }));
  assert.equal(open.match(/>값 보기 잠그기</g)?.length, 1); assert.ok(open.indexOf('값 보기 잠그기') < open.indexOf('class="secret-list"'), 'in the list header');
  assert.doesNotMatch(open, /secret-value-panel|<pre/, 'masked until the owner asks');
});

test('a shown value is text in a read-only block; a file shows its size, a short UTF-8 preview and saving', () => {
  const scalar = renderToStaticMarkup(createElement(SecretValueShown, { name: 'API_KEY', value: textValue({ value: 'FAKE <value>\nsecond line' }) }));
  assert.match(scalar, /<pre class="secret-value-text" role="region" tabindex="0" aria-label="API_KEY 값">FAKE &lt;value&gt;\nsecond line<\/pre>/); assert.doesNotMatch(scalar, /<textarea|<input/, 'read-only');
  const env = renderToStaticMarkup(createElement(SecretValueShown, { name: 'APP_ENV', value: textValue({ kind: 'env', content: base64('A=FAKE_ONE\nB=FAKE_TWO') }) }));
  assert.match(env, /<pre[^>]*>A=FAKE_ONE\nB=FAKE_TWO<\/pre>/, 'an uploaded .env reads as its text');
  const text = renderToStaticMarkup(createElement(SecretValueShown, { name: 'key.pem', value: textValue({ kind: 'file', content: base64('-----BEGIN FAKE-----\n') }) }));
  assert.match(text, /파일 · 21 B/); assert.match(text, /<pre[^>]*>-----BEGIN FAKE-----\n<\/pre>/); assert.match(text, />파일로 저장</);
  const binary = renderToStaticMarkup(createElement(SecretValueShown, { name: 'blob.bin', value: textValue({ kind: 'file', content: base64(new Uint8Array([0xff, 0xfe, 0x00, 0x41])) }) }));
  assert.match(binary, /파일 · 4 B/); assert.doesNotMatch(binary, /<pre/); assert.match(binary, /미리 볼 수 없습니다/); assert.match(binary, />파일로 저장</);
  const large = renderToStaticMarkup(createElement(SecretValueShown, { name: 'big.txt', value: textValue({ kind: 'file', content: base64('a'.repeat(64 * 1024 + 1)) }) }));
  assert.match(large, /파일 · 64\.0 KiB/); assert.doesNotMatch(large, /<pre/);
});

test('a file previews as text only when it is valid UTF-8 without NUL bytes and at most 64 KiB', () => {
  assert.deepEqual(filePreview(base64('héllo')), { size: 6, text: 'héllo' });
  assert.deepEqual(filePreview(base64('a'.repeat(64 * 1024))), { size: 64 * 1024, text: 'a'.repeat(64 * 1024) });
  assert.deepEqual(filePreview(base64('a'.repeat(64 * 1024 + 1))), { size: 64 * 1024 + 1 });
  assert.deepEqual(filePreview(base64(new Uint8Array([0xc3, 0x28]))), { size: 2 }, 'invalid UTF-8');
  assert.deepEqual(filePreview(base64('a\0b')), { size: 3 }, 'NUL bytes are binary');
  assert.deepEqual(filePreview(''), { size: 0, text: '' });
  assert.equal(fileSize(1023), '1023 B'); assert.equal(fileSize(1536), '1.5 KiB'); assert.equal(fileSize(1024 * 1024), '1.0 MiB');
  assert.equal(valueText(textValue({ value: 'plain', content: base64('ignored') })), 'plain');
});

test('an opened row asks for the Tower password while value viewing is off, then shows the value; editing has its own form', () => {
  const secret = view.secrets[0]!;
  const prompt = renderToStaticMarkup(createElement(SecretValuePanel, { secret, slot: { id: secret.id, edit: false }, valueView: false, busy: false, onUnlock: async () => {}, onClose: noop }));
  assert.match(prompt, /<form class="secret-form secret-value-panel" aria-label="GLOBAL_KEY 값 보기">/); assert.match(prompt, /<label>Tower 비밀번호<input type="password" autofocus="" autoComplete="current-password"/);
  assert.match(prompt, /disabled="">확인</, 'nothing to send before the password is typed');
  const loading = renderToStaticMarkup(createElement(SecretValuePanel, { secret, slot: { id: secret.id, edit: false, loading: true }, valueView: true, busy: false, onUnlock: async () => {}, onClose: noop }));
  assert.match(loading, /불러오는 중…/);
  const shown = renderToStaticMarkup(createElement(SecretValuePanel, { secret, slot: { id: secret.id, edit: false, value: textValue({ value: 'FAKE_SHOWN' }) }, valueView: true, busy: false, onUnlock: async () => {}, onClose: noop }));
  assert.match(shown, /<pre[^>]*>FAKE_SHOWN<\/pre>/);
  assert.equal(renderToStaticMarkup(createElement(SecretValuePanel, { secret, slot: { id: secret.id, edit: true, value: textValue({ value: 'FAKE_SHOWN' }) }, valueView: true, busy: false, onUnlock: async () => {}, onClose: noop })), '');
  const form = renderToStaticMarkup(createElement(SecretValueForm, { secret, value: textValue({ value: 'FAKE_CURRENT' }), busy: false, change, onClose: noop }));
  assert.match(form, /시크릿 값 수정 · GLOBAL_KEY/); assert.match(form, /<textarea[^>]*>FAKE_CURRENT<\/textarea>/, 'prefilled with the current value'); assert.match(form, /class="secret-save" disabled="">저장</, 'nothing to save until it changes');
  const file = renderToStaticMarkup(createElement(SecretValueForm, { secret: { ...secret, kind: 'file' }, value: textValue({ kind: 'file', content: base64('FAKE_FILE') }), busy: false, change, onClose: noop }));
  assert.match(file, /현재 파일 · 9 B/); assert.match(file, /<label>새 파일 선택<input autofocus="" type="file"/); assert.doesNotMatch(file, /FAKE_FILE|<textarea/); assert.match(file, /disabled="">저장</);
  setLanguage('en');
  const english = [renderToStaticMarkup(createElement(SecretValuePanel, { secret, slot: { id: secret.id, edit: false }, valueView: false, busy: false, onUnlock: async () => {}, onClose: noop })),
    renderToStaticMarkup(createElement(SecretValueShown, { name: 'blob.bin', value: textValue({ kind: 'file', content: base64(new Uint8Array([0xff])) }) })),
    renderToStaticMarkup(createElement(SecretValueForm, { secret: { ...secret, kind: 'file' }, value: textValue({ kind: 'file', content: '' }), busy: false, change, onClose: noop })),
    renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: { ...view, valueView: true }, canvas, busy: false, change }))];
  for (const markup of english) assert.doesNotMatch(markup.replace(/<[^>]*>/g, ' ').replace(/원본 맥|빌드 서버|상위 Tower/g, ''), /[가-힣]/);
  assert.match(english[0]!, /Enter your Tower password to view or edit values/); assert.match(english[1]!, /Save as file/); assert.match(english[3]!, /Lock value viewing/);
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
  const settings = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view, canvas, busy: false, change }));
  assert.match(settings, /Edit sharing/); assert.match(settings, /aria-label="Show value of FOLDER_KEY"[^>]*>View</); assert.match(settings, /aria-label="Edit value of FOLDER_KEY"[^>]*>Edit</); assert.match(settings, /Not shared/); assert.match(settings, /Earlier rules/); assert.match(settings, /Add secret/); assert.match(settings, /FOLDER_KEY/);
  const available = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ error: 'worker-update-pending' }), busy: false, change, onPaste: noop, onSharing: noop }));
  assert.match(available, /Waiting for the new execution worker/); assert.doesNotMatch(available, /Connect a saved secret/, 'nothing can change until the handoff');
  const usable = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView(), busy: false, change, onPaste: noop, onSharing: noop }));
  assert.match(usable, /Connect a saved secret/); assert.match(usable, /This session/);
  const visible = (markup: string) => markup.replace(/<[^>]*>/g, ' ');
  const pending = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: { status: { initialized: true, locked: false }, peers: [], secrets: [], workerUpdatePending: true }, canvas, busy: false, change }));
  const stopped = renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView({ disconnected: [{ id: 'x', name: 'X_KEY', groupId: 'g', kind: 'scalar', version: 1, reference: reference('x'), remote: true }] }), busy: false, change, onPaste: noop, onSharing: noop }));
  assert.match(pending, /only lock and unlock/); assert.match(stopped, /Allow again/);
  for (const markup of [settings, available, usable, pending, stopped]) assert.doesNotMatch(visible(markup).replace(/원본 맥|빌드 서버|상위 Tower/g, ''), /[가-힣]/, 'every control is translated; computer names stay as they are');
});

test('pending encrypted vault restores remain waiting and direct the owner to Secrets settings', async () => {
  const { RestoreStatus } = await import('../../../client/src/backup/BackupPanel.js');
  const report = { id: 'restore', status: 'waiting-secrets' as const, requestedAt: '2026-10-02', from: 'source', createdAt: '2026-10-02', applied: [], worker: [], errors: [], pendingSecretImports: ['vault-id'] };
  const markup = renderToStaticMarkup(createElement(RestoreStatus, { report, busy: false, onCancel: noop }));
  assert.match(markup, /시크릿 보관함 가져오기를 기다립니다/); assert.match(markup, /원본 보관함 비밀번호/); assert.match(markup, /시크릿 설정 열기/);
  assert.doesNotMatch(markup, /복원을 적용했습니다|복원을 취소했습니다/);
});

test('partial remote source failure is shown as a generic alert without reflecting server error details', () => {
  const markup = renderToStaticMarkup(createElement(SecretSettingsWorkspace, { view: { ...view, status: { ...view.status, error: 'source-private-error-canary' } }, canvas, busy: false, change }));
  assert.match(markup, /role="alert"/); assert.match(markup, /원본 컴퓨터의 연결과 잠금 상태/); assert.doesNotMatch(markup, /source-private-error-canary/);
});

test('sources that could not be reached and sources waiting for an update get separate notices', () => {
  const previous = getLanguage(); setLanguage('ko');
  try {
    const render = (patch: Partial<SecretSessionView>) => renderToStaticMarkup(createElement(SecretAvailable, { view: sessionView(patch), busy: false, change, onPaste: noop, onSharing: noop }));
    const both = render({ unavailableSources: ['offline-device'], updatePendingSources: ['older-device', 'another-older-device'] });
    assert.match(both, /원본 컴퓨터 1곳에 연결하지 못해 그곳의 시크릿은 빠져 있습니다/);
    assert.match(both, /원본 컴퓨터 2곳이 업데이트를 기다리고 있어 그 시크릿은 아직 표시하지 않습니다/);
    const older = render({ updatePendingSources: ['older-device'] });
    assert.match(older, /원본 컴퓨터 1곳이 업데이트를 기다리고/); assert.doesNotMatch(older, /연결하지 못해/, 'an older source is not a connection failure');
    const offline = render({ unavailableSources: ['offline-device'] });
    assert.match(offline, /연결하지 못해/); assert.doesNotMatch(offline, /업데이트를 기다리고/);
    setLanguage('en');
    assert.match(render({ updatePendingSources: ['older-device'] }), /1 source computer\(s\) are waiting for an update; their secrets are not shown yet\./);
  } finally { setLanguage(previous); }
});
