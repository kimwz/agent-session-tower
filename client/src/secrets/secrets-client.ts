import type {
  SecretFolder, SecretKind, SecretLegacySummary, SecretMetadata, SecretPeer, SecretSessionError, SecretSessionView, SecretSettingsItem,
  SecretSettingsView, SecretSharing, SecretTowerPassword, SecretUsage, SecretValue,
} from '../../../shared/secrets';
import { MAX_SECRET_BYTES } from '../../../shared/secrets';
import { api, ApiError } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { localPart, nodeOf, scopedId } from '../remote/scope';

/** All secret requests go to the source vault, including requests for a joined session. */
export function secretSession(sessionId?: string): { sessionId?: string; nodeId?: string } {
  return sessionId ? { sessionId: localPart(sessionId), ...(nodeOf(sessionId) ? { nodeId: nodeOf(sessionId) } : {}) } : {};
}
export function secretSessionPath(sessionId: string): string {
  return `/api/secrets/session?${new URLSearchParams(secretSession(sessionId) as Record<string, string>)}`;
}
export const readSecretSettings = (signal?: AbortSignal) => api<SecretSettingsView>('/api/secrets/settings', { signal });
/** Read-only: the server never creates a task, connection or ledger entry for it. */
export const readSecretSession = (sessionId: string, signal?: AbortSignal) => api<SecretSessionView>(secretSessionPath(sessionId), { signal });
export const postSecret = <T,>(action: string, token: string, body: unknown) => api<T>(`/api/secrets/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(body) });

/** The owner's value view: one saved value, read only on request and kept in component state alone. */
export const readSecretValue = (token: string, secretId: string, expectedVersion: number) => postSecret<SecretValue>('value', token, { secretId, expectedVersion });

/** The server's 503 for a route the attached execution worker does not support yet. */
export const workerPending = (failure: unknown) => failure instanceof ApiError && failure.code === 'worker-update-pending';
/** The server's 409 for a stale sharing revision or value version: something changed elsewhere since it was read. */
export const staleConflict = (failure: unknown) => failure instanceof ApiError && failure.status === 409;
/** A value read or saved against a version that moved, or a secret removed since: what is stored now is read again. */
export const valueStale = (failure: unknown) => failure instanceof ApiError && (failure.status === 409 || failure.status === 404);
/** Why the server refused, when it says (`needs-recovery`, `view-locked` …). */
export const failureCode = (failure: unknown) => failure instanceof ApiError ? failure.code : undefined;
/** Value viewing ended on the server (a lock, idle expiry, a sign-out): the Tower password is asked for again. */
export const viewLost = (failure: unknown) => failureCode(failure) === 'view-locked' || failureCode(failure) === 'login-required';
export const WORKER_PENDING = '새 실행 워커 적용 대기 중입니다. 진행 중인 작업이 끝나면 다시 시도하세요.';
/** A 401 `login-required` from anything but the Tower-password check: the sign-in ended. */
export const LOGIN_EXPIRED = '로그인이 만료되었습니다. 다시 로그인하세요.';
/** The server names why it refused (a locked vault, a folder it cannot share); anything else keeps the generic hint. `action` is the request's. */
export function secretFailure(failure: unknown, t: (key: string) => string, action?: string): string {
  if (workerPending(failure)) return t(WORKER_PENDING);
  // `view-unlock` answers it for a wrong Tower password; any other request, for a sign-in that expired.
  if (failureCode(failure) === 'login-required' && failure instanceof ApiError && failure.status === 401) return t(action === 'view-unlock' ? 'Tower 비밀번호가 맞지 않습니다.' : LOGIN_EXPIRED);
  if (failure instanceof ApiError && failure.status === 423) return t('시크릿 보관함이 잠겨 있습니다. 잠금을 해제한 뒤 다시 시도하세요.');
  // A 503 names a joined computer that is not connected now.
  if (failure instanceof ApiError && ((failure.status >= 400 && failure.status < 500 && failure.status !== 401) || failure.status === 503) && failure.message) return t(failure.message);
  return t('시크릿 요청을 완료하지 못했습니다. 잠금 상태와 입력을 확인하세요.');
}
export function secretLoadFailure(failure: unknown, t: (key: string) => string): string {
  if (workerPending(failure)) return t(WORKER_PENDING);
  return t('시크릿 보관함을 불러오지 못했습니다.');
}

/** Source identity determines which vault owns a key; only the owning vault edits it. */
export function isRemoteSecret(secret: SecretMetadata, localDeviceId?: string): boolean {
  return !!secret.sourceHostId && secret.sourceHostId !== localDeviceId;
}

/** How each kind is named on screen (translation keys). */
export const kindLabels: Record<SecretKind, string> = { scalar: '단일 값', env: '.env', file: '파일' };
export type QuickSecretFormat = 'auto' | SecretKind;
/** A display hint only; the server validates dotenv syntax and preserves literal values. */
export function quickSecretKind(raw: string, format: QuickSecretFormat): SecretKind {
  if (format !== 'auto') return format;
  const first = raw.replace(/^\uFEFF/, '').split(/\r?\n/).find(line => line.trim() && !line.trimStart().startsWith('#'));
  return first && /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(first.trimStart()) ? 'env' : 'scalar';
}
/** The name used when the owner leaves it empty: the file's name, a dotenv's first variable, or a generic one. */
export function suggestedSecretName(raw: string, kind: SecretKind, fileName = ''): string {
  if (kind === 'file') return fileName || 'SECRET_FILE';
  return (kind === 'env' ? /(?:^|\n)\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw)?.[1] : undefined) || 'SESSION_SECRET';
}
/** A picked file as the canonical base64 the server stores; refuses files over the vault's limit. */
export async function readSecretFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<string> {
  if (file.size > MAX_SECRET_BYTES) throw new RangeError('too large');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * How a locked vault opens: the Tower (login) password; it with the recovery password once, when the vault is not yet
 * linked to the current login (`missing`, or the server answered `needs-recovery`); the recovery (old vault) password
 * alone, when the owner chose it; or, without Tower-password support, the vault password as before.
 */
export type UnlockMode = 'tower' | 'both' | 'recovery' | 'vault';
export function unlockMode(towerPassword: SecretTowerPassword | undefined, choice: { recovery?: boolean; asked?: boolean }): UnlockMode {
  if (!towerPassword) return 'vault';
  if (choice.recovery) return 'recovery';
  return towerPassword === 'missing' || choice.asked ? 'both' : 'tower';
}
/** The request that opens the vault in `mode`: the Tower-password paths also turn on value viewing. */
export function unlockRequest(mode: UnlockMode, password: string, recoveryPassword: string): [action: string, body: Record<string, string>] {
  if (mode === 'tower') return ['view-unlock', { password }];
  if (mode === 'both') return ['view-unlock', { password, recoveryPassword }];
  return ['unlock', { password }];
}
export const unlockReady = (mode: UnlockMode, password: string, recoveryPassword: string) => !!password && (mode !== 'both' || !!recoveryPassword);

/** A file is previewed as text only when it is valid UTF-8 of at most this size. */
export const FILE_PREVIEW_BYTES = 64 * 1024;
export function secretBytes(content: string): Uint8Array<ArrayBuffer> {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
/** UTF-8 text, or undefined for bytes that are not text (invalid UTF-8 or NUL bytes). */
function utf8Text(bytes: Uint8Array): string | undefined {
  // best-effort: undecodable bytes are a binary file, shown by size only.
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return text.includes('\0') ? undefined : text; } catch { return undefined; }
}
/** A file's size and, when it is UTF-8 text of at most 64 KiB, that text. */
export function filePreview(content: string): { size: number; text?: string } {
  const bytes = secretBytes(content);
  const text = bytes.length <= FILE_PREVIEW_BYTES ? utf8Text(bytes) : undefined;
  return text === undefined ? { size: bytes.length } : { size: bytes.length, text };
}
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
/** A text value as the owner reads and edits it; an uploaded .env comes as its original bytes. */
export function valueText(value: SecretValue): string {
  return value.value ?? (value.content === undefined ? '' : utf8Text(secretBytes(value.content)) ?? '');
}
/** Safari can lose a download whose URL is revoked in the same task; a second later is still right after the click. */
const REVOKE_AFTER_MS = 1000;
/** Saves a file value through a Blob URL that lives only until the download has started. */
export function saveSecretFile(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([secretBytes(content)], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/** Folders are sent as canvas keys: a local absolute path, or `@<node>/` followed by that computer's absolute path. */
export interface SharingInput { global: boolean; folders: { cwd: string }[] }
const secretValue = (kind: SecretKind, raw: string) => kind === 'file' ? { content: raw } : { value: raw };

export type PasteDestination = 'session' | 'none' | 'folder' | 'global';
/**
 * The chat paste. By default the value lives only with this session's task; saving keeps it in the vault, shared
 * with nothing, with this session's folder or everywhere. Raw values are added only here, at submission.
 */
export function pastePayload(input: { raw: string; format: QuickSecretFormat; name: string; fileName?: string; destination: PasteDestination; sessionId: string; cwd?: string }) {
  const kind = quickSecretKind(input.raw, input.format);
  const sharing: SharingInput | undefined = input.destination === 'global' ? { global: true, folders: [] }
    : input.destination === 'folder' && input.cwd ? { global: false, folders: [{ cwd: input.cwd }] } : undefined;
  return { name: input.name.trim() || suggestedSecretName(input.raw, kind, input.fileName), kind, ...secretValue(kind, input.raw), connect: 'session' as const,
    ...(input.destination === 'session' ? { temporary: true } : {}), ...(sharing ? { sharing } : {}), ...secretSession(input.sessionId) };
}
/** A secret added in the settings: saved with the chosen sharing, unshared when none is chosen. */
export function addPayload(input: { raw: string; format: QuickSecretFormat; name: string; fileName?: string; global: boolean; keys: string[] }) {
  const kind = quickSecretKind(input.raw, input.format);
  return { name: input.name.trim() || suggestedSecretName(input.raw, kind, input.fileName), kind, ...secretValue(kind, input.raw),
    ...(input.global || input.keys.length ? { sharing: { global: input.global, folders: input.keys.map(cwd => ({ cwd })) } } : {}) };
}

/** A canvas folder the sharing editor offers: its key, the canvas's label for it, and the computer it is on. */
export interface SecretFolderChoice { key: string; label: string; computer: string }
/** A computer of the canvas: this one without `node`, a joined one with it. */
export interface SecretCanvasHost { node?: string; name: string }
/** The canvas as secret sharing sees it: every folder of every computer, and every computer's name. */
export interface SecretCanvas { folders: readonly SecretFolderChoice[]; hosts: readonly SecretCanvasHost[] }
export const emptyCanvas: SecretCanvas = { folders: [], hosts: [] };
/** Every canvas folder of every computer (`projectGroupChoices` across hosts), named with its computer. */
export function secretFolderChoices(projects: readonly (readonly [string, string])[], hosts: readonly { node?: string; name: string }[]): SecretFolderChoice[] {
  return projects.map(([key, label]) => ({ key, label, computer: hosts.find(host => host.node === nodeOf(key))?.name ?? '' }));
}

type SecretHosts = Pick<SecretSettingsView, 'device' | 'peers'>;
/** Folders live on this computer or on a joined computer this vault trusts as a node. */
const nodePeer = (view: SecretHosts, match: (peer: SecretPeer) => boolean) => view.peers.find(peer => peer.direction === 'node' && match(peer));
/** `{hostId, root}` → the canvas key of that folder; undefined for a computer this vault does not know. */
export function folderKey(view: SecretHosts, folder: SecretFolder): string | undefined {
  if (view.device && folder.hostId === view.device.id) return folder.root;
  const peer = nodePeer(view, peer => peer.device.id === folder.hostId);
  return peer ? scopedId(peer.routeId, folder.root) : undefined;
}
/** A canvas key → `{hostId, root}`; undefined on a joined computer not trusted for secrets. */
export function folderIdentity(view: SecretHosts, key: string): SecretFolder | undefined {
  const node = nodeOf(key);
  if (!node) return view.device ? { hostId: view.device.id, root: key } : undefined;
  const peer = nodePeer(view, peer => peer.routeId === node);
  return peer ? { hostId: peer.device.id, root: localPart(key) } : undefined;
}
const lastSegment = (path: string) => path.split('/').filter(Boolean).at(-1) || path;
/**
 * A vault host's name as the canvas shows it, so one computer reads the same in every list; the vault's own device
 * name only for a computer the canvas does not know.
 */
export function computerName(view: SecretHosts, hostId: string, hosts: readonly SecretCanvasHost[]): string | undefined {
  if (view.device?.id === hostId) return hosts.find(host => !host.node)?.name || view.device.name;
  const peer = view.peers.find(candidate => candidate.device.id === hostId);
  return peer && peerName(peer, hosts);
}
export function peerName(peer: SecretPeer, hosts: readonly SecretCanvasHost[]): string {
  return (peer.direction === 'node' && hosts.find(host => host.node === peer.routeId)?.name) || peer.device.name;
}
/** A folder as the owner reads it: the canvas label, its path and its computer; no `key` when it cannot be saved again. */
export interface FolderView { key?: string; label: string; root: string; computer: string }
export function describeFolder(view: SecretHosts, folder: SecretFolder, canvas: SecretCanvas): FolderView {
  const key = folderKey(view, folder);
  const choice = key ? canvas.folders.find(item => item.key === key) : undefined;
  return { ...(key ? { key } : {}), label: choice?.label || lastSegment(folder.root), root: folder.root, computer: computerName(view, folder.hostId, canvas.hosts) || choice?.computer || folder.hostId };
}
export function describeChoice(choice: SecretFolderChoice): FolderView {
  return { key: choice.key, label: choice.label, root: localPart(choice.key), computer: choice.computer };
}
/** A chosen canvas key as the canvas lists it, or from its path once the canvas no longer does. */
export function describeKey(view: SecretHosts, key: string, canvas: SecretCanvas): { folder: FolderView; listed: boolean } {
  const choice = canvas.folders.find(item => item.key === key);
  if (choice) return { folder: describeChoice(choice), listed: true };
  const identity = folderIdentity(view, key);
  const computer = canvas.hosts.find(host => host.node === nodeOf(key))?.name ?? '';
  return { folder: identity ? describeFolder(view, identity, canvas) : { key, label: lastSegment(localPart(key)), root: localPart(key), computer }, listed: false };
}

/** What a settings row shows of a secret's sharing; the server decides what it allows. */
export interface SharingSummary {
  legacy: boolean;
  /** Its sharing waits for the owner to save it again; nothing is shared automatically until then. */
  withheld: boolean;
  global: boolean;
  /** For a legacy secret, the computers its rules shared it everywhere on. */
  globalComputers: string[];
  folders: FolderView[];
  /** Its rules also limit operations, fields or time. */
  limited: boolean;
}
export function sharingSummary(view: SecretHosts, item: SecretSettingsItem, canvas: SecretCanvas): SharingSummary {
  const legacy: SecretLegacySummary | undefined = item.sharing ? undefined : item.legacy;
  const sharing: Pick<SecretSharing, 'global' | 'folders'> = item.sharing ?? { global: !!legacy?.global.length, folders: legacy?.folders ?? [] };
  return { legacy: !!legacy, withheld: !!item.withheld, global: sharing.global, globalComputers: legacy?.global.map(host => computerName(view, host.hostId, canvas.hosts) || host.hostId) ?? [],
    folders: sharing.folders.map(folder => describeFolder(view, folder, canvas)), limited: !!legacy?.limited };
}

/**
 * The sharing editor's state: GLOBAL, the chosen canvas keys, stored folders of a computer this vault no longer trusts
 * (kept as `{hostId, root}` until removed), and a legacy secret's folders on such a computer, which saving drops.
 */
export interface SharingDraft { global: boolean; keys: string[]; kept: SecretFolder[]; dropped: FolderView[] }
/** Starts from the stored sharing, or for a legacy secret from what its rules share. */
export function sharingDraft(view: SecretHosts, item: SecretSettingsItem, canvas: SecretCanvas): SharingDraft {
  const summary = sharingSummary(view, item, canvas);
  const stored = item.sharing ? item.sharing.folders : item.legacy?.folders ?? [];
  const unknown = stored.filter(folder => !folderKey(view, folder));
  return { global: summary.global, keys: [...new Set(summary.folders.flatMap(folder => folder.key ? [folder.key] : []))],
    kept: item.sharing ? unknown.map(({ hostId, root }) => ({ hostId, root })) : [], dropped: item.sharing ? [] : unknown.map(folder => describeFolder(view, folder, canvas)) };
}
/**
 * Saving replaces the sharing with what the editor shows; a legacy secret has revision 0. A folder already in the
 * stored sharing goes back as the `{hostId, root}` it was received as, so the server keeps it without resolving it
 * again (its computer may be offline, the folder gone); only newly picked folders, and every folder of a legacy
 * secret, are sent as canvas keys to be resolved.
 */
export function sharingPayload(view: SecretHosts, item: SecretSettingsItem, draft: Pick<SharingDraft, 'global' | 'keys' | 'kept'>) {
  const saved = new Map((item.sharing?.folders ?? []).flatMap(folder => { const key = folderKey(view, folder); return key ? [[key, folder] as const] : []; }));
  const pair = ({ hostId, root }: SecretFolder) => ({ hostId, root });
  return { secretId: item.id, revision: item.sharing?.revision ?? 0, global: draft.global,
    folders: [...draft.keys.map(key => { const folder = saved.get(key); return folder ? pair(folder) : { cwd: key }; }), ...draft.kept.map(pair)] };
}
export function folderMatches(folder: FolderView, query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  return !term || `${folder.label} ${folder.root} ${folder.computer}`.toLocaleLowerCase().includes(term);
}
export function secretMatches(secret: SecretMetadata, query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  return !term || [secret.name, ...secret.fields ?? []].join(' ').toLocaleLowerCase().includes(term);
}

/** The secrets this session actually used (owner decision D2), newest first, once each. */
export function usedSecrets(usage: readonly SecretUsage[]): SecretUsage[] {
  const seen = new Set<string>();
  return usage.filter(use => {
    if (seen.has(use.secretId)) return false;
    seen.add(use.secretId);
    return true;
  });
}
/** Session states in which nothing can be connected from the chat until something changes elsewhere. */
export function sessionBlocked(error: SecretSessionError | undefined): boolean {
  return error === 'not-eligible' || error === 'session-closed' || error === 'worker-update-pending';
}

export const OPEN_POLL_MS = 10_000;
export const CLOSED_POLL_MS = 60_000;
/** The wait before the next read; none after a permanent state until the dialog opens again or the window regains focus. */
export function pollDelay(view: Pick<SecretSessionView, 'permanent'> | undefined, open: boolean): number | undefined {
  if (view?.permanent) return undefined;
  return open ? OPEN_POLL_MS : CLOSED_POLL_MS;
}
