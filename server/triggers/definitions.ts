import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { Session } from '../../shared/types.js';
import { GITHUB_API, TriggerInputSchema, TriggerSettingsSchema, carriesOutsideContent, type CoordinatorRule, type SecretInput, type Trigger, type TriggerActor, type TriggerAuditEntry, type TriggerHandler, type TriggerInput, type TriggerSecret, type TriggerSettings, type TriggerTarget } from '../../shared/triggers.js';
import { requestedEffort, requestedModel } from '../providers/models.js';
import { appendAudit, changedFields, describeTrigger, logTrigger } from './audit.js';
import { failure } from './errors.js';
import { keptGitHub } from './github-cursor.js';
import { MAX_REVISIONS, MAX_TOMBSTONES } from './limits.js';
import { assertFuture, assertOnceRoom, assertRoom, projectConsumed } from './once.js';
import { nextSlot, validateSchedule } from './schedule.js';
import type { SecretStore } from './secrets.js';
import { writeRows, removeRows, recordIndexedReplacement, UNFINISHED, type EngineState } from './state.js';
import type { TriggerStore } from './store.js';

/**
 * How a controlling computer reaches this computer's triggers (server/api/remote-view.ts). What it may not see reads
 * exactly as absent, refused at the same step as a trigger, revision or folder that is not there.
 */
export interface TriggerScope {
  /** Whether it may see a trigger, or a revision of one, that does this. */
  handler(handler: TriggerHandler): boolean;
  /** Whether it may aim a trigger at this. */
  target(target: TriggerTarget): boolean;
}
export const COORDINATOR_HERE = 'GitHub coordinator triggers are created, changed and run on that computer itself.';
export const seen = (trigger: Pick<Trigger, 'handler'>, scope?: TriggerScope) => !scope || scope.handler(trigger.handler);
/** From a controlling computer a coordinator trigger is only turned off or deleted. */
export const hereOnly = (trigger: Pick<Trigger, 'handler'>, scope?: TriggerScope) => { if (scope && trigger.handler.kind === 'coordinator') throw failure(COORDINATOR_HERE, 'forbidden'); };

/** A change from a controlling computer marks the trigger as that computer's; a change made here clears it. */
export const remoteMark = (actor: TriggerActor): Pick<Trigger, 'remoteEdited'> => actor.controllerId ? { remoteEdited: { controllerId: actor.controllerId } } : {};
export const unmarked = <T extends Trigger>({ remoteEdited: _, ...trigger }: T): Omit<T, 'remoteEdited'> => trigger;

/**
 * The trigger definitions: creating, changing, turning on and off, archiving, deleting and bringing back, with their
 * revisions, secret grants, trusted folders and audit entries, and the owner's settings and secrets. Each operation is
 * one store commit; its checks run inside it, on the state being saved.
 */
export class TriggerDefinitions {
  constructor(private readonly store: TriggerStore, private readonly secrets: SecretStore, private readonly now: () => number,
    /** The agent session a session target names. */
    private readonly sessionOf: (id: string) => Session | undefined) {}

  // ---- Changing definitions ---------------------------------------------------------------------

  async create(value: unknown, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> {
    const input = await this.validate(value, scope);
    hereOnly(input, scope);
    return this.store.mutate({ type: 'definition', id: '' },state => {
      assertRoom(state);
      assertFuture(input, this.now);
      assertOnceRoom(state, input);
      const now = new Date(this.now()).toISOString();
      const trigger: Trigger = { ...input, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor, ...remoteMark(actor) };
      this.guardAutoReply(trigger, undefined, actor, 'refuse');
      this.grantSecrets(state, trigger, actor);
      state.triggers.push(trigger); writeRows(state,'triggers',trigger.id);
      this.schedule(state, trigger);
      this.trust(state, trigger, actor);
      this.log(state, actor, 'create', trigger, undefined, 1, `Created ${describeTrigger(trigger)}`);
      return structuredClone(trigger);
    });
  }

  async update(id: string, value: unknown, expectedRevision: number, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> {
    const input = await this.validate(value, scope);
    return this.store.mutate({ type: 'definition', id },state => {
      const current = this.revisionOf(state, id, expectedRevision, scope);
      hereOnly(current, scope); hereOnly(input, scope);
      this.guardAutoReply({ ...current, ...structuredClone(input) }, current, actor, 'refuse');
      const next = this.replace(state, current, { ...input }, actor);
      this.log(state, actor, 'update', next, current.revision, next.revision, `Changed ${changedFields(current, next)}`);
      return structuredClone(next);
    });
  }

  async setEnabled(id: string, enabled: boolean, expectedRevision: number, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> {
    // Turning off must work even when history is full; it may use the space kept for settling.
    return this.store.mutate({ type: 'definition', id },state => {
      const current = this.revisionOf(state, id, expectedRevision, scope);
      if (enabled) {
        hereOnly(current, scope);
        if (state.onceConsumed[id]) throw failure('This once reservation was consumed. Create a new reservation to retry.', 'conflict');
        if (current.archivedAt) throw failure('Unarchive this trigger before enabling it.', 'conflict');
        assertFuture(current, this.now);
      }
      // A toggle keeps no copy of the definition in history, so it never runs out of space; the audit records it.
      // Turning it on or off is a change too: from a controlling computer it marks the trigger, from here it clears it.
      const next: Trigger = { ...unmarked(current), enabled, revision: current.revision + 1, updatedAt: new Date(this.now()).toISOString(), updatedBy: actor, ...remoteMark(actor) };
      state.triggers = state.triggers.map(item => item.id === id ? next : item);
      if (enabled && !current.enabled) this.schedule(state, next);
      if (!enabled) this.turnedOff(state, id);
      // Turning a trigger on again also lifts an automatic pause.
      if (enabled && state.cursors[id]?.paused) delete state.cursors[id].paused;
      this.log(state, actor, enabled ? 'enable' : 'disable', next, current.revision, next.revision, enabled ? 'Turned on' : 'Turned off');
      return structuredClone(next);
    }, enabled ? 'grow' : 'settle');
  }

  async setArchived(id: string, archived: boolean, expectedRevision: number, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> {
    return this.store.mutate({ type: 'definition', id },state => {
      const current = this.revisionOf(state, id, expectedRevision, scope);
      if (Boolean(current.archivedAt) === archived) return structuredClone(current);
      if (state.events.some(event => event.triggerId === id && UNFINISHED.has(event.status))) throw failure('This trigger has unfinished work; wait for it to finish before archiving or unarchiving.', 'conflict');
      if (!archived) { hereOnly(current, scope); assertRoom(state, true); }
      const next: Trigger = { ...unmarked(current), enabled: false, revision: current.revision + 1, updatedAt: new Date(this.now()).toISOString(), updatedBy: actor, ...remoteMark(actor) };
      if (archived) next.archivedAt = next.updatedAt; else delete next.archivedAt;
      state.triggers = state.triggers.map(item => item.id === id ? next : item);
      this.turnedOff(state, id);
      delete state.cursors[id].nextAt;
      this.log(state, actor, archived ? 'archive' : 'unarchive', next, current.revision, next.revision, archived ? 'Archived; history retained' : 'Unarchived, turned off; a consumed reservation cannot run again');
      return structuredClone(next);
    }, 'settle');
  }

  /** Returns what was deleted. */
  async remove(id: string, expectedRevision: number, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> {
    return this.store.mutate({ type: 'definition', id },state => {
      const current = this.revisionOf(state, id, expectedRevision, scope);
      removeRows(state,'triggers',id);
      state.triggers = state.triggers.filter(trigger => trigger.id !== id);
      removeRows(state,'tombstones',...state.tombstones.slice(0,Math.max(0,state.tombstones.length + 1 - MAX_TOMBSTONES)).map(item => item.id));
      writeRows(state,'tombstones',current.id);
      state.tombstones = [...state.tombstones, current].slice(-MAX_TOMBSTONES);
      // The cursor keeps the moment of deletion, so a restored trigger never starts runs fired before it.
      this.cancelQueued(state, id, 'The trigger was deleted before this ran.');
      writeRows(state,'cursors',id);
      state.cursors[id] = { anchorAt: this.now(), turnedOffAt: this.now() };
      this.log(state, actor, 'delete', current, current.revision, undefined, `Deleted ${describeTrigger(current)}`);
      return structuredClone(current);
    }, 'settle');
  }

  /** A revert is a new revision that copies an earlier one; history is never rewritten. */
  async revert(id: string, revision: number, expectedRevision: number, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> {
    return this.store.mutate({ type: 'definition', id },state => {
      const current = this.revisionOf(state, id, expectedRevision, scope);
      hereOnly(current, scope);
      const earlier = (state.revisions[id] ?? []).find(item => item.revision === revision);
      if (!earlier || !seen(earlier, scope)) throw failure(`Revision ${revision} is no longer kept. Only the last ${MAX_REVISIONS} revisions can be restored.`, 'not-found');
      hereOnly(earlier, scope);
      const restored = structuredClone(this.inputOf(earlier));
      const note = this.guardAutoReply({ ...current, ...restored }, current, actor, 'strip') ?? '';
      const next = this.replace(state, current, restored, actor);
      this.log(state, actor, 'revert', next, current.revision, next.revision, `Restored revision ${revision}${note}`);
      return structuredClone(next);
    });
  }

  async restore(id: string, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> {
    return this.store.mutate({ type: 'definition', id },state => {
      const deleted = [...state.tombstones].reverse().find(item => item.id === id);
      if (!deleted || !seen(deleted, scope)) throw failure('This deleted trigger is no longer kept.', 'not-found');
      hereOnly(deleted, scope);
      if (state.triggers.some(item => item.id === id)) throw failure('This trigger already exists.', 'conflict');
      assertRoom(state, false, Boolean(deleted.archivedAt));
      const now = new Date(this.now()).toISOString();
      // Restored from a controlling computer, it is that computer's to run; restored here, it is this computer's again.
      const trigger: Trigger = { ...unmarked(structuredClone(deleted)), revision: deleted.revision + 1, updatedAt: now, updatedBy: actor, enabled: false, ...remoteMark(actor) };
      const note = this.guardAutoReply(trigger, undefined, actor, 'strip') ?? '';
      assertOnceRoom(state, trigger, trigger.id);
      this.grantSecrets(state, trigger, actor);
      state.triggers.push(trigger); writeRows(state,'triggers',trigger.id);
      projectConsumed(state,trigger);
      removeRows(state,'tombstones',deleted.id);
      state.tombstones = state.tombstones.filter(item => item !== deleted);
      this.schedule(state, trigger);
      this.log(state, actor, 'restore', trigger, deleted.revision, trigger.revision, `Restored after deletion, turned off${note}`);
      return structuredClone(trigger);
    });
  }

  async updateSettings(value: unknown, actor: TriggerActor): Promise<TriggerSettings> {
    if (actor.kind !== 'owner') throw failure('Only the owner can change trigger limits.', 'forbidden');
    const settings = TriggerSettingsSchema.parse(value);
    const saved = await this.store.mutate({ type: 'settings' },state => {
      state.settings = settings;
      appendAudit(state, this.now, { actor, action: 'settings', triggerId: '', triggerName: '', summary: `Limits: ${JSON.stringify(settings)}` });
      return structuredClone(settings);
    });
    return saved;
  }

  /** Slack keeps its own files; its changes still appear in the shared audit log. */
  async recordSlack(actor: TriggerActor, slackId: string, summary: string): Promise<void> {
    await this.store.mutate({ type: 'audit' },state => {
      appendAudit(state, this.now, { actor, action: 'slack', triggerId: slackId, triggerName: 'Slack', summary });
    }).catch(() => {});
  }

  async createSecret(input: SecretInput, actor: TriggerActor): Promise<TriggerSecret> {
    if (actor.kind !== 'owner') throw failure('Only the owner can save secrets.', 'forbidden');
    const secret = await this.secrets.create(input, this.now());
    await this.store.mutate({ type: 'audit' },state => { this.note(state, actor, 'secret', `Saved secret "${secret.name}" for ${secret.origin}`); }).catch(() => {});
    return { ...secret, triggerIds: [] };
  }

  async deleteSecret(id: string, actor: TriggerActor): Promise<void> {
    if (actor.kind !== 'owner') throw failure('Only the owner can delete secrets.', 'forbidden');
    const secret = await this.secrets.remove(id);
    await this.store.mutate({ type: 'secretGrant', id },state => { removeRows(state,'secretGrants',id); delete state.secretGrants[id]; this.note(state, actor, 'secret', `Deleted secret "${secret.name}"`); }, 'settle').catch(() => {});
  }

  // ---- Helpers ------------------------------------------------------------------------------------

  /** Checks a definition; a target `scope` may not see reads exactly as one that is not there. */
  async validate(value: unknown, scope?: TriggerScope): Promise<TriggerInput> {
    const parsed = TriggerInputSchema.safeParse(value);
    if (!parsed.success) throw failure(`Invalid trigger: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'trigger'}: ${issue.message}`).join('; ')}`);
    const input = parsed.data;
    validateSchedule(input.source.schedule);
    if (input.handler.kind === 'coordinator') {
      if (input.source.kind !== 'github') throw failure('A coordinator answers where the event came from; it is available for GitHub triggers.');
      if (new Set(input.handler.rules.map(rule => rule.id)).size !== input.handler.rules.length) throw failure('Each coordinator rule needs its own id.');
      for (const rule of input.handler.rules) requestedModel(rule.model);
      return input;
    }
    requestedModel(input.handler.model);
    requestedEffort(input.handler.effort, input.handler.provider);
    const target = input.handler.target;
    const shown = !scope || scope.target(target);
    if (carriesOutsideContent(input.source) && target.mode === 'session') throw failure('Triggers that bring outside content always start a new session. Choose a folder or Auto Prompt instead of an existing session.');
    if (target.mode === 'folder' && !(shown && await stat(target.cwd).then(info => info.isDirectory(), () => false))) throw failure(`The folder ${target.cwd} does not exist. Tower does not create folders for triggers.`);
    if (target.mode === 'session') {
      const session = shown ? this.sessionOf(target.sessionId) : undefined;
      if (!session) throw failure('The chosen session was not found.');
      if (session.provider !== input.handler.provider) throw failure(`The chosen session is a ${session.provider} session; choose ${session.provider} as the agent.`);
    }
    return input;
  }

  revisionOf(state: EngineState, id: string, expected: number, scope?: TriggerScope): Trigger {
    const current = state.triggers.find(item => item.id === id);
    if (!current || !seen(current, scope)) throw failure('Trigger not found.', 'not-found');
    if (!Number.isInteger(expected) || current.revision !== expected) throw failure(`The trigger changed (now revision ${current.revision}). Reload it and try again.`, 'conflict');
    return current;
  }

  inputOf(trigger: Trigger): TriggerInput {
    return { name: trigger.name, enabled: trigger.enabled, source: trigger.source, handler: trigger.handler, policy: trigger.policy };
  }

  replace(state: EngineState, current: Trigger, input: TriggerInput, actor: TriggerActor): Trigger {
    if (state.onceConsumed[current.id] && (input.enabled || JSON.stringify(current.source) !== JSON.stringify(input.source))) throw failure('This once reservation was consumed. Create a new reservation to retry or change its schedule.', 'conflict');
    if (current.archivedAt && input.enabled) throw failure('Unarchive this trigger before enabling it.', 'conflict');
    if (JSON.stringify(current.source.schedule) !== JSON.stringify(input.source.schedule) || (!current.enabled && input.enabled)) assertFuture(input, this.now);
    if (JSON.stringify(current.source) !== JSON.stringify(input.source)) assertOnceRoom(state, input, current.id);
    const next: Trigger = { ...unmarked(current), ...structuredClone(input), revision: current.revision + 1, updatedAt: new Date(this.now()).toISOString(), updatedBy: actor, ...remoteMark(actor) };
    this.grantSecrets(state, next, actor);
    writeRows(state,'revisions',current.id); writeRows(state,'triggers',current.id);
    state.revisions[current.id] = [...(state.revisions[current.id] ?? []), current].slice(-MAX_REVISIONS);
    state.triggers = state.triggers.map(item => item.id === current.id ? next : item);
    const sameOnce = current.source.kind === 'schedule' && next.source.kind === 'schedule' && current.source.schedule.type === 'once' && next.source.schedule.type === 'once' && current.source.schedule.at === next.source.schedule.at;
    if ((!sameOnce && JSON.stringify(current.source) !== JSON.stringify(next.source)) || (!current.enabled && next.enabled)) {
      const kept = current.enabled && next.enabled ? keptGitHub(current, next, state.cursors[current.id]) : undefined;
      this.schedule(state, next);
      if (kept) state.cursors[current.id].github = kept;
    }
    // However a trigger is turned off (toggle, edit or revert), waiting runs do not start; running ones continue.
    if (current.enabled && !next.enabled) this.turnedOff(state, current.id);
    this.trust(state, next, actor);
    return next;
  }

  /** Schedules count from now: changing a schedule never catches up on times before the change. */
  schedule(state: EngineState, trigger: Trigger): void {
    const now = this.now();
    const previous = state.cursors[trigger.id];
    writeRows(state,'cursors',trigger.id);
    state.cursors[trigger.id] = { anchorAt: now, nextAt: !trigger.enabled || state.onceConsumed[trigger.id] ? undefined : nextSlot(trigger.source.schedule, now, now), ...(previous?.lastSlot !== undefined ? { lastSlot: previous.lastSlot } : {}),
      ...(previous?.paused ? { paused: previous.paused } : {}), ...(previous?.turnedOffAt !== undefined ? { turnedOffAt: previous.turnedOffAt } : {}),
      // A rate limit belongs to GitHub, not to the definition: editing or turning a GitHub trigger on does not lift it.
      ...(trigger.source.kind === 'github' && previous?.blockedUntil !== undefined && previous.blockedUntil > now ? { blockedUntil: previous.blockedUntil } : {}) };
  }

  trust(state: EngineState, trigger: Trigger, actor: TriggerActor): void {
    if (trigger.handler.kind !== 'task') return;
    const target = trigger.handler.target;
    if (actor.kind === 'owner' && target.mode === 'folder' && !state.trustedFolders.includes(target.cwd)) {
      const previousLength = state.trustedFolders.length;
      state.trustedFolders = [...state.trustedFolders,target.cwd].slice(-200);
      recordIndexedReplacement(state,'trustedFolders',previousLength,previousLength < 200 ? previousLength : 0);
    }
  }

  /** Runs fired before this moment never start, even if the trigger is turned on again before they would. */
  turnedOff(state: EngineState, id: string): void {
    this.cancelQueued(state, id, 'The trigger was turned off before this ran.');
    writeRows(state,'cursors',id);
    state.cursors[id] = { ...(state.cursors[id] ?? { anchorAt: this.now() }), turnedOffAt: this.now() };
  }

  cancelQueued(state: EngineState, id: string, reason: string): void {
    for (const event of state.events) if (event.triggerId === id && event.status === 'queued') {
      writeRows(state,'events',event.id);
      Object.assign(event, { status: 'cancelled',reason,updatedAt: new Date(this.now()).toISOString() });
    }
  }

  /**
   * Secret headers go only where the owner sent them. An owner's save gives this trigger the secret; an agent
   * can keep only secrets the owner already gave this trigger, never add one.
   */
  grantSecrets(state: EngineState, trigger: Trigger, actor: TriggerActor): void {
    if (trigger.source.kind === 'github') { this.grantGitHub(state, trigger, actor); return; }
    if (trigger.source.kind !== 'http') return;
    const request = trigger.source.request;
    const origin = new URL(request.url).origin;
    // A request that carries secrets is the owner's: an agent may keep it exactly (or bring back one kept in
    // history), but not point it at another path or header of the same origin.
    if (actor.kind !== 'owner' && request.headers.some(header => 'secretId' in header)) {
      const accepted = [...state.triggers, ...(state.revisions[trigger.id] ?? []), ...state.tombstones].filter(item => item.id === trigger.id)
        .some(item => item.source.kind === 'http' && JSON.stringify(item.source.request) === JSON.stringify(request));
      if (!accepted) throw failure('Only the owner can change a request that sends saved secrets. Ask the owner to make this change in Tower.', 'forbidden');
    }
    for (const header of request.headers) {
      if (!('secretId' in header)) continue;
      const secret = this.secrets.get(header.secretId);
      if (!secret) throw failure(`The secret chosen for the ${header.name} header no longer exists.`);
      if (secret.origin !== origin) throw failure(`The secret "${secret.name}" is only sent to ${secret.origin}; this trigger calls ${origin}.`);
      const granted = state.secretGrants[secret.id] ?? [];
      if (granted.includes(trigger.id)) continue;
      if (actor.kind !== 'owner') throw failure(`Only the owner can give the secret "${secret.name}" to a trigger. Ask the owner to choose it in Tower.`, 'forbidden');
      writeRows(state,'secretGrants',secret.id);
      state.secretGrants[secret.id] = [...granted, trigger.id];
    }
  }

  /**
   * A rule's automatic reply is the owner's standing permission to post (D1). An agent can keep one the owner
   * set, on an unchanged rule, but never turn one on: creating or changing it is refused, and bringing back an
   * earlier revision or a deleted trigger turns such replies off, noted in the audit log.
   */
  guardAutoReply(next: Trigger, before: Trigger | undefined, actor: TriggerActor, mode: 'refuse' | 'strip'): string | undefined {
    if (actor.kind === 'owner' || next.handler.kind !== 'coordinator') return undefined;
    const kept = (rule: CoordinatorRule) => before?.handler.kind === 'coordinator' && before.handler.rules.some(item => item.id === rule.id && item.autoReply === true
      && JSON.stringify({ ...item, enabled: undefined }) === JSON.stringify({ ...rule, enabled: undefined }));
    const added = next.handler.rules.filter(rule => rule.autoReply && !kept(rule));
    if (!added.length) return undefined;
    if (mode === 'refuse') throw failure('Only the owner can turn on automatic replies for a coordinator rule, or change a rule that has them. Ask the owner to make this change in Tower.', 'forbidden');
    for (const rule of added) delete rule.autoReply;
    return ` (automatic replies turned off for ${added.map(rule => `"${rule.name}"`).join(', ')}: only the owner can turn them on)`;
  }

  /** A GitHub token is the owner's to give; an agent may keep a token-based source only exactly as accepted. */
  grantGitHub(state: EngineState, trigger: Trigger, actor: TriggerActor): void {
    if (trigger.source.kind !== 'github' || trigger.source.auth.type !== 'token') return;
    const secret = this.secrets.get(trigger.source.auth.secretId);
    if (!secret) throw failure('The GitHub token secret no longer exists.');
    if (secret.origin !== GITHUB_API) throw failure(`The secret "${secret.name}" is not saved for ${GITHUB_API}.`);
    const granted = state.secretGrants[secret.id] ?? [];
    if (actor.kind !== 'owner') {
      const source = JSON.stringify(trigger.source);
      const accepted = [...state.triggers, ...(state.revisions[trigger.id] ?? []), ...state.tombstones].some(item => item.id === trigger.id && JSON.stringify(item.source) === source);
      if (!accepted || !granted.includes(trigger.id)) throw failure('Only the owner can set up or change a GitHub trigger that uses a saved token. Ask the owner to make this change in Tower.', 'forbidden');
      return;
    }
    if (!granted.includes(trigger.id)) { writeRows(state,'secretGrants',secret.id); state.secretGrants[secret.id] = [...granted, trigger.id]; }
  }

  private note(state: EngineState, actor: TriggerActor, action: 'secret', summary: string): void {
    appendAudit(state, this.now, { actor, action, triggerId: '', triggerName: '', summary: summary.slice(0, 500) });
  }

  log(state: EngineState, actor: TriggerActor, action: TriggerAuditEntry['action'], trigger: Trigger, fromRevision: number | undefined, toRevision: number | undefined, summary: string): void {
    logTrigger(state, this.now, actor, action, trigger, fromRevision, toRevision, summary);
  }
}
