import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { SecretFolder, SecretPeer } from '../../shared/secrets.js';
import { TowerError } from '../../shared/errors.js';

/** Link feature of a joined computer that answers folder questions and remote availability. */
export const SECRET_SHARING_FEATURE = 'secretSharing';
/** A joined computer's folder as the page keys it: `@<node>/<its own absolute path>`. */
const SCOPED = /^@([a-f0-9]{32})\/([\s\S]+)$/;
const MAX_FOLDERS = 100;

/** What canonicalizing a page's folders reads: this vault, its peers, and the joined computers over their links. */
export interface FolderSources {
  deviceId(): Promise<string>;
  peers(): Promise<SecretPeer[]>;
  /** A connected joined computer's link features; undefined while it is not connected. */
  features(node: string): string[] | undefined;
  /** That computer's real path of one of its folders; throws a TowerError when it is none. */
  ask(node: string, path: string): Promise<string>;
}

const invalid = (message: string) => new TowerError('invalid', message);
const pathLike = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');

/** The real path of a folder on this computer; throws a Korean `invalid` for anything that is not an existing folder. */
export async function realFolder(path: unknown): Promise<string> {
  if (!pathLike(path) || !isAbsolute(path)) throw invalid('공유할 폴더는 절대 경로여야 합니다.');
  let root: string;
  try { root = await realpath(path); } catch { throw invalid(`폴더를 찾을 수 없습니다: ${path}`); }
  if (!(await stat(root)).isDirectory()) throw invalid(`폴더가 아닙니다: ${path}`);
  return root;
}

const unique = (folders: SecretFolder[]) => [...new Map(folders.map(folder => [JSON.stringify([folder.hostId, folder.root]), folder])).values()];

/**
 * The page's folders as canonical identities. A folder key (`{ cwd }`) of this computer becomes its real path here; one of
 * a joined computer becomes that computer's real path, asked of it, under the vault ID of the peer trusted for secrets
 * on that link. A `{ hostId, root }` the page sends back is not resolved: it is `kept`, which only a folder the key
 * already keeps may be, and the service checks that.
 */
export async function canonicalFolders(input: unknown, sources: FolderSources): Promise<{ folders: SecretFolder[]; kept: SecretFolder[] }> {
  if (!Array.isArray(input) || input.length > MAX_FOLDERS) throw invalid('공유할 폴더 목록이 올바르지 않습니다.');
  let device: Promise<string> | undefined; let peers: Promise<SecretPeer[]> | undefined;
  const kept: SecretFolder[] = [];
  const folders = await Promise.all(input.map(async (item: unknown): Promise<SecretFolder | undefined> => {
    const value = (item && typeof item === 'object' && !Array.isArray(item) ? item : {}) as Record<string, unknown>;
    const keys = Object.keys(value).sort().join();
    if (keys === 'hostId,root' && pathLike(value.hostId) && pathLike(value.root)) { kept.push({ hostId: value.hostId, root: value.root }); return undefined; }
    if (keys !== 'cwd' || !pathLike(value.cwd)) throw invalid('공유할 폴더 목록이 올바르지 않습니다.');
    const scoped = SCOPED.exec(value.cwd);
    if (!scoped) return { hostId: await (device ??= sources.deviceId()), root: await realFolder(value.cwd) };
    const [, node, path] = scoped as unknown as [string, string, string];
    if (!isAbsolute(path)) throw invalid('공유할 폴더는 절대 경로여야 합니다.');
    const peer = (await (peers ??= sources.peers())).find(peer => peer.enabled && peer.direction === 'node' && peer.routeId === node);
    if (!peer) throw invalid('합류 컴퓨터의 폴더를 공유하려면 먼저 설정 › 시크릿의 연결 컴퓨터에서 그 컴퓨터를 신뢰하세요.');
    const features = sources.features(node);
    if (!features) throw new TowerError('unavailable', '합류 컴퓨터가 연결되어 있지 않아 폴더를 확인할 수 없습니다. 연결된 뒤 다시 저장하세요.');
    if (!features.includes(SECRET_SHARING_FEATURE)) throw invalid('합류 컴퓨터 업데이트가 필요합니다. 그 컴퓨터의 Tower를 업데이트한 뒤 다시 저장하세요.');
    return { hostId: peer.device.id, root: await sources.ask(node, path) };
  }));
  return { folders: unique(folders.filter(folder => folder !== undefined)), kept: unique(kept) };
}
