import { z } from 'zod';

/**
 * Triggers watch for something (a schedule, and later HTTP, GitHub or Slack) and hand the work to a
 * project agent. The schemas here are the single contract for the web API, the worker and agent tools.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const absolutePath = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !value.includes('\0'), 'An absolute folder path is required.');

export const CRON_FIELDS = 5;
export const ScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cron'), expression: text(200), timezone: text(100) }).strict(),
  z.object({ type: z.literal('interval'), everySeconds: z.number().int().min(60).max(31 * 24 * 60 * 60) }).strict(),
]);
export type Schedule = z.infer<typeof ScheduleSchema>;

export const ScheduleSourceSchema = z.object({
  kind: z.literal('schedule'),
  schedule: ScheduleSchema,
  /** After sleep or downtime: run the most recent missed time once (within a day), or skip what was missed. */
  catchUp: z.enum(['latest', 'skip']).default('latest'),
}).strict();

export const TriggerSourceSchema = z.discriminatedUnion('kind', [ScheduleSourceSchema]);
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;

export const TargetSchema = z.discriminatedUnion('mode', [
  /** Auto Prompt chooses the project folder and session. */
  z.object({ node: z.literal('local').default('local'), mode: z.literal('auto') }).strict(),
  /** A new session in this folder. The folder must already exist. */
  z.object({ node: z.literal('local').default('local'), mode: z.literal('folder'), cwd: absolutePath }).strict(),
  /** Continue this existing session. Only for triggers that bring no outside content. */
  z.object({ node: z.literal('local').default('local'), mode: z.literal('session'), sessionId: text(512) }).strict(),
]);
export type TriggerTarget = z.infer<typeof TargetSchema>;

export const TaskHandlerSchema = z.object({
  kind: z.literal('task'),
  instructions: text(8000),
  provider: z.enum(['claude', 'codex']),
  model: text(200).optional(),
  effort: text(40).optional(),
  /** `auto`: the provider's automatic approval review decides; `owner`: approvals wait in Tower. */
  approvals: z.enum(['auto', 'owner']).default('auto'),
  target: TargetSchema,
}).strict();
export const TriggerHandlerSchema = z.discriminatedUnion('kind', [TaskHandlerSchema]);
export type TriggerHandler = z.infer<typeof TriggerHandlerSchema>;

export const PolicySchema = z.object({
  /** What happens when this trigger fires while its previous work is still running. */
  overlap: z.enum(['skip', 'queue', 'parallel']).default('skip'),
  maxEventsPerHour: z.number().int().min(1).max(60).default(20),
}).strict();
export type TriggerPolicy = z.infer<typeof PolicySchema>;

export const TriggerInputSchema = z.object({
  name: text(120),
  enabled: z.boolean().default(true),
  source: TriggerSourceSchema,
  handler: TriggerHandlerSchema,
  policy: PolicySchema.default({ overlap: 'skip', maxEventsPerHour: 20 }),
}).strict();
export type TriggerInput = z.infer<typeof TriggerInputSchema>;

export type ActorKind = 'owner' | 'agent' | 'system';
export interface TriggerActor {
  kind: ActorKind;
  via: 'ui' | 'mcp' | 'migration';
  /** For an agent: the Tower session and run whose tool call made the change. */
  sessionId?: string;
  runId?: string;
}

export interface Trigger extends TriggerInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: TriggerActor;
  updatedBy: TriggerActor;
}

export type TriggerEventStatus = 'skipped' | 'coalesced' | 'queued' | 'claimed' | 'running' | 'completed' | 'error' | 'cancelled' | 'uncertain';
export interface TriggerEvent {
  id: string;
  triggerId: string;
  triggerName: string;
  triggerRevision: number;
  kind: TriggerSource['kind'] | 'manual';
  dedupKey: string;
  occurredAt: string;
  receivedAt: string;
  updatedAt: string;
  status: TriggerEventStatus;
  /** The configuration in force when it fired; later edits never change what this event runs. */
  input: { instructions: string; provider: 'claude' | 'codex'; model?: string; effort?: string; approvals: 'auto' | 'owner'; target: TriggerTarget; untrustedInput: boolean; overlap: TriggerPolicy['overlap'] };
  summary: string;
  reason?: string;
  error?: string;
  /** Saved before any work is submitted; a claim without a result is never submitted again. */
  requestId: string;
  claimedAt?: string;
  dispatch?: { runId?: string; sessionId?: string; createdSessionId?: string };
}

export interface TriggerAuditEntry {
  id: string;
  at: string;
  actor: TriggerActor;
  action: 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'run' | 'revert' | 'restore' | 'resume' | 'settings' | 'slack';
  triggerId: string;
  triggerName: string;
  fromRevision?: number;
  toRevision?: number;
  summary: string;
}

export const TriggerSettingsSchema = z.object({
  maxTriggers: z.number().int().min(1).max(200).default(50),
  maxConcurrentRuns: z.number().int().min(1).max(10).default(3),
  maxEventsPerHour: z.number().int().min(1).max(600).default(60),
}).strict();
export type TriggerSettings = z.infer<typeof TriggerSettingsSchema>;

/** What the canvas and header need; history and audit are paged separately. */
export interface TriggerSummary {
  id: string;
  name: string;
  enabled: boolean;
  kind: TriggerSource['kind'] | 'slack';
  revision: number;
  nextRunAt?: string;
  lastEvent?: Pick<TriggerEvent, 'id' | 'status' | 'occurredAt' | 'error' | 'reason'>;
  paused?: { reason: string; at: string };
  updatedBy: TriggerActor;
  updatedAt: string;
  error?: string;
}
export interface TriggerOverview {
  triggers: TriggerSummary[];
  recent: TriggerEvent[];
  storageError?: string;
}
