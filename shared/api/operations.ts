import { z } from 'zod';
import { ScheduleSchema, TriggerInputSchema, TriggerSettingsSchema } from '../triggers.js';

const id = z.string().min(1).max(200);
const uuid = z.string().regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i, 'A UUID is required.');
const revision = z.number().int().min(1);
const page = { before: z.string().max(40).optional(), limit: z.number().int().min(1).max(200).optional() };

/**
 * Every Tower operation that the web API and agent tools can call. One schema per operation validates
 * input the same way on every path; the worker applies ownership and history rules.
 * `agent` operations are offered to agents in turns the owner starts from Tower. Every changing operation an
 * agent calls is recorded under a key (its `requestKey`, or the field named by `keyField`), so a retried
 * call returns the first result instead of acting twice.
 */
export const OPERATIONS = {
  'sessions.list': { input: z.object({ provider: z.enum(['claude', 'codex']).optional(), cwd: z.string().max(4096).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(), write: false, agent: true,
    summary: 'List Tower sessions (most recent first) with their folder, status and whether a trigger created them.' },
  'sessions.read': { input: z.object({ id, limit: z.number().int().min(1).max(100).optional() }).strict(), write: false, agent: true,
    summary: 'Read the most recent messages of a Tower session.' },
  'projects.list': { input: z.object({}).strict(), write: false, agent: true, summary: 'List the project folders Tower knows, with their names and how many sessions each has.' },
  'runs.list': { input: z.object({ sessionId: id.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), write: false, agent: true,
    summary: 'List recent Tower runs with their status, origin and the end of their output.' },
  'autoPrompt.submit': { input: z.object({ requestId: uuid, provider: z.enum(['claude', 'codex']), prompt: z.string().min(1).max(32_000), cwd: z.string().max(4096).optional(),
    model: z.string().max(200).optional(), effort: z.string().max(40).optional() }).strict(), write: true, agent: true, keyField: 'requestId',
    summary: 'Hand a task to the right project agent through Auto Prompt. The requestId identifies the request: reuse it to retry or check, never for a different task.' },
  'autoPrompt.get': { input: z.object({ requestId: uuid }).strict(), write: false, agent: true, summary: 'Read an Auto Prompt request and the run it started.' },
  'triggers.list': { input: z.object({}).strict(), write: false, agent: true, summary: 'List triggers with their state and recent runs.' },
  'triggers.get': { input: z.object({ id }).strict(), write: false, agent: true, summary: 'Read one trigger with its earlier revisions and recent runs.' },
  'triggers.events': { input: z.object({ triggerId: id.optional(), ...page }).strict(), write: false, agent: true, summary: 'Read trigger runs, newest first.' },
  'triggers.audit': { input: z.object(page).strict(), write: false, agent: true, summary: 'Read who changed triggers and how, newest first.' },
  'triggers.deleted': { input: z.object({}).strict(), write: false, agent: true, summary: 'List recently deleted triggers that can be restored.' },
  'triggers.preview': { input: z.object({ schedule: ScheduleSchema }).strict(), write: false, agent: true, summary: 'Show the next five times a schedule would run.' },
  'triggers.create': { input: z.object({ trigger: TriggerInputSchema }).strict(), write: true, agent: true, summary: 'Create a trigger. It takes effect immediately.' },
  'triggers.update': { input: z.object({ id, expectedRevision: revision, trigger: TriggerInputSchema }).strict(), write: true, agent: true, summary: 'Replace a trigger’s configuration as a new revision.' },
  'triggers.setEnabled': { input: z.object({ id, expectedRevision: revision, enabled: z.boolean() }).strict(), write: true, agent: true, summary: 'Turn a trigger on or off.' },
  'triggers.delete': { input: z.object({ id, expectedRevision: revision }).strict(), write: true, agent: true, summary: 'Delete a trigger. It can be restored for a while.' },
  'triggers.restore': { input: z.object({ id }).strict(), write: true, agent: true, summary: 'Restore a deleted trigger, turned off.' },
  'triggers.revert': { input: z.object({ id, expectedRevision: revision, revision }).strict(), write: true, agent: true, summary: 'Restore an earlier revision as a new revision.' },
  'triggers.run': { input: z.object({ id }).strict(), write: true, agent: true, summary: 'Run a trigger once now.' },
  'triggers.settings': { input: z.object({}).strict(), write: false, agent: true, summary: 'Read trigger limits.' },
  'triggers.updateSettings': { input: z.object({ settings: TriggerSettingsSchema }).strict(), write: true, ownerOnly: true, summary: 'Change trigger limits.' },
} as const;

export type OperationName = keyof typeof OPERATIONS;
export const isOperationName = (value: unknown): value is OperationName => typeof value === 'string' && Object.hasOwn(OPERATIONS, value);
