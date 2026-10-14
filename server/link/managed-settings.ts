import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { ClientHttp2Session, Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import { join } from 'node:path';
import { readJson } from '../http/requests.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { TowerError, fromStatus, statusOf } from '../../shared/errors.js';
import { MANAGED_SECTIONS, type ManagedApplied, type ManagedFolder, type ManagedPayload, type ManagedSection, type ManagedSyncStatus } from '../../shared/managed.js';
import type { NodeSummary } from '../../shared/link.js';
import type { FollowedHostStore } from './follow.js';
import { linkRequest } from './transport.js';

/** The largest settings payload a following computer reads (skills carry their files). */
export const MAX_MANAGED_BYTES = 32 * 1024 * 1024;
const SYNC_MS = 60_000;
const FOLDERS_MS = 5 * 60_000;
const PUT_MS = 60_000;
/** Sent again this often even when unchanged here, so a setting changed on the following computer goes back. */
const RECONCILE_MS = 10 * 60_000;

/** What a section is on this Tower now; undefined leaves the section out, so a following computer keeps its value. */
export type ManagedExporter = () => Promise<unknown>;
/** Applies a section received from the followed Tower. A failure keeps what was there before. */
export type ManagedApplier = (value: unknown, context: { hostId: string }) => Promise<void>;
/** Something the followed Tower asks this computer to do (`POST /api/managed/<name>`); it resolves to the answer. */
export type ManagedAction = (body: Record<string, unknown>, context: { hostId: string }) => Promise<unknown>;

/** How long after its last sync the followed Tower still counts as announcing the work it sent here (it syncs every 10 minutes). */
const ANNOUNCES_MS = 20 * 60_000;

/**
 * The followed Tower, while it keeps sending its settings: only then does it announce the work it sent here, so this
 * computer leaves those pushes to it. An older or silent host gets none, and this computer announces that work itself.
 */
export function announcingHost(hostId: string | undefined, applied: ManagedApplied | undefined, now: number): string | undefined {
  return hostId && applied && now - Date.parse(applied.appliedAt) < ANNOUNCES_MS ? hostId : undefined;
}

/** JSON with object keys in order: the same settings always give the same text, and so the same revision. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function managedRevision(sections: ManagedPayload['sections']): string {
  return createHash('sha256').update(canonicalJson(sections)).digest('hex');
}

interface SyncController {
  list(): NodeSummary[];
  session(id: string): ClientHttp2Session | undefined;
  following(id: string): boolean;
  on(event: 'connected' | 'followChanged' | 'disconnected', listener: (id: string) => void): unknown;
}

/**
 * The controlling side of "호스트 설정 따르기": keeps every connected computer that follows this Tower on this
 * Tower's settings. Each section comes from its owning module (`register`); the whole payload is sent again whenever
 * its revision differs from the one the computer confirmed last, and checked again every minute.
 */
export class ManagedSettingsSync extends EventEmitter {
  private readonly exporters = new Map<ManagedSection, ManagedExporter>();
  private readonly statuses = new Map<string, ManagedSyncStatus>();
  private readonly folderLists = new Map<string, ManagedFolder[]>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private folderTimer?: ReturnType<typeof setInterval>;

  private readonly sentAt = new Map<string, number>();

  constructor(private readonly options: { controller: SyncController; now?: () => number; syncMs?: number; foldersMs?: number; reconcileMs?: number }) { super(); }

  register(section: ManagedSection, exporter: ManagedExporter): void { this.exporters.set(section, exporter); }

  start(): void {
    const controller = this.options.controller;
    controller.on('connected', id => { this.schedule(id); void this.refreshFolders(id); });
    controller.on('followChanged', id => { this.schedule(id); void this.refreshFolders(id); });
    controller.on('disconnected', id => { this.folderLists.delete(id); });
    this.timer = setInterval(() => this.syncAll(), this.options.syncMs ?? SYNC_MS);
    this.timer.unref();
    this.folderTimer = setInterval(() => { for (const node of this.targets()) void this.refreshFolders(node.id); }, this.options.foldersMs ?? FOLDERS_MS);
    this.folderTimer.unref();
  }

  close(): void { clearInterval(this.timer); clearInterval(this.folderTimer); }

  status(id: string): ManagedSyncStatus | undefined { return this.statuses.get(id); }

  /** Sends now to every computer that follows this Tower, for example after a setting changed here. */
  syncAll(): void { for (const node of this.targets()) this.schedule(node.id); }

  private targets(): NodeSummary[] {
    return this.options.controller.list().filter(node => node.followHost && node.status === 'connected' && node.features.includes('managedSettings') && this.options.controller.following(node.id));
  }

  /** One sync per computer at a time; a request meanwhile runs once more after it. */
  schedule(id: string): Promise<void> {
    const current = this.running.get(id);
    if (current) { this.again.add(id); return current; }
    // best-effort: sync records its own failures in the computer's status; the next minute tries again.
    const run = this.sync(id).catch(() => {}).finally(() => {
      this.running.delete(id);
      if (this.again.delete(id)) void this.schedule(id);
    });
    this.running.set(id, run);
    return run;
  }

  /**
   * Sends the settings again now, even unchanged, once any send under way ended: something on that computer changed
   * what they mean there (a folder cloned for a repository a skill applies to). Resolves when it answered.
   */
  async resend(id: string): Promise<void> {
    for (let current = this.running.get(id); current; current = this.running.get(id)) await current;
    this.sentAt.delete(id);
    await this.schedule(id);
  }

  /** The settings this Tower has now, as one payload. A section whose export fails is left out this time. */
  async payload(): Promise<ManagedPayload> {
    const sections: ManagedPayload['sections'] = {};
    for (const section of MANAGED_SECTIONS) {
      const exporter = this.exporters.get(section);
      if (!exporter) continue;
      try { const value = await exporter(); if (value !== undefined) sections[section] = value; }
      catch (error) { console.error(`Managed settings section ${section} was not exported: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { revision: managedRevision(sections), sections };
  }

  private async sync(id: string): Promise<void> {
    const node = this.targets().find(item => item.id === id);
    const session = node && this.options.controller.session(id);
    if (!node || !session) return;
    const payload = await this.payload();
    const known = this.statuses.get(id);
    const now = this.options.now?.() ?? Date.now();
    // Sent when it changed here, while a section failed there, and every so often anyway (a change made there).
    const settled = known?.applied?.revision === payload.revision && !known.applied.errors && !known.error;
    if (settled && now - (this.sentAt.get(id) ?? 0) < (this.options.reconcileMs ?? RECONCILE_MS)) return;
    this.sentAt.set(id, now);
    const attemptedAt = new Date(now).toISOString();
    let status: ManagedSyncStatus;
    try {
      const answer = await linkRequest(session, 'PUT', '/api/managed/settings', payload, PUT_MS);
      const applied = parseApplied(answer.json);
      status = answer.status === 200 && applied ? { applied, attemptedAt }
        : { ...(known?.applied ? { applied: known.applied } : {}), attemptedAt, error: (answer.json as { error?: string } | undefined)?.error || `그 컴퓨터가 설정을 받지 않았습니다 (${answer.status}).` };
    } catch (error) {
      status = { ...(known?.applied ? { applied: known.applied } : {}), attemptedAt, error: error instanceof Error ? error.message : String(error) };
    }
    this.statuses.set(id, status);
    this.emit('change', id);
  }

  /** The project folders a following computer has, with their repositories; the last list known while it is away. */
  folders(id: string): ManagedFolder[] { return this.folderLists.get(id) ?? []; }

  /** Asks a computer that follows this Tower for one of its actions (`ManagedSettingsReceiver.action`); its answer, or why not. */
  async request(id: string, name: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const session = this.targets().some(node => node.id === id) ? this.options.controller.session(id) : undefined;
    if (!session) throw new TowerError('conflict', '그 컴퓨터가 연결되어 있고 이 Tower의 설정을 따를 때만 할 수 있습니다.');
    const answer = await linkRequest(session, 'POST', `/api/managed/${name}`, body, timeoutMs);
    if (answer.status !== 200) throw fromStatus(answer.status, (answer.json as { error?: unknown } | undefined)?.error as string || `그 컴퓨터가 요청을 받지 않았습니다 (${answer.status}).`);
    return answer.json;
  }

  async refreshFolders(id: string): Promise<ManagedFolder[]> {
    const session = this.targets().some(node => node.id === id) ? this.options.controller.session(id) : undefined;
    if (!session) return this.folders(id);
    // best-effort: the last list known stays until the next refresh.
    const answer = await linkRequest(session, 'GET', '/api/managed/folders', undefined, 30_000).catch(() => undefined);
    const folders = answer?.status === 200 ? parseFolders(answer.json) : undefined;
    if (!folders) return this.folders(id);
    this.folderLists.set(id, folders);
    this.emit('folders', id, folders);
    return folders;
  }
}

/** What a computer says it applied, checked: only known sections and short reasons get through. */
export function parseApplied(value: unknown): ManagedApplied | undefined {
  const applied = value as Partial<ManagedApplied> | undefined;
  if (!applied || typeof applied.revision !== 'string' || typeof applied.appliedAt !== 'string') return undefined;
  const errors = applied.errors && typeof applied.errors === 'object'
    ? Object.fromEntries(Object.entries(applied.errors).filter(([key, text]) => (MANAGED_SECTIONS as readonly string[]).includes(key) && typeof text === 'string').map(([key, text]) => [key, (text as string).slice(0, 500)]))
    : undefined;
  return { revision: applied.revision, appliedAt: applied.appliedAt, ...(errors && Object.keys(errors).length ? { errors } : {}) };
}

function parseFolders(value: unknown): ManagedFolder[] | undefined {
  const folders = (value as { folders?: unknown } | undefined)?.folders;
  if (!Array.isArray(folders)) return undefined;
  return folders.slice(0, 2000).flatMap(item => {
    const folder = item as Partial<ManagedFolder>;
    if (!folder || typeof folder.cwd !== 'string' || !folder.cwd.startsWith('/')) return [];
    return [{ cwd: folder.cwd, ...(typeof folder.remoteUrl === 'string' ? { remoteUrl: folder.remoteUrl } : {}) }];
  });
}

/**
 * The following side: applies what the followed Tower sends and tells it which folders this computer has. Only the
 * followed Tower is answered; any other controller keeps its limits.
 */
export class ManagedSettingsReceiver {
  private readonly appliers = new Map<ManagedSection, ManagedApplier>();
  private last?: ManagedApplied;
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { stateDir: string; follow: FollowedHostStore; folders: () => Promise<ManagedFolder[]>; now?: () => number }) {
    this.path = join(options.stateDir, 'managed', 'applied.json');
  }

  register(section: ManagedSection, applier: ManagedApplier): void { this.appliers.set(section, applier); }

  private readonly actions = new Map<string, ManagedAction>();
  /** An action only the followed Tower may ask for, like every managed route. */
  action(name: string, action: ManagedAction): void { this.actions.set(name, action); }

  async start(): Promise<void> {
    // best-effort: no record yet (or an unreadable one) only means nothing is reported until the next apply.
    const saved = await readPrivateJson(this.path, 64 * 1024).catch(() => undefined);
    this.last = parseApplied(saved);
  }

  /** What was applied last, for this computer's report and page. */
  applied(): ManagedApplied | undefined { return this.last; }

  /** Handles `/api/managed/*` for a controller; false for any other path. */
  async handle(req: Http2ServerRequest, res: Http2ServerResponse, principal: { controllerId: string }): Promise<boolean> {
    const path = (req.url ?? '').split('?')[0];
    if (!path.startsWith('/api/managed/')) return false;
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (await this.options.follow.reload() !== principal.controllerId) { json(403, { error: '이 컴퓨터는 그 Tower의 설정을 따르지 않습니다.' }); return true; }
    if (req.method === 'PUT' && path === '/api/managed/settings') {
      // best-effort: an unreadable body is answered as an invalid one below.
      const body = await readJson(req, MAX_MANAGED_BYTES).catch(() => undefined);
      const sections = body?.sections;
      if (!body || typeof body.revision !== 'string' || !sections || typeof sections !== 'object' || Array.isArray(sections)) { json(400, { error: '설정 형식이 올바르지 않습니다.' }); return true; }
      const applied = await this.apply({ revision: body.revision, sections: sections as ManagedPayload['sections'] }, principal.controllerId);
      if (!applied) { json(403, { error: '이 컴퓨터는 그 Tower의 설정을 따르지 않습니다.' }); return true; }
      json(200, applied);
      return true;
    }
    if (req.method === 'GET' && path === '/api/managed/folders') { json(200, { folders: await this.options.folders() }); return true; }
    const action = req.method === 'POST' ? this.actions.get(path.slice('/api/managed/'.length)) : undefined;
    if (action) {
      try { json(200, await action(await readJson(req, 64 * 1024), { hostId: principal.controllerId })); }
      catch (error) { json(statusOf(error) ?? 500, { error: error instanceof Error ? error.message : String(error) }); }
      return true;
    }
    json(404, { error: 'Not found.' });
    return true;
  }

  /**
   * Applies each section that came, one payload at a time; one that fails keeps its value and is reported. Undefined
   * when this computer no longer follows that Tower (it switched while the payload waited): the rest is not applied.
   */
  apply(payload: ManagedPayload, hostId: string): Promise<ManagedApplied | undefined> {
    const run = this.queue.then(async () => {
      const errors: Partial<Record<ManagedSection, string>> = {};
      for (const section of MANAGED_SECTIONS) {
        if (!(section in payload.sections)) continue;
        const applier = this.appliers.get(section);
        if (!applier) continue;
        if (await this.options.follow.reload() !== hostId) return undefined;
        try { await applier(payload.sections[section], { hostId }); }
        catch (error) { errors[section] = (error instanceof Error ? error.message : String(error)).slice(0, 500); }
      }
      const applied: ManagedApplied = { revision: payload.revision, appliedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(), ...(Object.keys(errors).length ? { errors } : {}) };
      this.last = applied;
      await mkdir(join(this.options.stateDir, 'managed'), { recursive: true, mode: 0o700 });
      // best-effort: the record only reports the last apply; the controller's next sync corrects a missed one.
      await writePrivateJson(this.path, JSON.stringify(applied)).catch(() => {});
      return applied;
    });
    // best-effort: the caller of this apply gets its failure; the chain only keeps order.
    this.queue = run.catch(() => {});
    return run;
  }
}
