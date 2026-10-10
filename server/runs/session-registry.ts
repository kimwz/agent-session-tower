import { basename } from 'node:path';
import type { CreateSessionRequest, Run, RunOrigin, Session } from '../../shared/types.js';
import { restoredSessionOrigin, sessionOriginOf, type SessionOrigin } from './origin.js';
import { FINISHED } from './run-records.js';
import { isCreatedSession, type CreatedSession } from './saved-state.js';

export interface RegistryHost {
  /** The native session of this ID, as discovery sees it. */
  native(id: string): Session | undefined;
  /** A record changed: save it with the run history. */
  persist(): void;
}

/**
 * The conversations Tower created: their stable monitor IDs, how they map to the provider's native IDs once confirmed,
 * their provenance and creation name. Native discovery may show the same conversation under its native ID; it is listed
 * once, under the monitor ID, so layout, titles and closure stay attached to it.
 */
export class CreatedSessionRegistry {
  /** The records themselves; only the registry changes them. */
  readonly records = new Map<string, CreatedSession>();
  private readonly touched = new Set<string>();
  touch(id: string): void { this.touched.add(id); }
  takeTouched(): string[] { const ids = [...this.touched]; this.touched.clear(); return ids; }
  constructor(private readonly host: RegistryHost) {}

  /** Takes over the saved records; answers their content as read, so an unchanged file is not written again. */
  load(saved: unknown): string {
    if (!Array.isArray(saved) || saved.some(value => !isCreatedSession(value))) throw new Error('Saved created sessions are invalid.');
    for (const value of saved) {
      const origin = restoredSessionOrigin((value as { origin?: unknown }).origin);
      if (origin) value.origin = origin; else delete value.origin;
      this.records.set(value.session.id, value);
      this.touch(value.session.id);
    }
    return this.serialize();
  }

  serialize(): string { return JSON.stringify([...this.records.values()]); }

  /** Only after a receipt proves the first run was not committed. Never removes a native session. */
  removeUnconfirmed(id: string, runId: string): void {
    const record = this.records.get(id);
    if (record && !record.confirmed && record.runId === runId) { this.records.delete(id); this.touch(id); }
  }

  has(id: string): boolean { return this.records.has(id); }
  /** The session as created, before any native record of it. */
  created(id: string): Session | undefined { return this.records.get(id)?.session; }
  /** The run that creates the conversation. */
  creationRun(id: string): string | undefined { return this.records.get(id)?.runId; }

  monitorId(id: string): string {
    if (this.records.has(id)) return id;
    for (const [monitorId, created] of this.records) {
      if (created.confirmed && `${created.session.provider}:${created.session.nativeId}` === id) return monitorId;
    }
    return id;
  }

  /** Stable monitor IDs keep layout, titles and closure attached after native discovery. */
  nativeId(id: string): string {
    id = this.monitorId(id);
    const created = this.records.get(id);
    return created?.confirmed ? `${created.session.provider}:${created.session.nativeId}` : id;
  }

  /**
   * Provenance of a session Tower created. Native sessions the owner opened elsewhere return undefined.
   * A ledger link to external content (`linked`) always wins over the stored record.
   */
  origin(id: string, linked: boolean): SessionOrigin | undefined {
    const created = this.records.get(id);
    if (!created) return linked ? { kind: 'unknown', untrustedInput: true } : undefined;
    if (linked && !created.origin?.untrustedInput) {
      // The mark is permanent: record it so a later ledger cleanup cannot clear it.
      created.origin = { ...(created.origin ?? { kind: 'unknown' as const }), untrustedInput: true };
      this.touch(id); this.host.persist();
    }
    return { ...(created.origin ?? { kind: 'unknown' as const, untrustedInput: true }) };
  }

  /**
   * Fills provenance for sessions created before it was recorded. Only evidence that survives in the
   * run registry or in external ledgers is used; anything undecidable stays unknown and untrusted.
   */
  backfill(links: { sessionIds: ReadonlySet<string>; requestIds: ReadonlySet<string> }, run: (id: string) => Run | undefined): number {
    let changed = 0;
    for (const [id, created] of this.records) {
      if (created.origin) continue;
      const initial = run(created.runId);
      const aliases = [id, this.nativeId(id)];
      if (aliases.some(alias => links.sessionIds.has(alias)) || (initial?.autoPromptId && links.requestIds.has(initial.autoPromptId))) {
        created.origin = { kind: 'slack', untrustedInput: true };
      } else if (initial) created.origin = { kind: 'owner', untrustedInput: false };
      else created.origin = { kind: 'unknown', untrustedInput: true };
      this.touch(id); changed++;
    }
    if (changed) this.host.persist();
    return changed;
  }

  /** Once external content is queued for a conversation, it stays marked. */
  markUntrusted(id: string): void {
    const created = this.records.get(id)!;
    if (!created.origin?.untrustedInput) { created.origin = { ...(created.origin ?? { kind: 'unknown' as const }), untrustedInput: true }; this.touch(id); }
  }

  /** Whether the conversation is one Tower created whose native ID the provider has not confirmed yet. */
  unconfirmed(id: string): boolean { const created = this.records.get(id); return Boolean(created && !created.confirmed); }

  /** The provider confirmed the conversation's native ID; false when it is gone or was confirmed as another. */
  confirm(id: string, nativeId: string): boolean {
    const created = this.records.get(id);
    if (!created || (created.confirmed && created.session.nativeId !== nativeId)) return false;
    created.confirmed = true; created.session.nativeId = nativeId; created.session.creationPending = false;
    this.touch(id);
    return true;
  }

  /**
   * Records a new conversation with its first run. Provenance commits with the session identity, before any provider
   * starts; the creation name is a custom title.
   */
  add(input: CreateSessionRequest, id: string, nativeId: string, run: Run, title: string, origin: RunOrigin, untrustedInput: boolean): Session {
    const session: Session = {
      id, nativeId, provider: input.provider,
      title: input.prompt.trim().replace(/\s+/g, ' ').slice(0, 120) || '첨부 파일 확인', ...(title ? { customTitle: title } : {}), cwd: input.cwd, project: basename(input.cwd) || input.cwd,
      status: 'idle', statusReason: '새 세션을 생성하고 있습니다.', createdAt: run.createdAt, updatedAt: run.createdAt,
      lastRequestAt: run.createdAt, lastMessage: input.prompt.trim().slice(0, 512), messageCount: 0, isSubagent: false, resumable: false, creationPending: true,
    };
    this.records.set(id, { session, runId: run.id, confirmed: false, ...(title ? { title } : {}), origin: sessionOriginOf(origin, untrustedInput) });
    this.touch(id);
    return session;
  }

  /**
   * A conversation Tower created, as the page sees it: its native record under the monitor ID (with `withContext`), or
   * while it has none, a placeholder that follows its first run. One whose native record was seen and is gone, and
   * whose first run ended, is no longer listed.
   */
  view(id: string, run: (id: string) => Run | undefined, withContext: (session: Session) => Session): Session | undefined {
    const created = this.records.get(id)!;
    const native = created.confirmed ? this.host.native(this.nativeId(id)) : undefined;
    if (native && !created.seenNative) { created.seenNative = true; this.touch(id); this.host.persist(); }
    const initialRun = run(created.runId);
    const launchedBy = created.origin?.kind === 'trigger' && created.origin.triggerId ? { launchedBy: { kind: 'trigger' as const, triggerId: created.origin.triggerId } } : {};
    // The folder explicitly chosen at creation remains the project's identity.
    // Native discovery may observe a later working directory or incomplete metadata.
    if (native) return withContext({ ...native, id, cwd: created.session.cwd, project: created.session.project, ...(native.parentId ? { parentId: this.monitorId(native.parentId) } : {}), ...(created.title ? { customTitle: created.title } : {}), ...launchedBy });
    if (created.seenNative && (!initialRun || FINISHED.has(initialRun.status))) return undefined;
    const live = initialRun?.status === 'queued' || initialRun?.status === 'running';
    return {
      ...created.session,
      ...launchedBy,
      resumable: created.confirmed,
      creationPending: !created.confirmed && live,
      status: initialRun?.status === 'running' ? 'working' : initialRun?.status === 'queued' ? 'idle' : initialRun?.status === 'completed' ? 'completed' : 'error',
      statusReason: live ? '새 세션을 생성하고 있습니다.' : initialRun?.error || (initialRun?.status === 'completed' ? '첫 작업을 완료했습니다.' : '세션 생성이 완료되지 않았습니다. 새 세션으로 다시 시작할 수 있습니다.'),
      updatedAt: initialRun?.finishedAt || initialRun?.startedAt || created.session.updatedAt,
    };
  }

  /** Native sessions with the created ones listed once, under their monitor IDs, and children pointing at them. */
  list(nativeSessions: readonly Session[], view: (id: string) => Session | undefined): Session[] {
    const aliases = new Map([...this.records.keys()].map(id => [this.nativeId(id), id]));
    const sessions = new Map(nativeSessions.filter(session => !aliases.has(session.id)).map(session => [session.id, session]));
    for (const id of this.records.keys()) {
      const session = view(id);
      if (session) sessions.set(id, session);
    }
    return [...sessions.values()].map(session => session.parentId && aliases.has(session.parentId) ? { ...session, parentId: aliases.get(session.parentId) } : session);
  }
}
