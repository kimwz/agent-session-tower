import { EventEmitter } from 'node:events';
import type { NodeSummary } from '../../shared/link.js';
import type { ManagedFolder } from '../../shared/managed.js';
import type { NodeSecretStatus, SecretAlignment, SecretDevice, SecretPeer, SecretShareNotice } from '../../shared/secrets.js';
import type { RunnerCapability } from '../runs/runner-protocol.js';
import { remoteUrlOf } from '../repositories/remote-url.js';
import { SECRET_MACHINES_FEATURE } from '../secrets/folders.js';

const RETRY_MS = 60_000;
/** How long a folder's repository address is trusted before git is asked again. */
const REPOSITORY_MS = 10 * 60_000;
/** How often the owner hears that one computer waits on this Tower's locked vault. */
const LOCKED_NOTICE_MS = 10 * 60_000;
/** How long a notice stays for the web's notifications, which announce each once. */
const NOTICE_MS = 60 * 60_000;

interface Controller {
  list(): NodeSummary[];
  following(id: string): boolean;
  on(event: 'connected' | 'followChanged' | 'disconnected', listener: (id: string) => void): unknown;
}
interface Worker { secretCall(operation: string, args?: unknown[]): Promise<unknown>; supports(capability: RunnerCapability): boolean }
/** One request to a joined computer over its link; undefined when it cannot be asked now. */
export type NodeLink = (nodeId: string, path: string, body: unknown) => Promise<{ status: number; json: unknown } | undefined>;

function alignment(value: unknown): SecretAlignment | undefined {
  const answer = value as Partial<SecretAlignment> | undefined;
  if (!answer || typeof answer !== 'object' || !['missing', 'locked', 'needs-open', 'open'].includes(String(answer.vault)) || typeof answer.trusted !== 'boolean') return undefined;
  const device = answer.device as Partial<SecretDevice> | undefined;
  const valid = device && (['id', 'name', 'signingKey', 'encryptionKey', 'fingerprint'] as const).every(key => typeof device[key] === 'string');
  return { vault: answer.vault!, trusted: answer.trusted, ...(valid ? { device: device as SecretDevice } : {}), ...(answer.untrusted === true ? { untrusted: true } : {}),
    ...(Number.isSafeInteger(answer.available) ? { available: answer.available } : {}) };
}

/**
 * The host's side of secrets for the computers that follow it ("호스트 설정 따르기"): it makes the secret trust between
 * them over their pinned link without the owner (again on connect, on follow, when this vault opens and every minute,
 * until both sides hold it; never for a side whose trust the owner removed), keeps each computer's secret state for its
 * card, adds a clone's folder to the secrets shared with a folder of the same repository here, and tells the owner
 * when a following computer waits on this Tower's locked vault. Only computers advertising `secretMachines` are asked.
 */
export class FollowingSecrets extends EventEmitter {
  private readonly statuses = new Map<string, NodeSecretStatus>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly repositories = new Map<string, { at: number; url?: string }>();
  private readonly lockedTold = new Map<string, number>();
  private readonly lockedNotices: SecretShareNotice[] = [];
  /** Moves on whenever a computer connects, disconnects or its follow changes: an alignment begun before is stale. */
  private readonly epochs = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    controller: Controller; worker: Worker; link: NodeLink;
    /** That computer's real path of one of its folders (`/secret-folder`), so sharing matches its sessions' folders. */
    canonical: (nodeId: string, path: string) => Promise<string>;
    /** The folders a following computer reported last (`ManagedSettingsSync.folders`). */
    folders?: (nodeId: string) => ManagedFolder[];
    repository?: (cwd: string) => Promise<string | undefined>;
    now?: () => number; retryMs?: number;
  }) { super(); }

  start(): void {
    const controller = this.options.controller;
    controller.on('connected', id => { this.moved(id); void this.align(id); });
    controller.on('followChanged', id => { this.moved(id); void this.align(id); });
    controller.on('disconnected', id => { this.moved(id); if (this.statuses.has(id)) this.set(id, { state: 'offline' }); });
    this.timer = setInterval(() => this.alignAll(), this.options.retryMs ?? RETRY_MS);
    this.timer.unref();
  }

  close(): void { clearInterval(this.timer); }

  /** A following computer's secret state for its card; undefined for one never checked. */
  status(id: string): NodeSecretStatus | undefined { return this.statuses.get(id); }

  /** Checks every connected following computer now, for example once this Tower's vault opened. */
  alignAll(): void { for (const node of this.targets()) void this.align(node.id); }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private moved(id: string): void { this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1); }
  /** Still the same connection of a computer that follows this Tower, as when `epoch` was read. */
  private current(id: string, epoch: number): boolean { return this.epochs.get(id) === epoch && this.targets().some(node => node.id === id); }
  private targets(): NodeSummary[] {
    return this.options.controller.list().filter(node => node.followHost && node.status === 'connected' && node.features.includes(SECRET_MACHINES_FEATURE) && this.options.controller.following(node.id));
  }
  private set(id: string, status: Omit<NodeSecretStatus, 'checkedAt'>): void {
    const next: NodeSecretStatus = { ...status, checkedAt: new Date(this.now()).toISOString() };
    const previous = this.statuses.get(id);
    this.statuses.set(id, next);
    if (previous?.state !== next.state || previous.available !== next.available) this.emit('change', id);
  }

  /** One alignment per computer at a time; a request meanwhile runs once more after it. */
  align(id: string): Promise<void> {
    const current = this.running.get(id);
    if (current) { this.again.add(id); return current; }
    const run = this.alignNow(id).catch(error => { console.warn(`Secret trust with a following computer was not checked: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => { this.running.delete(id); if (this.again.delete(id)) void this.align(id); });
    this.running.set(id, run);
    return run;
  }

  private async alignNow(id: string): Promise<void> {
    const worker = this.options.worker; const epoch = this.epochs.get(id) ?? 0; this.epochs.set(id, epoch);
    if (!worker.supports('secretMachines') || !this.current(id, epoch)) return;
    const own = alignment(await worker.secretCall('align', [{ routeId: id, direction: 'node' }]));
    if (!own) throw new Error('The worker answered the trust check in a form this build does not read.');
    const offer = own.vault === 'open' && !own.untrusted && own.device ? { device: own.device } : {};
    const answer = await this.options.link(id, '/secret-align', offer);
    const theirs = answer?.status === 200 ? alignment(answer.json) : undefined;
    // What came back is trusted only for the same connection of a computer that still follows this Tower; a change
    // meanwhile aligns again from the start (the event that moved the epoch asks for it).
    // Known edge: follow turned off while this trust already waits in the worker's save queue still saves it (no lock
    // spans web and worker); turning follow off removes no trust either, so the result is the state just before it.
    if (!this.current(id, epoch)) return;
    let mine = own;
    if (own.vault === 'open' && !own.untrusted && theirs?.device && !theirs.untrusted) mine = alignment(await worker.secretCall('align', [{ routeId: id, direction: 'node', device: theirs.device }])) ?? own;
    const was = this.statuses.get(id)?.state;
    if (own.untrusted || theirs?.untrusted) this.set(id, { state: 'untrusted' });
    else if (own.vault === 'locked') this.set(id, { state: 'host-locked' });
    else if (theirs?.vault === 'needs-open' || theirs?.vault === 'locked') this.set(id, { state: 'needs-open' });
    else if (mine.trusted && theirs?.trusted) this.set(id, { state: 'connected', ...(mine.available !== undefined ? { available: mine.available } : {}) });
    else this.set(id, { state: 'trust-pending' });
    // Folders reported while the trust was still being made are shared now.
    if (was !== 'connected' && this.statuses.get(id)?.state === 'connected') await this.shareFolders(id, this.options.folders?.(id) ?? []);
  }

  /**
   * Folders of a following computer that are clones of a repository whose folder here some secret is shared with join
   * that secret's sharing, once each (the vault remembers, so a folder the owner removes is not added back).
   */
  async shareFolders(id: string, folders: readonly ManagedFolder[]): Promise<void> {
    const worker = this.options.worker;
    const clones = folders.filter((folder): folder is Required<ManagedFolder> => typeof folder.remoteUrl === 'string');
    if (!clones.length || !worker.supports('secretMachines') || !this.targets().some(node => node.id === id)) return;
    const peer = (await worker.secretCall('peers') as SecretPeer[]).find(item => item.enabled && item.direction === 'node' && item.routeId === id);
    if (!peer) return;
    // Each with the sharing revision it was read at: the vault adds nothing to sharing the owner changed meanwhile.
    const own = (await worker.secretCall('shared-folders') as { folders: { secretId: string; root: string; revision: number }[] }).folders;
    const byRepository = new Map<string, { secretId: string; revision: number; hostRoot: string }[]>();
    for (const { secretId, root, revision } of own) {
      const url = await this.repository(root);
      if (url) byRepository.set(url, [...byRepository.get(url) ?? [], { secretId, revision, hostRoot: root }]);
    }
    const additions = new Map<string, { secretId: string; root: string; revision: number; hostRoot: string }>();
    for (const clone of clones) {
      const shared = byRepository.get(clone.remoteUrl);
      if (!shared) continue;
      let root: string;
      try { root = await this.options.canonical(id, clone.cwd); }
      catch { continue; } // best-effort: a folder that computer no longer has, or cannot show now, is tried again with its next list
      for (const item of shared) additions.set(JSON.stringify([item.secretId, root]), { ...item, root });
    }
    if (additions.size) await worker.secretCall('auto-share', [{ hostId: peer.device.id, folders: [...additions.values()] }]);
  }

  private async repository(root: string): Promise<string | undefined> {
    const known = this.repositories.get(root);
    if (known && this.now() - known.at < REPOSITORY_MS) return known.url;
    const url = await (this.options.repository ?? remoteUrlOf)(root);
    this.repositories.set(root, { at: this.now(), ...(url ? { url } : {}) });
    return url;
  }

  /** A following computer refused requests because this Tower's vault is locked: the owner hears once per ten minutes. */
  locked(id: string): void {
    const now = this.now();
    if (now - (this.lockedTold.get(id) ?? 0) < LOCKED_NOTICE_MS) return;
    this.lockedTold.set(id, now);
    this.lockedNotices.push({ key: `secret-locked:${id}:${now}`, at: now, kind: 'host-locked', nodeId: id });
    this.lockedNotices.splice(0, Math.max(0, this.lockedNotices.length - 100));
  }

  /** Locked-vault notices of the last hour, for the web's notifications. */
  notices(): SecretShareNotice[] { const since = this.now() - NOTICE_MS; return this.lockedNotices.filter(notice => notice.at >= since).map(notice => ({ ...notice })); }
}
