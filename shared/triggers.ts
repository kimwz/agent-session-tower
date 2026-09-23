import { z } from 'zod';

/**
 * Triggers watch for something (a schedule, an HTTP response, and later GitHub or Slack) and hand the work to a
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

const headerName = z.string().min(1).max(100).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'Invalid header name.')
  .refine(name => !['host', 'content-length', 'connection', 'transfer-encoding', 'cookie'].includes(name.toLowerCase()), 'Tower sets this header itself.');
export const HttpHeaderSchema = z.union([
  z.object({ name: headerName, value: z.string().max(4000).refine(value => !/[\r\n]/.test(value), 'Header values cannot contain line breaks.') }).strict(),
  /** A value kept in Tower's secret store, sent only to the origin it was saved for. */
  z.object({ name: headerName, secretId: z.string().uuid() }).strict(),
]);
export type HttpHeader = z.infer<typeof HttpHeaderSchema>;
export const HttpConditionSchema = z.discriminatedUnion('type', [
  /** Every successful response starts a run. */
  z.object({ type: z.literal('every-success') }).strict(),
  /** A run starts when the selected value (or the whole body) differs from the last response. */
  z.object({ type: z.literal('changed'), pointer: z.string().max(500).optional() }).strict(),
  /** A run starts when the comparison becomes true; it must turn false before it can start another. */
  z.object({ type: z.literal('match'), pointer: z.string().max(500).optional(), operator: z.enum(['equals', 'not-equals', 'contains', 'exists', 'gt', 'lt']),
    value: z.string().max(1000).optional(), statuses: z.array(z.number().int().min(100).max(599)).max(20).optional() }).strict(),
]);
export type HttpCondition = z.infer<typeof HttpConditionSchema>;
const webUrl = (value: string) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } };
export const HttpRequestSchema = z.object({
  method: z.enum(['GET', 'POST']),
  url: z.string().min(1).max(4000).refine(webUrl, 'Use an http or https URL without a user name or password.'),
  headers: z.array(HttpHeaderSchema).max(20).default([]),
  body: z.string().max(64_000).optional(),
  /** The whole request, redirects included; short enough that running or testing it answers within one API call. */
  timeoutSeconds: z.number().int().min(1).max(45).default(30),
}).strict();
export type HttpRequest = z.infer<typeof HttpRequestSchema>;
export const HttpSourceSchema = z.object({
  kind: z.literal('http'),
  schedule: ScheduleSchema,
  request: HttpRequestSchema,
  condition: HttpConditionSchema,
}).strict();

export const TriggerSourceSchema = z.discriminatedUnion('kind', [ScheduleSourceSchema, HttpSourceSchema]);
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;
/** Sources whose events carry content from outside; their runs always start new, tool-less sessions. */
export const carriesOutsideContent = (source: TriggerSource) => source.kind !== 'schedule';

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
  /** What the source observed (for HTTP: status and response excerpt). Outside content, never instructions. */
  payload?: unknown;
  /** Saved before any work is submitted; a claim without a result is never submitted again. */
  requestId: string;
  claimedAt?: string;
  dispatch?: { runId?: string; sessionId?: string; createdSessionId?: string };
}

export interface TriggerAuditEntry {
  id: string;
  at: string;
  actor: TriggerActor;
  action: 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'run' | 'revert' | 'restore' | 'resume' | 'settings' | 'slack' | 'secret';
  triggerId: string;
  triggerName: string;
  fromRevision?: number;
  toRevision?: number;
  summary: string;
}

const ipv4 = (text: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(text) && text.split('.').every(part => Number(part) <= 255);
function ipv6(text: string): boolean {
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const parts = halves.map(half => half ? half.split(':') : []);
  const groups = parts.flat();
  let count = groups.length;
  // A dotted IPv4 tail counts as two groups and must end the address.
  if (groups.at(-1)?.includes('.')) {
    if (parts.at(-1)?.at(-1) !== groups.at(-1) || !ipv4(groups.pop()!)) return false;
    count += 1;
  }
  return groups.every(part => /^[\da-f]{1,4}$/i.test(part)) && (halves.length === 2 ? count <= 7 : count === 8);
}
function validHost(value: string): boolean {
  const [network, bits, extra] = value.split('/');
  if (extra !== undefined || !network) return false;
  const v4 = ipv4(network);
  const v6 = network.includes(':') && ipv6(network);
  if (bits !== undefined) return /^\d{1,3}$/.test(bits) && ((v4 && Number(bits) <= 32) || (v6 && Number(bits) <= 128));
  // Only digits and dots is an address, never a host name, so an invalid one such as 300.1.1.1 is refused.
  return v4 || v6 || !network.includes(':') && !/^[\d.]+$/.test(network) && /^(?=.{1,253}$)[a-z\d]([a-z\d-]*[a-z\d])?(\.[a-z\d]([a-z\d-]*[a-z\d])?)*$/i.test(network);
}
export const TriggerSettingsSchema = z.object({
  maxTriggers: z.number().int().min(1).max(200).default(50),
  maxConcurrentRuns: z.number().int().min(1).max(10).default(3),
  maxEventsPerHour: z.number().int().min(1).max(600).default(60),
  /** Host names or CIDR ranges on private networks (including this computer) that HTTP triggers may call. */
  privateHosts: z.array(z.string().trim().min(1).max(200).refine(validHost, 'Use a host name, an IP address or a CIDR range such as 192.168.0.0/16.')).max(50).default([]),
}).strict();
export type TriggerSettings = z.infer<typeof TriggerSettingsSchema>;

/** A header value in the secret store. The value never leaves the worker. */
export interface TriggerSecret { id: string; name: string; origin: string; triggerIds: string[]; createdAt: string }
export const SecretInputSchema = z.object({
  name: text(100),
  /** The only origin (scheme, host and port) this value is ever sent to. */
  origin: z.string().trim().max(400).refine(webUrl, 'Use an http or https address such as https://api.example.com.').transform(value => new URL(value).origin),
  // Stored trimmed with single spaces, as servers see and echo it, so a response that repeats it can be cleaned.
  value: z.string().max(4000).refine(value => !/[\r\n]/.test(value), 'Header values cannot contain line breaks.').transform(value => value.trim().replace(/\s+/g, ' '))
    // Short values cannot be removed reliably from responses that echo them, so they are not accepted.
    .refine(value => value.length >= 8 && (/^\S+ (\S.*)$/.exec(value)?.[1].length ?? 8) >= 4, 'A secret must be at least 8 characters, with at least 4 after a scheme such as Bearer.'),
}).strict();
export type SecretInput = z.infer<typeof SecretInputSchema>;
/** What a request test shows the owner; nothing is recorded and no run starts. */
export interface HttpTestResult {
  ok: boolean;
  error?: string;
  status?: number;
  contentType?: string;
  body?: string;
  truncated?: boolean;
  selected?: unknown;
  /** For `match`: whether the comparison holds for this response. */
  matched?: boolean;
}

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
