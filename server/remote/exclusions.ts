import { EventEmitter } from 'node:events';
import { realpath } from 'node:fs';
import { promisify } from 'node:util';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/** A folder this machine never shares with a remote controller, including everything below it. */
export interface ExcludedFolder { path: string; canonical: string }
export interface ExclusionMatcher {
  /** Changes whenever the list changes, so remote readers can tell which list filtered a result. */
  readonly revision: number;
  /** True for an excluded folder or anything inside it. A path whose real location is not known yet counts as excluded. */
  excludes(path: string): boolean;
}

const MAX_FOLDERS = 200;
// The native call reports the real letter case on case-insensitive file systems.
const realpathNative = promisify(realpath.native);
const invalid = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
// The default macOS and Windows file systems ignore case, so "Secret" and "secret" are one folder.
const foldCase = process.platform === 'darwin' || process.platform === 'win32';
const key = (path: string) => foldCase ? path.toLowerCase() : path;

function normalize(path: string): string {
  const resolved = resolve(path);
  return resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}

function within(root: string, path: string): boolean {
  const a = key(root), b = key(path);
  return a === '/' || b === a || b.startsWith(`${a}/`);
}

export function validFolderPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && value.length <= 4096 && !value.includes('\0');
}

/**
 * The real location of a path: its nearest existing ancestor resolved through symlinks, plus the rest.
 * Undefined when that cannot be determined (no permission, a symlink loop): callers treat it as excluded.
 */
export async function canonicalPath(path: string): Promise<string | undefined> {
  let current = normalize(path);
  const rest: string[] = [];
  for (;;) {
    try { return normalize(join(await realpathNative(current), ...rest.reverse())); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) return undefined;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** How long a resolved location is trusted before it is checked again; a symlink can be pointed elsewhere. */
const RESOLVED_TTL_MS = 10_000;
const UNRESOLVABLE = '\0';

/** Every location an excluded folder is known by: as entered, as resolved when saved, and as it resolves now (it can be moved or re-linked). */
async function rootsOf(folders: readonly ExcludedFolder[]): Promise<string[]> {
  const now = await Promise.all(folders.map(item => canonicalPath(item.path)));
  return [...new Set([...folders.flatMap(item => [normalize(item.path), item.canonical]), ...now.filter((path): path is string => Boolean(path))])];
}

/**
 * The remote-sharing exclusion list. Only this machine's own screen changes it; remote controllers never
 * see it. Matching covers subfolders and resolves symlinks, so an alias cannot reveal an excluded folder.
 */
export class RemoteExclusionStore extends EventEmitter {
  private readonly path: string;
  private folders: ExcludedFolder[] = [];
  /** Every location an excluded folder is known by: as entered, as resolved when saved, and as it resolves now. */
  private roots: string[] = [];
  private rootsAt = 0;
  private currentRevision = 0;
  /** Set when the saved list cannot be read: remote sharing then hides everything until it can be. */
  private unreadable?: string;
  private reading: Promise<void> = Promise.resolve();
  private readonly resolved = new Map<string, { canonical: string; at: number }>();
  private readonly resolving = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();

  private readonly recheckMs: number;
  constructor(stateDir: string, options: { recheckMs?: number } = {}) {
    super();
    this.path = join(stateDir, 'remote-exclusions.json');
    this.recheckMs = options.recheckMs ?? RESOLVED_TTL_MS;
  }

  async start(): Promise<void> { await this.reload(); }

  /**
   * Reads the list again; a worker uses this to follow changes the web process saved. Reads run one at a
   * time and an older revision never replaces a newer one. A list that cannot be read never stops local
   * work: it makes every folder private to remote controllers until it can be read again.
   */
  reload(): Promise<void> {
    const next = this.reading.then(() => this.read());
    this.reading = next.catch(() => {});
    return next;
  }

  private async read(): Promise<void> {
    let saved: unknown;
    try { saved = await readPrivateJson(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const changed = this.currentRevision !== 0 || this.folders.length > 0 || this.unreadable !== undefined;
        this.folders = []; this.roots = []; this.currentRevision = 0; this.unreadable = undefined;
        if (changed) this.emit('change');
        return;
      }
      this.markUnreadable();
      return;
    }
    const value = saved as { version?: unknown; revision?: unknown; folders?: unknown };
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.folders) || value.folders.length > MAX_FOLDERS
      || !value.folders.every(item => item && typeof item === 'object' && validFolderPath((item as ExcludedFolder).path) && validFolderPath((item as ExcludedFolder).canonical))) {
      this.markUnreadable();
      return;
    }
    const revision = value.revision as number;
    if (revision < this.currentRevision && !this.unreadable) return;
    const folders = (value.folders as ExcludedFolder[]).map(item => ({ path: item.path, canonical: item.canonical }));
    const roots = await rootsOf(folders);
    const changed = revision !== this.currentRevision || JSON.stringify(folders) !== JSON.stringify(this.folders) || this.unreadable !== undefined;
    this.folders = folders; this.roots = roots; this.rootsAt = Date.now(); this.currentRevision = revision; this.unreadable = undefined;
    if (changed) this.emit('change');
  }

  private markUnreadable(): void {
    const changed = this.unreadable === undefined;
    this.unreadable = '원격 공유 제외 목록을 읽지 못했습니다. 다시 읽을 수 있을 때까지 모든 폴더를 원격에서 가립니다.';
    this.roots = ['/'];
    if (changed) this.emit('change');
  }

  /** Why the list could not be read, if it could not. */
  get error(): string | undefined { return this.unreadable; }

  /** Replaces a list that cannot be read with an empty one. Until then, remote controllers see no folders at all. */
  async reset(): Promise<string[]> {
    this.unreadable = undefined;
    return this.update(async () => []).catch(error => { this.markUnreadable(); throw error; });
  }

  list(): string[] { return this.folders.map(item => item.path); }
  get revision(): number { return this.currentRevision; }

  add(path: unknown): Promise<string[]> {
    if (!validFolderPath(path)) throw invalid('폴더의 절대 경로를 입력하세요.');
    return this.update(async folders => {
      const normalized = normalize(path);
      const canonical = await canonicalPath(path) ?? normalized;
      if (folders.some(item => key(item.path) === key(normalized) || key(item.canonical) === key(canonical))) return undefined;
      if (folders.length >= MAX_FOLDERS) throw invalid(`제외할 수 있는 폴더는 최대 ${MAX_FOLDERS}개입니다.`);
      return [...folders, { path: normalized, canonical }];
    });
  }

  remove(path: unknown): Promise<string[]> {
    if (!validFolderPath(path)) throw invalid('폴더의 절대 경로를 입력하세요.');
    return this.update(async folders => {
      const normalized = normalize(path);
      const next = folders.filter(item => key(item.path) !== key(normalized));
      return next.length === folders.length ? undefined : next;
    });
  }

  /**
   * Resolves where these paths really are, so `matcher()` can answer for them without waiting. `fresh`
   * resolves them again now, for a decision about one particular folder that must not rest on an older look.
   */
  async prepare(paths: Iterable<string>, options: { fresh?: boolean } = {}): Promise<void> {
    if (!this.roots.length) return;
    const now = Date.now();
    // An excluded folder that is a symlink can be pointed elsewhere; follow where it points now.
    if (options.fresh || now - this.rootsAt > this.recheckMs) await this.follow();
    const pending = [...new Set([...paths].filter(validFolderPath).map(normalize))].filter(path => {
      const known = this.resolved.get(path);
      return options.fresh || !known || now - known.at > this.recheckMs;
    });
    for (let index = 0; index < pending.length; index += 16) {
      await Promise.all(pending.slice(index, index + 16).map(async path => { this.remember(path, await canonicalPath(path)); }));
    }
  }

  /** Checks a path whose real location matters now, such as a folder a remote request wants to use. */
  async excludesNow(path: string): Promise<boolean> {
    if (!this.roots.length) return false;
    if (!validFolderPath(path)) return true;
    await this.follow();
    const normalized = normalize(path);
    const canonical = await canonicalPath(normalized);
    this.remember(normalized, canonical);
    return canonical === undefined || this.matches(normalized, canonical);
  }

  /**
   * A check for the entries of one folder as listed from disk. An entry's real location is the folder's own real
   * location and its name (links among the entries are never listed), so each needs no look of its own.
   */
  async entriesOf(folder: string): Promise<(name: string) => boolean> {
    if (!this.roots.length) return () => false;
    if (!validFolderPath(folder)) return () => true;
    await this.follow();
    const normalized = normalize(folder);
    const canonical = await canonicalPath(normalized);
    const roots = this.roots;
    return name => canonical === undefined || this.matches(join(normalized, name), join(canonical, name), roots);
  }

  private async follow(): Promise<void> {
    const folders = this.folders;
    const roots = await rootsOf(folders);
    // Only if the list did not change meanwhile; a change brings its own roots.
    if (folders === this.folders && !this.unreadable) { this.roots = roots; this.rootsAt = Date.now(); }
  }

  matcher(): ExclusionMatcher {
    const roots = this.roots;
    const revision = this.currentRevision;
    return {
      revision,
      excludes: path => {
        if (!roots.length) return false;
        if (!validFolderPath(path)) return true;
        const normalized = normalize(path);
        const known = this.resolved.get(normalized);
        if (!known || Date.now() - known.at > this.recheckMs * 6) {
          // Unknown (or long unchecked) until resolved: hide it now and publish again once its real location is known.
          this.resolveLater(normalized);
          return true;
        }
        return known.canonical === UNRESOLVABLE || this.matches(normalized, known.canonical, roots);
      },
    };
  }

  flush(): Promise<void> { return this.writes.then(() => {}, () => {}); }

  private matches(path: string, canonical: string, roots = this.roots): boolean {
    return roots.some(root => within(root, path) || within(root, canonical));
  }



  private remember(path: string, canonical: string | undefined): void {
    if (this.resolved.size > 20_000) this.resolved.clear();
    this.resolved.set(path, { canonical: canonical ?? UNRESOLVABLE, at: Date.now() });
  }

  private resolveLater(path: string): void {
    if (this.resolving.has(path)) return;
    this.resolving.add(path);
    void canonicalPath(path).then(canonical => { this.remember(path, canonical); }, () => { this.remember(path, undefined); })
      .finally(() => {
        this.resolving.delete(path);
        if (!this.resolving.size) this.emit('resolved');
      });
  }

  private update(change: (folders: ExcludedFolder[]) => Promise<ExcludedFolder[] | undefined>): Promise<string[]> {
    const write = this.writes.then(async () => {
      const next = await change(this.folders);
      if (!next) return this.list();
      if (this.unreadable) throw invalid(this.unreadable, 503);
      // Time-based, so a list rebuilt after the file was lost still reads as newer to every reader.
      const revision = Math.max(this.currentRevision + 1, Date.now());
      const roots = await rootsOf(next);
      await writePrivateJson(this.path, `${JSON.stringify({ version: 1, revision, folders: next })}\n`);
      this.folders = next;
      this.roots = roots;
      this.rootsAt = Date.now();
      this.currentRevision = revision;
      this.emit('change');
      return this.list();
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
