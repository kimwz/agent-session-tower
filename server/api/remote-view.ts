import type { Trigger, TriggerActor, TriggerAuditEntry, TriggerEvent, TriggerHandler, TriggerOverview, TriggerSecret, TriggerTarget } from '../../shared/triggers.js';
import type { Session } from '../../shared/types.js';
import { remoteSessionIds, type RemoteScope } from '../remote/visibility.js';
import { MAX_REVISIONS, type TriggerScope } from '../triggers/service.js';

/** Folders a trigger, or one of its revisions, points at. */
export function handlerPaths(handler: TriggerHandler): string[] {
  return handler.kind === 'task' ? (handler.target.mode === 'folder' ? [handler.target.cwd] : []) : handler.rules.flatMap(rule => rule.cwd ? [rule.cwd] : []);
}
/** Folders a run points at. */
export function eventPaths(input: TriggerEvent['input']): string[] {
  return [...(input.target.mode === 'folder' ? [input.target.cwd] : []), ...(input.rules ?? []).flatMap(rule => rule.cwd ? [rule.cwd] : [])];
}

/** What this computer keeps of its triggers: current ones, deleted ones, and earlier revisions of both. */
export interface KeptTriggers { triggers: readonly Trigger[]; deleted: readonly Trigger[]; revisions: Readonly<Record<string, readonly Trigger[]>> }

/**
 * What a controlling computer may see of this computer's triggers and conversations: nothing that points into a
 * folder kept out of sharing, or at a conversation it cannot see. Slack and coordinator conversations stay here.
 */
export class RemoteView implements TriggerScope {
  readonly sessions: ReadonlySet<string>;
  constructor(readonly scope: RemoteScope, sessions: readonly Session[], private readonly kept: KeptTriggers) {
    this.sessions = remoteSessionIds(sessions, scope);
  }

  folder(cwd: string | undefined): boolean { return !cwd || !this.scope.matcher.excludes(cwd); }
  target(target: TriggerTarget): boolean { return target.mode === 'auto' || (target.mode === 'folder' ? this.folder(target.cwd) : this.sessions.has(target.sessionId)); }
  handler(handler: TriggerHandler): boolean { return handler.kind === 'task' ? this.target(handler.target) : handler.rules.every(rule => this.folder(rule.cwd)); }

  /** Every copy this computer keeps of a trigger, by revision: current, earlier, and deleted. */
  private copies(id: string): Map<number, Trigger> {
    const all = [...this.kept.triggers, ...this.kept.deleted, ...(this.kept.revisions[id] ?? [])].filter(item => item.id === id);
    return new Map(all.map(item => [item.revision, item]));
  }
  /**
   * What a trigger was at a revision. Every change to what it does keeps a copy of what came before, and turning it on
   * or off, or restoring it, changes nothing else; so without a copy of that revision, the next copy kept is the same
   * definition. Earlier copies are dropped oldest first, and before the oldest one kept nothing is known.
   */
  private definition(id: string, revision: number): Trigger | undefined {
    const copies = this.copies(id);
    const exact = copies.get(revision);
    if (exact) return exact;
    const earlier = this.kept.revisions[id] ?? [];
    if (earlier.length >= MAX_REVISIONS && revision < earlier[0].revision) return undefined;
    return [...copies.values()].filter(copy => copy.revision > revision).sort((a, b) => a.revision - b.revision)[0];
  }

  /** A run it may see. A coordinator's runs stay here with the conversations that take them. */
  event(event: TriggerEvent): boolean {
    if (event.input.handler === 'coordinator') return false;
    const fired = this.definition(event.triggerId, event.triggerRevision);
    if (fired && !this.handler(fired.handler)) return false;
    if (!this.target(event.input.target)) return false;
    return [event.dispatch?.sessionId, event.dispatch?.createdSessionId].every(id => !id || this.sessions.has(id));
  }
  /** A run as shown: never a coordinator conversation it went to. */
  shownEvent<T extends TriggerEvent | Omit<TriggerEvent, 'payload'>>(event: T): T {
    const dispatch = event.dispatch;
    if (!dispatch?.workflowId) return event;
    const { workflowId: _workflow, ...rest } = dispatch;
    return { ...event, dispatch: rest };
  }

  /** Who made a change, without a conversation it cannot see. */
  actor(actor: TriggerActor): TriggerActor {
    if (!actor.sessionId || this.sessions.has(actor.sessionId)) return actor;
    const { sessionId: _session, runId: _run, ...rest } = actor;
    return rest;
  }
  trigger<T extends Trigger>(trigger: T): T { return { ...trigger, createdBy: this.actor(trigger.createdBy), updatedBy: this.actor(trigger.updatedBy) }; }

  /**
   * A change it may see: to limits and secrets, or to a trigger whose every revision the change names is one it can
   * see. A change that names a revision whose definition is no longer known stays here; so do Slack's.
   */
  audit(entry: TriggerAuditEntry): boolean {
    if (entry.action === 'slack') return false;
    if (entry.action === 'settings' || entry.action === 'secret') return true;
    const copies = this.copies(entry.triggerId);
    const named = [entry.fromRevision, entry.toRevision].filter((revision): revision is number => revision !== undefined);
    if (!named.length) return copies.size > 0 && [...copies.values()].every(copy => this.handler(copy.handler));
    return named.every(revision => { const copy = this.definition(entry.triggerId, revision); return Boolean(copy) && this.handler(copy!.handler); });
  }

  overview(overview: TriggerOverview, find: (id: string) => TriggerEvent | undefined): TriggerOverview {
    const shown = (event: TriggerOverview['recent'][number]) => { const full = find(event.id); return full ? this.event(full) : false; };
    const current = new Map(this.kept.triggers.map(trigger => [trigger.id, trigger]));
    return {
      triggers: overview.triggers.filter(summary => summary.kind !== 'slack' && current.has(summary.id) && this.handler(current.get(summary.id)!.handler)).map(summary => {
        const withActor = { ...summary, updatedBy: this.actor(summary.updatedBy) };
        if (!summary.lastEvent) return withActor;
        const last = find(summary.lastEvent.id);
        if (last && this.event(last)) return withActor;
        const { lastEvent: _, ...rest } = withActor;
        return rest;
      }),
      recent: overview.recent.filter(shown).map(event => this.shownEvent(event)),
      ...(overview.updated ? { updated: overview.updated.filter(shown).map(event => this.shownEvent(event)) } : {}),
      ...(overview.storageError ? { storageError: overview.storageError } : {}),
    };
  }

  secret(secret: TriggerSecret): TriggerSecret {
    const current = new Map(this.kept.triggers.map(trigger => [trigger.id, trigger]));
    return { ...secret, triggerIds: secret.triggerIds.filter(id => current.has(id) && this.handler(current.get(id)!.handler)) };
  }
}
