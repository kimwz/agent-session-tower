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

/** The real location of a path: its nearest existing ancestor resolved through symlinks, plus the rest. */
export async function canonicalPath(path: string): Promise<string> {
  let current = normalize(path);
  const rest: string[] = [];
  for (;;) {
    try { return normalize(join(await realpathNative(current), ...rest.reverse())); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) return normalize(path);
      rest.push(basename(current));
      current = parent;
    }
  }
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
  private currentRevision = 0;
  private readonly resolved = new Map<string, string>();
  private readonly resolving = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) { super(); this.path = join(stateDir, 'remote-exclusions.json'); }

  async start(): Promise<void> { await this.reload(); }

  /** Reads the list again; a worker uses this to follow changes the web process saved. */
  async reload(): Promise<void> {
    let saved: unknown;
    try { saved = await readPrivateJson(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (this.currentRevision !== 0 || this.folders.length) { this.folders = []; this.roots = []; this.currentRevision = 0; this.emit('change'); }
      return;
    }
    const value = saved as { version?: unknown; revision?: unknown; folders?: unknown };
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.folders) || value.folders.length > MAX_FOLDERS
      || !value.folders.every(item => item && typeof item === 'object' && validFolderPath((item as ExcludedFolder).path) && validFolderPath((item as ExcludedFolder).canonical))) {
      throw new Error('Saved remote-sharing exclusions are invalid.');
    }
    const folders = (value.folders as ExcludedFolder[]).map(item => ({ path: item.path, canonical: item.canonical }));
    const changed = value.revision !== this.currentRevision || JSON.stringify(folders) !== JSON.stringify(this.folders);
    this.folders = folders;
    this.currentRevision = value.revision as number;
    await this.refreshRoots();
    if (changed) this.emit('change');
  }

  list(): string[] { return this.folders.map(item => item.path); }
  get revision(): number { return this.currentRevision; }

  add(path: unknown): Promise<string[]> {
    if (!validFolderPath(path)) throw invalid('Choose an absolute folder path.');
    return this.update(async folders => {
      const canonical = await canonicalPath(path);
      const normalized = normalize(path);
      if (folders.some(item => key(item.path) === key(normalized) || key(item.canonical) === key(canonical))) return undefined;
      if (folders.length >= MAX_FOLDERS) throw invalid(`At most ${MAX_FOLDERS} folders can be excluded.`);
      return [...folders, { path: normalized, canonical }];
    });
  }

  remove(path: unknown): Promise<string[]> {
    if (!validFolderPath(path)) throw invalid('Choose an absolute folder path.');
    return this.update(async folders => {
      const normalized = normalize(path);
      const next = folders.filter(item => key(item.path) !== key(normalized));
      return next.length === folders.length ? undefined : next;
    });
  }

  /** Resolves where these paths really are, so `matcher()` can answer for them without waiting. */
  async prepare(paths: Iterable<string>): Promise<void> {
    if (!this.roots.length) return;
    const pending = [...new Set([...paths].filter(path => validFolderPath(path) && !this.resolved.has(normalize(path))).map(normalize))];
    for (let index = 0; index < pending.length; index += 16) {
      await Promise.all(pending.slice(index, index + 16).map(async path => { this.remember(path, await canonicalPath(path)); }));
    }
  }

  /** Checks a path whose real location matters now, such as a folder a remote request wants to use. */
  async excludesNow(path: string): Promise<boolean> {
    if (!this.roots.length) return false;
    if (!validFolderPath(path)) return true;
    const normalized = normalize(path);
    const canonical = await canonicalPath(normalized);
    this.remember(normalized, canonical);
    return this.matches(normalized, canonical);
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
        const canonical = this.resolved.get(normalized);
        if (canonical === undefined) {
          // Unknown until resolved: hide it now and publish again once its real location is known.
          this.resolveLater(normalized);
          return true;
        }
        return this.matches(normalized, canonical, roots);
      },
    };
  }

  flush(): Promise<void> { return this.writes.then(() => {}, () => {}); }

  private matches(path: string, canonical: string, roots = this.roots): boolean {
    return roots.some(root => within(root, path) || within(root, canonical));
  }

  /** A folder can be moved or re-linked after it was excluded; follow where it points now as well. */
  private async refreshRoots(): Promise<void> {
    const now = await Promise.all(this.folders.map(item => canonicalPath(item.path)));
    this.roots = [...new Set([...this.folders.flatMap(item => [normalize(item.path), item.canonical]), ...now])];
  }

  private remember(path: string, canonical: string): void {
    if (this.resolved.size > 20_000) this.resolved.clear();
    this.resolved.set(path, canonical);
  }

  private resolveLater(path: string): void {
    if (this.resolving.has(path)) return;
    this.resolving.add(path);
    void canonicalPath(path).then(canonical => { this.remember(path, canonical); }, () => { this.remember(path, path); })
      .finally(() => {
        this.resolving.delete(path);
        if (!this.resolving.size) this.emit('resolved');
      });
  }

  private update(change: (folders: ExcludedFolder[]) => Promise<ExcludedFolder[] | undefined>): Promise<string[]> {
    const write = this.writes.then(async () => {
      const next = await change(this.folders);
      if (!next) return this.list();
      const revision = this.currentRevision + 1;
      await writePrivateJson(this.path, `${JSON.stringify({ version: 1, revision, folders: next })}\n`);
      this.folders = next;
      this.currentRevision = revision;
      await this.refreshRoots();
      this.emit('change');
      return this.list();
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
