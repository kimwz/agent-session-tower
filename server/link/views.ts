import { EventEmitter } from 'node:events';
import { isAbsolute, join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { linkDirectory } from './identity.js';

export interface FolderView { pinned?: true; hidden?: true }
type Views = Record<string, Record<string, FolderView>>;

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * How this Tower shows another computer's folders: pinned or hidden here. The other computer never learns
 * of it (K5); its own folder names still come from it.
 */
export class NodeViewStore extends EventEmitter {
  private views: Views = {};
  private readonly path: string;
  private writes: Promise<unknown> = Promise.resolve();
  private broken?: string;

  constructor(stateDir: string) {
    super();
    this.path = join(linkDirectory(stateDir), 'views.json');
  }

  async start(): Promise<void> {
    try {
      const saved = await readPrivateJson(this.path);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Saved remote folder views are invalid.');
      this.views = saved as Views;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.broken = `${this.path} 파일을 읽을 수 없어 다른 컴퓨터 폴더의 고정·숨김을 저장할 수 없습니다. 파일을 확인하거나 옮긴 뒤 Tower를 다시 시작하세요.`;
    }
  }

  of(node: string): Readonly<Record<string, FolderView>> { return this.views[node] ?? {}; }

  async set(node: string, cwd: unknown, patch: { pinned?: unknown; hidden?: unknown }): Promise<void> {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096 || cwd.includes('\0')) throw invalid('폴더의 절대 경로가 필요합니다.');
    if ((patch.pinned !== undefined && typeof patch.pinned !== 'boolean') || (patch.hidden !== undefined && typeof patch.hidden !== 'boolean')) throw invalid('고정 또는 숨김 상태를 지정하세요.');
    const current = this.views[node]?.[cwd] ?? {};
    const pinned = patch.pinned ?? current.pinned ?? false;
    const hidden = patch.hidden ?? current.hidden ?? false;
    const folders = { ...this.views[node] };
    if (pinned || hidden) folders[cwd] = { ...(pinned ? { pinned: true } : {}), ...(hidden ? { hidden: true } : {}) };
    else delete folders[cwd];
    const next = { ...this.views };
    if (Object.keys(folders).length) next[node] = folders; else delete next[node];
    await this.save(next);
    this.emit('change', node);
  }

  /** Forgets computers this Tower no longer knows. */
  async keep(nodes: ReadonlySet<string>): Promise<void> {
    if (Object.keys(this.views).every(node => nodes.has(node))) return;
    await this.save(Object.fromEntries(Object.entries(this.views).filter(([node]) => nodes.has(node))));
  }

  flush(): Promise<unknown> { return this.writes; }

  private save(next: Views): Promise<void> {
    if (this.broken) return Promise.reject(Object.assign(new Error(this.broken), { statusCode: 503 }));
    this.views = next;
    const data = JSON.stringify(next);
    const write = this.writes.then(() => writePrivateJson(this.path, data));
    this.writes = write.catch(() => {});
    return write;
  }
}
