import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import { isAbsolute } from 'node:path';
import { readJson, errorStatus } from '../http/requests.js';
import type { SecretPeer, SecretSessionView, SecretSettingsItem, SecretSettingsView, SecretTarget, VaultStatus } from '../../shared/secrets.js';
import { REMOTE_SECRET_MAX_RESPONSE_BYTES } from '../secrets/remote.js';
import { canonicalFolders, realFolder, SECRET_EXCLUSIONS_FEATURE, SECRET_SHARING_FEATURE, type FolderSources } from '../secrets/folders.js';
import { ownerConnection, ownerCreate, ownerInput, ownerSession } from '../secrets/owner-input.js';
import type { SecretReceipt } from '../secrets/runtime.js';
import type { RunnerCapability } from '../runs/runner-protocol.js';
import type { RemoteNodes } from './nodes.js';
import type { NodeLink } from './secret-follow.js';
import { linkRequest } from './transport.js';
import { z } from 'zod';
import { TowerError, type ErrorKind } from '../../shared/errors.js';

interface Worker { secretCall(operation: string, args?: unknown[]): Promise<unknown>; supports(capability: RunnerCapability): boolean }
const fail = (message: string, kind: ErrorKind = 'forbidden') => new TowerError(kind, message);
/** Sent by a controller's relay on its poll: the remote operations its worker serves (`available`). */
export const SECRET_FEATURES_HEADER = 'x-tower-secret-features';

/** What a controller's relay may say on its poll (`RemoteSecretFeature`). */
const RELAY_FEATURES = ['available', 'catalog', 'locked'];

/**
 * Paired TLS callers can relay envelopes, ask for a verified task and canonicalize this computer's folders, never manage
 * the Vault. `excluded` names folders this computer keeps from its controllers. `follows` tells whether this computer
 * follows that controller, which alone may align secret trust with it (`/secret-align`), before any trust exists.
 */
export async function handleSecretLink(req: Http2ServerRequest, res: Http2ServerResponse, controllerId: string, worker: Worker, options: { excluded?: (path: string) => Promise<boolean>; follows?: (controllerId: string) => Promise<boolean> } = {}): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'https://tower.invalid');
  if (!['/secret-relay', '/secret-target', '/secret-device', '/secret-connection-notice', '/secret-folder', '/secret-session', '/secret-align'].includes(url.pathname)) return false;
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    if (url.pathname === '/secret-align') {
      if (req.method !== 'POST' || !worker.supports('secretMachines') || !await options.follows?.(controllerId)) throw fail('이 컴퓨터는 그 Tower의 설정을 따르지 않습니다.');
      const body = await readJson(req as unknown as IncomingMessage, 32 * 1024) as { device?: unknown };
      reply(200, await worker.secretCall('align', [{ routeId: controllerId, direction: 'controller', ...(body.device !== undefined ? { device: body.device } : {}) }]));
      return true;
    }
    const peers = await worker.secretCall('peers') as SecretPeer[];
    if (!peers.some(peer => peer.enabled && peer.direction === 'controller' && peer.routeId === controllerId)) throw fail('이 컴퓨터에 시크릿 공유를 승인하지 않았습니다.');
    if (url.pathname === '/secret-relay' && req.method === 'GET') {
      // What the controller's worker serves, as its relay says; this worker sends reads only to a source confirmed so.
      const header = req.headers[SECRET_FEATURES_HEADER];
      const features = typeof header === 'string' ? header.split(',').map(item => item.trim()).filter(item => RELAY_FEATURES.includes(item)) : [];
      reply(200, await worker.secretCall('poll', [controllerId, features]));
    }
    else if (url.pathname === '/secret-relay' && req.method === 'POST') {
      const body = await readJson(req as unknown as IncomingMessage, REMOTE_SECRET_MAX_RESPONSE_BYTES + 1024) as { response?: unknown };
      reply(200, await worker.secretCall('deliver', [controllerId, body.response]));
    } else if (url.pathname === '/secret-connection-notice' && req.method === 'POST') {
      // `secretIds`: the keys connected, whose stop in this session ends (sent only to a computer advertising `secretExclusions`).
      const input = z.object({ sessionId: z.string().min(1).max(1024), taskId: z.string().uuid(), secretIds: z.array(z.string().min(1).max(256)).max(4096).optional() }).strict().parse(await readJson(req as unknown as IncomingMessage, 1024 * 1024));
      reply(200, await worker.secretCall('connection-notice', [input.sessionId, input.taskId, ...(input.secretIds ? [input.secretIds] : [])]));
    } else if (url.pathname === '/secret-device' && req.method === 'GET') reply(200, await worker.secretCall('device'));
    else if (url.pathname === '/secret-folder' && req.method === 'GET') {
      // Only the real path of an existing folder: no listing, and a folder kept from controllers is not found.
      const path = url.searchParams.get('path');
      if (!path || await options.excluded?.(path)) reply(404, { error: '폴더를 찾을 수 없습니다.' });
      else reply(200, { root: await realFolder(path) });
    }
    else if (url.pathname === '/secret-session' && req.method === 'GET' && url.searchParams.get('sessionId')) {
      if (!worker.supports('secretSharing')) throw fail('실행 워커가 아직 새 버전으로 바뀌지 않았습니다.', 'unavailable');
      // `exclusions=1`: the controller reads them; an older one refuses a subject with fields it does not know.
      reply(200, await worker.secretCall('session-subject', [url.searchParams.get('sessionId'), url.searchParams.get('exclusions') === '1']));
    }
    else if (url.pathname === '/secret-target' && req.method === 'GET' && url.searchParams.get('sessionId')) { const target = await worker.secretCall('target', [url.searchParams.get('sessionId'), url.searchParams.get('create') !== 'false']); reply(target ? 200 : 204, target); }
    else reply(404, { error: '알 수 없는 시크릿 전달 요청입니다.' });
  } catch (error) { reply(errorStatus(error), { error: '시크릿 전달 요청을 처리할 수 없습니다. 잠금·컴퓨터 승인·연결 상태를 확인하세요.' }); }
  return true;
}

/** A secret request to a joined computer over its link (secret-follow.ts); undefined while it is not connected. */
export function nodeSecretLink(nodes: RemoteNodes | undefined): NodeLink {
  return async (nodeId, path, body) => {
    const link = nodes?.session(nodeId);
    if (!link) return undefined;
    const answer = await linkRequest(link, 'POST', path, body, 8000, { maxBytes: 64 * 1024 });
    return { status: answer.status, json: answer.json };
  };
}

/** Folder canonicalization for the owner's sharing: this worker's vault, and joined computers over their links. */
export function folderSources(nodes: RemoteNodes | undefined, worker: Worker): FolderSources {
  return {
    deviceId: async () => {
      try { return (await worker.secretCall('device') as { id: string }).id; }
      catch { throw fail('시크릿 보관함이 잠겨 있습니다. 잠금을 해제한 뒤 다시 시도하세요.', 'locked'); }
    },
    peers: async () => await worker.secretCall('peers') as SecretPeer[],
    features: node => nodes?.list().find(item => item.id === node && item.status === 'connected')?.features,
    ask: async (node, path) => {
      const link = nodes?.session(node);
      if (!link) throw fail('합류 컴퓨터가 연결되어 있지 않아 폴더를 확인할 수 없습니다. 연결된 뒤 다시 저장하세요.', 'unavailable');
      const answer = await linkRequest(link, 'GET', `/secret-folder?path=${encodeURIComponent(path)}`, undefined, 8000, { maxBytes: 16 * 1024 });
      const root = (answer.json as { root?: unknown } | undefined)?.root;
      if (answer.status === 200 && typeof root === 'string' && isAbsolute(root)) return root;
      if (answer.status === 400 || answer.status === 404) throw fail(`합류 컴퓨터에서 폴더를 찾을 수 없거나 폴더가 아닙니다: ${path}`, 'invalid');
      if (answer.status === 403) throw fail('합류 컴퓨터가 이 컴퓨터를 시크릿용으로 신뢰하지 않았거나 그 컴퓨터의 보관함이 잠겨 있습니다.', 'invalid');
      throw fail('합류 컴퓨터에서 폴더를 확인하지 못했습니다. 잠시 후 다시 저장하세요.', 'unavailable');
    },
  };
}

/** A joined computer's session the owner changes: its task there, started if needed, under the peer trusted on that link. */
export async function ownerRemoteTarget(nodes: RemoteNodes | undefined, worker: Worker, input: Record<string, unknown>): Promise<SecretTarget> {
  if (!nodes || typeof input.nodeId !== 'string' || typeof input.sessionId !== 'string') throw fail('원격 프로젝트 세션을 선택하세요.', 'invalid');
  const peer = (await worker.secretCall('peers') as SecretPeer[]).find(item => item.enabled && item.direction === 'node' && item.routeId === input.nodeId);
  const link = nodes.session(input.nodeId);
  if (!peer || !link) throw fail('원격 컴퓨터의 시크릿 승인과 연결이 필요합니다.', 'unavailable');
  const response = await linkRequest(link, 'GET', `/secret-target?sessionId=${encodeURIComponent(input.sessionId)}&create=true`, undefined, 8000, { maxBytes: 32 * 1024 });
  const target = response.json as SecretTarget;
  if (response.status !== 200 || !target || target.hostId !== peer.device.id || typeof target.taskId !== 'string' || typeof target.root !== 'string' || target.sessionId !== input.sessionId) throw fail('원격 세션의 시크릿 작업을 확인할 수 없습니다.', 'unavailable');
  return target;
}

/**
 * What a joined computer reports about its session for the owner's view (`RemoteSessionSubject`), or why it cannot.
 * Only a computer that advertises `secretSharing` is asked, and it only reads: no task starts on either computer.
 */
async function remoteSessionSubject(nodes: RemoteNodes | undefined, worker: Worker, input: Record<string, unknown>): Promise<unknown> {
  if (!nodes || typeof input.nodeId !== 'string' || typeof input.sessionId !== 'string') throw fail('원격 프로젝트 세션을 선택하세요.', 'invalid');
  const peer = (await worker.secretCall('peers') as SecretPeer[]).find(item => item.enabled && item.direction === 'node' && item.routeId === input.nodeId);
  if (!peer) return { error: 'not-eligible' };
  const node = nodes.list().find(item => item.id === input.nodeId && item.status === 'connected'); const link = nodes.session(input.nodeId);
  if (!node || !link) return { error: 'source-unavailable' };
  if (!node.features.includes(SECRET_SHARING_FEATURE)) return { error: 'worker-update-pending' };
  const exclusions = worker.supports('secretExclusions') ? '&exclusions=1' : '';
  // best-effort: a computer that does not answer is shown as unavailable, and the page asks again.
  const response = await linkRequest(link, 'GET', `/secret-session?sessionId=${encodeURIComponent(input.sessionId)}${exclusions}`, undefined, 8000, { maxBytes: 1024 * 1024 }).catch(() => undefined);
  const subject = response?.json as { hostId?: unknown; error?: unknown } | undefined;
  if (response?.status === 404) return { error: 'session-closed' };
  if (response?.status !== 200 || !subject || typeof subject !== 'object') return { error: 'source-unavailable' };
  return subject.error !== undefined || subject.hostId === peer.device.id ? subject : { error: 'source-unavailable' };
}

/** Owner changes of one session; for a joined computer's session they start its task there and are viewed from it. */
const SESSION_CHANGES = ['create', 'session-connect', 'session-disconnect'];
/** Value viewing and the Tower password's wrappers of the vault key, which a worker with `secretValueView` serves. */
const VALUE_VIEW_ACTIONS = ['view-unlock', 'value', 'value-update', 'tower-status', 'tower-wrap', 'tower-prune'];
export const WORKER_UPDATE_PENDING = 'worker-update-pending';
/** The attached worker predates per-secret sharing (`secretSharing`): nothing new is sent to it. */
const workerUpdatePending = () => Object.assign(new TowerError('unavailable', '새 실행 워커 적용 대기: 진행 중인 작업이 끝나 실행 워커가 바뀌면 시크릿을 관리할 수 있습니다.'), { code: WORKER_UPDATE_PENDING });

/**
 * The page's folder keys as canonical folders, in `sharing` and in a created secret's `sharing`. A folder sent back as
 * an identity goes to the worker as `kept`, for the service to accept only where that key keeps it; a new key keeps none.
 */
async function canonicalInput(nodes: RemoteNodes | undefined, worker: Worker, action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (action === 'sharing') { const { folders, kept } = await canonicalFolders(input.folders, folderSources(nodes, worker)); return { ...input, folders, kept }; }
  if (action !== 'create' || input.sharing === undefined) return input;
  const sharing = input.sharing;
  if (!sharing || typeof sharing !== 'object' || Array.isArray(sharing)) throw fail('공유 범위 입력이 올바르지 않습니다.', 'invalid');
  const { folders, kept } = await canonicalFolders((sharing as Record<string, unknown>).folders, folderSources(nodes, worker));
  if (kept.length) throw fail('새 키의 폴더는 캔버스에서 고르세요.', 'invalid');
  return { ...input, sharing: { ...sharing, folders } };
}

/**
 * The page's sharing for a worker before machine sharing (`secretMachines`), which saves "all machines" as GLOBAL and
 * cannot share with single computers yet.
 */
function olderSharing(sharing: Record<string, unknown>): Record<string, unknown> {
  const { allMachines, machines, ...rest } = sharing;
  if (Array.isArray(machines) && machines.length) throw workerUpdatePending();
  return { ...rest, global: allMachines };
}
/** Such a worker's settings as the page reads them: its GLOBAL is "all machines". */
function machineView(answer: unknown): unknown {
  const view = answer as Partial<SecretSettingsView> | undefined;
  if (!view || typeof view !== 'object' || !Array.isArray(view.secrets)) return answer;
  return { ...view, secrets: view.secrets.map((item: SecretSettingsItem) => {
    const sharing = item.sharing as (SecretSettingsItem['sharing'] & { global?: boolean }) | undefined;
    if (!sharing || typeof sharing.global !== 'boolean') return item;
    const { global, ...rest } = sharing;
    return { ...item, sharing: { ...rest, allMachines: global, machines: [] } };
  }) };
}

/**
 * The owner page's secret actions, sent to the worker only when it serves them. A joined computer's session (`nodeId`)
 * is verified over its link here; a connection made there is announced to it with a fixed notice before the view is read.
 */
export async function ownerSecretControl(nodes: RemoteNodes | undefined, worker: Worker, action: string, input: Record<string, unknown>): Promise<unknown> {
  if (!worker.supports('secretSharing') || worker.supports('secretMachines')) return secretControl(nodes, worker, action, input);
  const older = action === 'sharing' ? olderSharing(input) : action === 'create' && input.sharing && typeof input.sharing === 'object' ? { ...input, sharing: olderSharing(input.sharing as Record<string, unknown>) } : input;
  return machineView(await secretControl(nodes, worker, action, older));
}
async function secretControl(nodes: RemoteNodes | undefined, worker: Worker, action: string, input: Record<string, unknown>): Promise<unknown> {
  if (VALUE_VIEW_ACTIONS.includes(action) && !worker.supports('secretValueView')) throw workerUpdatePending();
  if (!worker.supports('secretSharing')) {
    // Locking and unlocking stay possible during a handoff, so the settings and the session read the vault's status from
    // the older worker's `overview` (which every build before 1.131 serves) to offer them; nothing else is sent to it.
    if (action === 'settings' || action === 'session') {
      const answer = await worker.secretCall('control', ['overview', {}]).catch(() => { throw workerUpdatePending(); }) as { status?: VaultStatus };
      const status = answer.status ?? { initialized: true, locked: true };
      if (action === 'settings') return { status, peers: [], secrets: [], workerUpdatePending: true } satisfies SecretSettingsView;
      return { status, available: [], connectable: [], usage: [], unavailableSources: [], updatePendingSources: [], error: WORKER_UPDATE_PENDING, permanent: false } satisfies SecretSessionView;
    }
    if (action !== 'lock' && action !== 'unlock') throw workerUpdatePending();
    const answer = await worker.secretCall('control', [action, action === 'unlock' ? { password: input.password } : {}]) as { status?: VaultStatus };
    return { status: answer.status ?? { initialized: true, locked: true }, peers: [], secrets: [], workerUpdatePending: true } satisfies SecretSettingsView;
  }
  const { target: _target, hostId: _host, taskId: _task, projectRoot: _root, ...page } = input;
  const remote = page.nodeId !== undefined;
  if (action === 'session') {
    const session = ownerInput(ownerSession, page);
    return worker.secretCall('control', ['session', session, ...(remote ? [await remoteSessionSubject(nodes, worker, session)] : [])]);
  }
  const safe = await canonicalInput(nodes, worker, action, page);
  if (!remote || !SESSION_CHANGES.includes(action)) return worker.secretCall('control', [action, safe]);
  // Validated before the joined computer starts a task for it.
  const { sessionId, nodeId } = ownerInput(action === 'create' ? ownerCreate : ownerConnection, safe) as { sessionId: string; nodeId: string };
  const target = await ownerRemoteTarget(nodes, worker, safe);
  const connected = (await worker.secretCall('control', [action, safe, target]) as Partial<SecretReceipt>).connectedTarget;
  if (!connected || connected.hostId !== target.hostId || connected.sessionId !== target.sessionId || connected.taskId !== target.taskId) throw fail('연결한 원격 작업의 완료 기록을 확인할 수 없습니다.', 'unavailable');
  if (action !== 'session-disconnect') {
    // An uncertain insert is never sent a second time, and cannot undo the committed connection. A computer that reports
    // exclusions also lifts its own stop on the keys connected; the view read next shows whether it did.
    try {
      const link = nodes?.session(nodeId);
      if (!link) throw fail('원격 알림 연결이 종료되었습니다.', 'unavailable');
      const lifts = action === 'session-connect' && nodes?.list().find(item => item.id === nodeId)?.features.includes(SECRET_EXCLUSIONS_FEATURE);
      const secretIds = lifts ? { secretIds: ownerInput(ownerConnection, safe).secretIds } : {};
      const response = await linkRequest(link, 'POST', '/secret-connection-notice', { sessionId: connected.sessionId, taskId: connected.taskId, ...secretIds }, 8000, { maxBytes: 4096 });
      if (response.status !== 200) throw fail('원격 알림을 확인하지 못했습니다.', 'unavailable');
    } catch { console.warn('Tower could not confirm the remote secret-connection notice; credentials remain discoverable when needed.'); }
  }
  return worker.secretCall('control', ['session', { sessionId, nodeId }, await remoteSessionSubject(nodes, worker, { sessionId, nodeId })]);
}
