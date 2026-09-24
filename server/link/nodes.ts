import { EventEmitter } from 'node:events';
import type { ClientHttp2Session } from 'node:http2';
import type { ProjectGroup, Snapshot } from '../../shared/types.js';
import type { RemoteNode } from '../../shared/link.js';
import type { ControllerLinks } from './controller.js';
import { NodeMirrors } from './mirror.js';
import { updateActive } from './update.js';
import type { NodeViewStore } from './views.js';

/**
 * The computers this Tower controls, as its page shows them: each one's shared snapshot with this Tower's own
 * pins and hidden folders applied, and a summary for the canvas. Emits `change(id)` when a computer's shown
 * state changes, `removed(id)` when it is gone, and `summary` when the list of computers changes.
 */
export class RemoteNodes extends EventEmitter {
  private readonly mirrors: NodeMirrors;

  constructor(private readonly links: ControllerLinks, private readonly views: NodeViewStore) {
    super();
    this.mirrors = new NodeMirrors(links);
    this.mirrors.on('change', this.mirrorChanged);
    this.mirrors.on('removed', this.mirrorRemoved);
    links.on('change', this.linksChanged);
    views.on('change', this.viewChanged);
  }

  list(): RemoteNode[] {
    return this.links.list().map(node => ({ id: node.id, name: node.name, ...(node.label ? { label: node.label } : {}), status: node.status,
      ...(node.version ? { version: node.version } : {}), features: node.features, ...(node.lastSeenAt ? { lastSeenAt: node.lastSeenAt } : {}),
      streaming: node.status === 'connected' && this.mirrors.live(node.id), ...(updateActive(node.report?.update) ? { updating: true } : {}) }));
  }

  /** Computers with a shared state to show. */
  ids(): string[] { return this.mirrors.ids(); }
  /** The list of joined computers is complete; before that a page must not forget any it knew. */
  get ready(): boolean { return this.links.ready; }

  snapshot(id: string): Snapshot | undefined {
    const snapshot = this.mirrors.snapshot(id);
    return snapshot && withViews(snapshot, this.views.of(id));
  }

  session(id: string): ClientHttp2Session | undefined { return this.links.session(id); }
  known(id: string): boolean { return this.links.list().some(node => node.id === id); }

  setView(id: string, cwd: unknown, patch: { pinned?: unknown; hidden?: unknown }): Promise<void> {
    if (!this.known(id)) return Promise.reject(Object.assign(new Error('연결된 컴퓨터가 아닙니다.'), { statusCode: 404 }));
    return this.views.set(id, cwd, patch);
  }

  private readonly streaming = new Map<string, boolean>();

  close(): void {
    this.mirrors.off('change', this.mirrorChanged);
    this.mirrors.off('removed', this.mirrorRemoved);
    this.links.off('change', this.linksChanged);
    this.views.off('change', this.viewChanged);
    this.mirrors.close();
  }

  private readonly mirrorChanged = (id: string) => {
    this.emit('change', id);
    const live = this.mirrors.live(id);
    if (this.streaming.get(id) !== live) { this.streaming.set(id, live); this.emit('summary'); }
  };
  private readonly mirrorRemoved = (id: string) => { this.streaming.delete(id); this.emit('removed', id); };
  private readonly viewChanged = (id: string) => { this.emit('change', id); };
  private readonly linksChanged = () => {
    void this.views.keep(new Set(this.links.list().map(node => node.id))).catch(() => {});
    this.emit('summary');
  };
}

/**
 * Pins and hidden folders come from this Tower; folder names from the other computer. Only folders that
 * computer currently shares take a pin or hide, so a folder it stopped sharing does not reappear as an empty frame.
 */
export function withViews(snapshot: Snapshot, views: Readonly<Record<string, { pinned?: true; hidden?: true }>>): Snapshot {
  const shared = new Set([...snapshot.sessions.map(session => session.cwd), ...(snapshot.groups ?? []).map(group => group.cwd)]);
  const groups = new Map<string, ProjectGroup>((snapshot.groups ?? []).map(group => [group.cwd, { cwd: group.cwd, title: group.title, pinned: false }]));
  for (const [cwd, view] of Object.entries(views)) {
    if (!shared.has(cwd)) continue;
    groups.set(cwd, { cwd, title: groups.get(cwd)?.title ?? '', pinned: Boolean(view.pinned), ...(view.hidden ? { hidden: true } : {}) });
  }
  return { ...snapshot, groups: [...groups.values()] };
}
