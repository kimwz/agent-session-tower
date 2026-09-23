import { OPERATIONS, isOperationName } from '../../shared/api/operations.js';
import type { TriggerActor } from '../../shared/triggers.js';
import type { TriggerService } from '../triggers/service.js';

const failure = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/**
 * The single entry point for Tower operations in the worker. Callers never choose their own actor:
 * the transport that authenticated them does, and owner-only operations check it here.
 */
export class TowerApi {
  constructor(private readonly services: { triggers: TriggerService }) {}

  async call(name: unknown, input: unknown, actor: TriggerActor): Promise<unknown> {
    if (!isOperationName(name)) throw failure('Unknown Tower operation.', 404);
    const operation = OPERATIONS[name];
    if ('ownerOnly' in operation && operation.ownerOnly && actor.kind !== 'owner') throw failure('Only the owner can do this in Tower.', 403);
    const parsed = operation.input.safeParse(input ?? {});
    if (!parsed.success) throw failure(`Invalid request: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`, 400);
    const value = parsed.data as Record<string, any>;
    const triggers = this.services.triggers;
    switch (name) {
      case 'triggers.list': return { triggers: triggers.list(), overview: triggers.overview() };
      case 'triggers.get': return triggers.get(value.id);
      case 'triggers.events': return { events: triggers.events(value) };
      case 'triggers.audit': return { audit: triggers.audit(value) };
      case 'triggers.deleted': return { triggers: triggers.deleted() };
      case 'triggers.preview': return { runs: triggers.preview(value.schedule) };
      case 'triggers.create': return { trigger: await triggers.create(value.trigger, actor) };
      case 'triggers.update': return { trigger: await triggers.update(value.id, value.trigger, value.expectedRevision, actor) };
      case 'triggers.setEnabled': return { trigger: await triggers.setEnabled(value.id, value.enabled, value.expectedRevision, actor) };
      case 'triggers.delete': await triggers.remove(value.id, value.expectedRevision, actor); return { deleted: true };
      case 'triggers.restore': return { trigger: await triggers.restore(value.id, actor) };
      case 'triggers.revert': return { trigger: await triggers.revert(value.id, value.revision, value.expectedRevision, actor) };
      case 'triggers.run': return { event: await triggers.run(value.id, actor) };
      case 'triggers.settings': return { settings: triggers.settings() };
      case 'triggers.updateSettings': return { settings: await triggers.updateSettings(value.settings, actor) };
    }
  }
}
