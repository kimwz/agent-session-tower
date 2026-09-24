import type { Trigger, TriggerAuditEntry, TriggerEvent, TriggerHandler, TriggerOverview, TriggerSecret, TriggerTarget } from '../../shared/triggers.js';
import type { Session } from '../../shared/types.js';
import { remoteSessionIds, type RemoteScope } from '../remote/visibility.js';

/** Folders a trigger, or one of its revisions, points at. */
export function handlerPaths(handler: TriggerHandler): string[] {
  return handler.kind === 'task' ? (handler.target.mode === 'folder' ? [handler.target.cwd] : []) : handler.rules.flatMap(rule => rule.cwd ? [rule.cwd] : []);
}
/** Folders a run points at. */
export function eventPaths(input: TriggerEvent['input']): string[] {
  return [...(input.target.mode === 'folder' ? [input.target.cwd] : []), ...(input.rules ?? []).flatMap(rule => rule.cwd ? [rule.cwd] : [])];
}

/**
 * What a controlling computer may see of this computer's triggers and conversations: nothing that points into a
 * folder kept out of sharing, or at a conversation it cannot see. Slack stays on this computer.
 */
export class RemoteView {
  readonly sessions: ReadonlySet<string>;
  constructor(readonly scope: RemoteScope, sessions: readonly Session[], private readonly kept: { triggers: readonly Trigger[]; deleted: readonly Trigger[] }) {
    this.sessions = remoteSessionIds(sessions, scope);
  }

  folder(cwd: string | undefined): boolean { return !cwd || !this.scope.matcher.excludes(cwd); }
  target(target: TriggerTarget): boolean { return target.mode === 'auto' || (target.mode === 'folder' ? this.folder(target.cwd) : this.sessions.has(target.sessionId)); }
  handler(handler: TriggerHandler): boolean { return handler.kind === 'task' ? this.target(handler.target) : handler.rules.every(rule => this.folder(rule.cwd)); }

  /** Whether a trigger this computer still knows (kept or deleted) may be seen; undefined for one it no longer knows. */
  known(id: string): boolean | undefined {
    const found = [...this.kept.triggers, ...this.kept.deleted].filter(item => item.id === id);
    return found.length ? found.every(item => this.handler(item.handler)) : undefined;
  }

  event(event: TriggerEvent): boolean {
    if (this.known(event.triggerId) === false) return false;
    if (!this.target(event.input.target) || !(event.input.rules ?? []).every(rule => this.folder(rule.cwd))) return false;
    // A coordinator conversation is left out of what is shown; any other conversation must be one it can see.
    return [event.dispatch?.sessionId, event.dispatch?.createdSessionId].every(id => !id || this.sessions.has(id) || this.scope.coordinators.has(id));
  }
  /** A run as shown: without the coordinator conversation that took it. */
  shownEvent<T extends TriggerEvent | Omit<TriggerEvent, 'payload'>>(event: T): T {
    const dispatch = event.dispatch;
    if (!dispatch?.sessionId || !this.scope.coordinators.has(dispatch.sessionId)) return event;
    const { sessionId: _session, workflowId: _workflow, ...rest } = dispatch;
    return { ...event, dispatch: rest };
  }

  /** Changes to triggers it can see, and to limits and secrets; Slack and forgotten triggers stay here. */
  audit(entry: TriggerAuditEntry): boolean {
    if (entry.action === 'slack') return false;
    if (entry.action === 'settings' || entry.action === 'secret') return true;
    return this.known(entry.triggerId) === true;
  }

  overview(overview: TriggerOverview, find: (id: string) => TriggerEvent | undefined): TriggerOverview {
    const shown = (event: TriggerOverview['recent'][number]) => { const full = find(event.id); return full ? this.event(full) : false; };
    return {
      triggers: overview.triggers.filter(summary => summary.kind !== 'slack' && this.known(summary.id) === true).map(summary => {
        if (!summary.lastEvent) return summary;
        const last = find(summary.lastEvent.id);
        if (last && this.event(last)) return summary;
        const { lastEvent: _, ...rest } = summary;
        return rest;
      }),
      recent: overview.recent.filter(shown).map(event => this.shownEvent(event)),
      ...(overview.updated ? { updated: overview.updated.filter(shown).map(event => this.shownEvent(event)) } : {}),
      ...(overview.storageError ? { storageError: overview.storageError } : {}),
    };
  }

  secret(secret: TriggerSecret): TriggerSecret { return { ...secret, triggerIds: secret.triggerIds.filter(id => this.known(id) === true) }; }
}
