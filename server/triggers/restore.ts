import { OnceConsumptionSchema, TriggerInputSchema, TriggerSettingsSchema, type OnceConsumption, type Trigger, type TriggerActor } from '../../shared/triggers.js';
import { changedFields, describeTrigger } from './audit.js';
import type { TriggerBackup } from './backup.js';
import type { TriggerDefinitions } from './definitions.js';
import { unmarked } from './definitions.js';
import { failure } from './errors.js';
import type { GitHubCursor } from './github.js';
import { mergeGitHub } from './github-cursor.js';
import { MAX_ONCE_RESERVATIONS, MAX_RETAINED_TRIGGERS, MAX_TOMBSTONES } from './limits.js';
import { admitCapacity, mergeConsumed, normalizeOnce } from './once.js';
import { decodeOnceTrigger } from './once-storage.js';
import type { SecretStore } from './secrets.js';
import { beginRowOperations, mergeRowOperations, writeRows, removeRows, orderRows, recordIndexedReplacement, empty, upgradeState } from './state.js';
import { mutationProjection, type TriggerStore } from './store.js';

export interface RestoreContext { store: TriggerStore; secrets: SecretStore; definitions: TriggerDefinitions; now: () => number }

/**
 * Makes a backup's triggers the definitions here, the way the owner's own edits would: an unchanged trigger keeps
 * its revision and schedule; a changed or new one gets a new revision and counts from now (never catching up); one
 * missing from the backup is deleted unless archived; local archive choices and their recovery grants stay. What either computer's GitHub watch already took is kept, so it is not taken
 * again; history stays. Settings, trusted folders and secret grants come from the backup.
 */
export async function restoreOwnerBackup(backup: TriggerBackup, context: RestoreContext & { started: boolean }): Promise<void> {
  const { store, secrets, definitions } = context;
  if (!context.started) throw failure('The trigger engine is not ready for an owner restore.', 'unavailable');
  if (!backup || !Array.isArray(backup.triggers) || !backup.secretGrants || typeof backup.secretGrants !== 'object') throw failure('Invalid trigger backup.');
  // A deferred restore must not remove current definitions until every referenced encrypted secret is ready.
  for (const id of Object.keys(backup.secretGrants)) if (!secrets.get(id)) throw failure('Import the original secret Vault before restoring its trigger grants.');
  const draft = { ...store.state,secretGrants: { ...store.state.secretGrants } };
  for (const value of backup.triggers) {
    if (!value || typeof value !== 'object' || typeof (value as Trigger).id !== 'string') throw failure('Invalid restored trigger.');
    const trigger = decodeOnceTrigger(value).trigger as Trigger;
    const parsed = TriggerInputSchema.safeParse({ name: trigger.name, enabled: trigger.enabled, source: trigger.source, handler: trigger.handler, policy: trigger.policy });
    if (!parsed.success) throw failure('Invalid restored trigger.');
    definitions.grantSecrets(draft, { ...trigger, ...parsed.data }, { kind: 'owner', via: 'ui' });
  }
  const errors = await restoreFrom(backup, context);
  if (errors.length) throw failure(errors.join(' '));
}

export async function restoreFrom(backup: TriggerBackup, context: RestoreContext): Promise<string[]> {
  const { store, secrets, definitions, now: clock } = context;
  const errors: string[] = [];
  const actor: TriggerActor = { kind: 'owner', via: 'ui' };
  const record = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item);
  const upgraded = upgradeState({ ...empty(), triggers: (Array.isArray(backup.triggers) ? backup.triggers : []) as Trigger[] }, clock()).triggers as unknown[];
  const consumed: Record<string, OnceConsumption> = { ...store.state.onceConsumed };
  if (backup.onceConsumed !== undefined) {
    if (!record(backup.onceConsumed)) throw failure('Invalid once consumption backup.');
    for (const [id, value] of Object.entries(backup.onceConsumed)) consumed[id] ??= OnceConsumptionSchema.parse(value);
  }
  for (const trigger of upgraded) if (record(trigger) && trigger.consumed !== undefined) consumed[trigger.id] ??= OnceConsumptionSchema.parse(trigger.consumed);
  if (Object.keys(consumed).length > MAX_ONCE_RESERVATIONS) throw failure('The restored once consumption records exceed the supported capacity. Existing records were preserved.', 'conflict');
  const incoming: Trigger[] = [];
  // Every id the backup names: one it names but cannot restore keeps its definition here rather than being removed.
  const named = new Set<string>();
  const settings = TriggerSettingsSchema.safeParse(backup.settings ?? {});
  if (!settings.success) errors.push('트리거 설정이 올바르지 않아 지금 설정을 유지했습니다.');
  for (const value of upgraded) if (record(value) && typeof value.id === 'string') named.add(value.id);
  // Triggers this computer keeps (named in the backup) count toward the limit; only new ones can be left out for it.
  const local = new Set(store.state.triggers.map(item => item.id));
  const room = (settings.success ? settings.data : store.state.settings).maxTriggers - store.state.triggers.filter(item => !item.archivedAt && named.has(item.id)).length;
  let added = 0;
  for (const value of upgraded) {
    const input = record(value) ? TriggerInputSchema.safeParse({ name: value.name, enabled: value.enabled, source: value.source, handler: value.handler, policy: value.policy }) : undefined;
    const name = record(value) && typeof value.name === 'string' ? value.name : '?';
    if (!record(value) || !input?.success || typeof value.id !== 'string' || !Number.isInteger(value.revision) || incoming.some(item => item.id === value.id)) {
      errors.push(`트리거 "${name}": 백업의 정의가 올바르지 않아 건너뛰었습니다.`);
      continue;
    }
    if (!local.has(value.id) && !value.archivedAt && !consumed[value.id] && added >= room) { errors.push(`트리거 "${name}": 트리거 개수 한도에 걸려 건너뛰었습니다.`); continue; }
    if (!local.has(value.id) && !value.archivedAt && !consumed[value.id]) added++;
    const trigger: Trigger = { ...(value as unknown as Trigger), ...input.data };
    if (consumed[trigger.id]) { trigger.enabled = false; trigger.consumed = { ...consumed[trigger.id] }; trigger.archivedAt ??= trigger.consumed.at; }
    else if (trigger.source.schedule.type === 'once' && Date.parse(trigger.source.schedule.at) <= clock()) {
      trigger.enabled = false;
      errors.push(`Trigger "${name}" was restored turned off because its once reservation is in the past.`);
    }
    if (trigger.archivedAt && trigger.enabled) delete trigger.archivedAt;
    // What this computer lacks (a folder, a conversation) keeps it from running here: it comes in turned off.
    const problem = await definitions.validate({ name: trigger.name, enabled: trigger.enabled, source: trigger.source, handler: trigger.handler, policy: trigger.policy }).then(() => undefined, error => error instanceof Error ? error.message : String(error));
    if (problem && trigger.enabled) { trigger.enabled = false; errors.push(`트리거 "${name}": 꺼서 복원했습니다. ${problem}`); }
    incoming.push(trigger);
  }
  if (incoming.length > MAX_RETAINED_TRIGGERS || new Set([...Object.keys(consumed), ...incoming.filter(item => item.source.schedule.type === 'once').map(item => item.id)]).size > MAX_ONCE_RESERVATIONS) throw failure('The restored reservation definitions exceed the supported capacity. Existing records were preserved.', 'conflict');
  const same = (a: Trigger, b: Trigger) => (['name', 'enabled', 'source', 'handler', 'policy', 'archivedAt', 'consumed'] as const).every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]));
  await store.mutate({ type: 'restore' },state => {
    const now = new Date(clock()).toISOString();
    mergeConsumed(state, consumed);
    normalizeOnce(state, clock);
    if (settings.success) { state.settings = settings.data; writeRows(state,'settings','settings'); }
    const localGrants = structuredClone(state.secretGrants), localTrusted = [...state.trustedFolders];
    // Grants of secrets that exist here; the restored triggers below add any they need.
    removeRows(state,'secretGrants',...Object.keys(state.secretGrants));
    orderRows(state,'secretGrants',0);
    state.secretGrants = Object.fromEntries(Object.entries(record(backup.secretGrants) ? backup.secretGrants : {})
      .filter(([id, ids]) => secrets.get(id) && Array.isArray(ids)).map(([id, ids]) => [id, ids.filter(item => typeof item === 'string')]));
    writeRows(state,'secretGrants',...Object.keys(state.secretGrants));
    /** Triggers the backup names whose definition stays this computer's (not readable, over the limit, or refused below). */
    const keptHere = new Set<string>();
    const wanted = new Set([...named, ...incoming.map(item => item.id)]);
    for (const current of [...state.triggers]) {
      if (wanted.has(current.id)) continue;
      if (current.archivedAt) { keptHere.add(current.id); continue; }
      removeRows(state,'triggers',current.id);
      state.triggers = state.triggers.filter(item => item.id !== current.id);
      removeRows(state,'tombstones',...state.tombstones.slice(0,Math.max(0,state.tombstones.length + 1 - MAX_TOMBSTONES)).map(item => item.id));
      writeRows(state,'tombstones',current.id);
      state.tombstones = [...state.tombstones, current].slice(-MAX_TOMBSTONES);
      definitions.cancelQueued(state, current.id, 'The trigger was removed by a restore before this ran.');
      writeRows(state,'cursors',current.id);
      state.cursors[current.id] = { anchorAt: clock(), turnedOffAt: clock() };
      definitions.log(state, actor, 'delete', current, current.revision, undefined, `Removed by restoring a backup: ${describeTrigger(current)}`);
    }
    for (const id of named) if (!incoming.some(item => item.id === id)) keptHere.add(id);
    for (const saved of incoming) {
      const trigger = structuredClone(saved);
      const current = state.triggers.find(item => item.id === trigger.id);
      // A backup cannot undo this computer's explicit archive/unarchive choice.
      if (current) {
        delete trigger.archivedAt;
        if (current.archivedAt) { trigger.archivedAt = current.archivedAt; trigger.enabled = false; }
      }
      if (state.onceConsumed[trigger.id]) {
        trigger.enabled = false; trigger.consumed = { ...state.onceConsumed[trigger.id] };
        if (!current) trigger.archivedAt ??= trigger.consumed.at;
      }
      if (current && same(current, trigger)) continue;
      const draft = mutationProjection(state,{ type: 'definition',id: trigger.id });
      const operations = beginRowOperations(draft);
      try {
        if (current) {
          const next = definitions.replace(draft, current, { name: trigger.name, enabled: trigger.enabled, source: trigger.source, handler: trigger.handler, policy: trigger.policy }, actor);
          if (trigger.archivedAt) next.archivedAt = trigger.archivedAt;
          if (state.onceConsumed[trigger.id]) next.consumed = { ...state.onceConsumed[trigger.id] };
          // A restored definition counts from now: times missed before the restore never run with it.
          // What its source observed (GitHub history, an HTTP condition's state) stays: only the timing starts over.
          if (next.enabled) { const { failures: _failures, lastError: _error, ...previous } = draft.cursors[next.id] ?? { anchorAt: clock() }; definitions.schedule(draft, next); draft.cursors[next.id] = { ...previous, ...draft.cursors[next.id]! }; }
          definitions.log(draft, actor, 'restore', next, current.revision, next.revision, `Restored from a backup: ${changedFields(current, next)}`);
        } else {
          const earlier = [...draft.tombstones, ...(draft.revisions[trigger.id] ?? [])].filter(item => item.id === trigger.id).reduce((max, item) => Math.max(max, item.revision), 0);
          const next: Trigger = { ...unmarked(trigger), revision: Math.max(trigger.revision, earlier) + 1, createdAt: typeof trigger.createdAt === 'string' ? trigger.createdAt : now, updatedAt: now,
            createdBy: record(trigger.createdBy) ? trigger.createdBy : actor, updatedBy: actor };
          definitions.grantSecrets(draft, next, actor);
          removeRows(draft,'tombstones',next.id);
          draft.tombstones = draft.tombstones.filter(item => item.id !== next.id);
          draft.triggers.push(next); writeRows(draft,'triggers',next.id);
          definitions.schedule(draft, next);
          if (!next.enabled) delete draft.cursors[next.id].nextAt;
          definitions.trust(draft, next, actor);
          definitions.log(draft, actor, 'restore', next, undefined, next.revision, `Restored from a backup: ${describeTrigger(next)}`);
        }
        Object.assign(state, draft); mergeRowOperations(state,operations);
      } catch (error) {
        errors.push(`트리거 "${trigger.name}": ${error instanceof Error ? error.message : String(error)}`);
        keptHere.add(trigger.id);
      }
    }
    // A trigger that keeps its definition here keeps what the owner gave it here too: its secrets and its folder's trust.
    const kept = state.triggers.filter(item => keptHere.has(item.id));
    for (const [id, ids] of Object.entries(localGrants)) for (const trigger of kept) if (secrets.get(id) && ids.includes(trigger.id)) {
      state.secretGrants[id] = [...new Set([...(state.secretGrants[id] ?? []),trigger.id])]; writeRows(state,'secretGrants',id);
    }
    const keptFolders = kept.flatMap(item => item.handler.kind === 'task' && item.handler.target.mode === 'folder' && localTrusted.includes(item.handler.target.cwd) ? [item.handler.target.cwd] : []);
    const trusted = [...new Set([...(Array.isArray(backup.trustedFolders) ? backup.trustedFolders : []).filter(item => typeof item === 'string'), ...keptFolders])].slice(-200);
    // Either computer's GitHub history counts, as far as it belongs to the restored definition.
    for (const trigger of state.triggers) {
      const saved = record(backup.github) ? backup.github[trigger.id] : undefined;
      if (trigger.source.kind !== 'github' || !incoming.some(item => item.id === trigger.id && same(item, trigger)) || !record(saved)) continue;
      writeRows(state,'cursors',trigger.id);
      const cursor = state.cursors[trigger.id] ??= { anchorAt: clock() };
      const github = mergeGitHub(cursor.github, saved as GitHubCursor);
      if (github) cursor.github = github;
    }
    if (record(backup.fired)) for (const id of Object.keys(backup.fired)) if (!(id in state.fired)) writeRows(state,'fired',id);
    orderRows(state,'fired',0);
    state.fired = { ...(record(backup.fired) ? backup.fired : {}), ...state.fired };
    normalizeOnce(state, clock);
    // Preflight validation yields; the guarded SQL batch is the admission authority.
    admitCapacity(state);
    // Restoring trusts exactly the folders the backup trusted (and those of triggers kept here), nothing its triggers add.
    const previousTrustedLength = state.trustedFolders.length;
    state.trustedFolders = trusted; recordIndexedReplacement(state,'trustedFolders',previousTrustedLength);
  }, 'settle');
  return errors;
}
