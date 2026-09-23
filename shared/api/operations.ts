import { z } from 'zod';
import { ScheduleSchema, TriggerInputSchema, TriggerSettingsSchema } from '../triggers.js';

const id = z.string().min(1).max(200);
const revision = z.number().int().min(1);
const page = { before: z.string().max(40).optional(), limit: z.number().int().min(1).max(200).optional() };

/**
 * Every Tower operation that the web API (and later agent tools) can call. One schema per operation
 * validates input the same way on every path; the worker applies ownership and history rules.
 */
export const OPERATIONS = {
  'triggers.list': { input: z.object({}).strict(), write: false, summary: 'List triggers with their state and recent runs.' },
  'triggers.get': { input: z.object({ id }).strict(), write: false, summary: 'Read one trigger with its earlier revisions and recent runs.' },
  'triggers.events': { input: z.object({ triggerId: id.optional(), ...page }).strict(), write: false, summary: 'Read trigger runs, newest first.' },
  'triggers.audit': { input: z.object(page).strict(), write: false, summary: 'Read who changed triggers and how, newest first.' },
  'triggers.deleted': { input: z.object({}).strict(), write: false, summary: 'List recently deleted triggers that can be restored.' },
  'triggers.preview': { input: z.object({ schedule: ScheduleSchema }).strict(), write: false, summary: 'Show the next five times a schedule would run.' },
  'triggers.create': { input: z.object({ trigger: TriggerInputSchema }).strict(), write: true, summary: 'Create a trigger. It takes effect immediately.' },
  'triggers.update': { input: z.object({ id, expectedRevision: revision, trigger: TriggerInputSchema }).strict(), write: true, summary: 'Replace a trigger’s configuration as a new revision.' },
  'triggers.setEnabled': { input: z.object({ id, expectedRevision: revision, enabled: z.boolean() }).strict(), write: true, summary: 'Turn a trigger on or off.' },
  'triggers.delete': { input: z.object({ id, expectedRevision: revision }).strict(), write: true, summary: 'Delete a trigger. It can be restored for a while.' },
  'triggers.restore': { input: z.object({ id }).strict(), write: true, summary: 'Restore a deleted trigger, turned off.' },
  'triggers.revert': { input: z.object({ id, expectedRevision: revision, revision }).strict(), write: true, summary: 'Restore an earlier revision as a new revision.' },
  'triggers.run': { input: z.object({ id }).strict(), write: true, summary: 'Run a trigger once now.' },
  'triggers.settings': { input: z.object({}).strict(), write: false, summary: 'Read trigger limits.' },
  'triggers.updateSettings': { input: z.object({ settings: TriggerSettingsSchema }).strict(), write: true, ownerOnly: true, summary: 'Change trigger limits.' },
} as const;

export type OperationName = keyof typeof OPERATIONS;
export const isOperationName = (value: unknown): value is OperationName => typeof value === 'string' && Object.hasOwn(OPERATIONS, value);
