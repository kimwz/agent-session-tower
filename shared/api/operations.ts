import { z } from 'zod';
import { PermissionAutoReviewSchema, PermissionRequestInputSchema, PermissionRuleInputSchema, PermissionRunInputSchema, PermissionRunResultInputSchema } from '../permissions.js';
import { GitHubAuthSchema, GitHubSourceSchema, HttpConditionSchema, HttpRequestSchema, ScheduleSchema, SecretInputSchema, TriggerInputSchema, TriggerSettingsSchema } from '../triggers.js';

const id = z.string().min(1).max(200);
const uuid = z.string().regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i, 'A UUID is required.');
const revision = z.number().int().min(1);
/** An ISO 8601 date or date and time. */
const time = z.string().max(40).refine(value => /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value)), 'An ISO 8601 date or time is required.');
const cursor = z.string().min(1).max(500);
const page = { before: z.string().max(40).optional(), limit: z.number().int().min(1).max(200).optional() };

/**
 * Every Tower operation that the web API and agent tools can call. One schema per operation validates
 * input the same way on every path; the worker applies ownership and history rules.
 * `agent` operations are offered to agents in turns the owner starts from Tower. Every changing operation an
 * agent calls is recorded under a key (its `requestKey`, or the field named by `keyField`), so a retried
 * call returns the first result instead of acting twice.
 */
export const OPERATIONS = {
  'sessions.list': { input: z.object({ provider: z.enum(['claude', 'codex']).optional(), cwd: z.string().max(4096).optional(), query: z.string().max(200).optional(),
    since: time.optional(), until: time.optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(200).optional() }).strict(), write: false, agent: true,
    summary: 'List Tower sessions, most recently active first (20 by default), with their folder, status and whether a trigger created them. query matches the title or folder; since/until bound the last activity. Pass nextCursor as cursor for the next page.' },
  'sessions.read': { input: z.object({ id, cursor: cursor.optional(), limit: z.number().int().min(1).max(100).optional(), tools: z.boolean().optional() }).strict(), write: false, agent: true,
    summary: 'Read a Claude or Codex session’s messages (id as listed, or its bare session UUID), oldest to newest, ending with the latest (20 by default). Pass nextCursor as cursor for the page before, or a search match’s cursor to read up to that match. Tool calls are left out unless tools is true.' },
  'sessions.search': { input: z.object({ query: z.string().trim().min(1).max(200), since: time.optional(), until: time.optional(), provider: z.enum(['claude', 'codex']).optional(),
    cwd: z.string().max(4096).optional(), sessionId: id.optional(), tools: z.boolean().optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(50).optional() }).strict(), write: false, agent: true,
    summary: 'Find earlier Claude and Codex sessions whose messages contain every word of query (case-insensitive), most recently active first (10 by default), with matching excerpts. since/until bound the message time (ISO date or time). Use it to look for related past work before starting a task. A search that stops early returns nextCursor to continue.' },
  'projects.list': { input: z.object({}).strict(), write: false, agent: true, summary: 'List the project folders Tower knows, with their names and how many sessions each has.' },
  'runs.list': { input: z.object({ sessionId: id.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), write: false, agent: true,
    summary: 'List recent Tower runs with their status, origin and the end of their output.' },
  'autoPrompt.submit': { input: z.object({ requestId: uuid, provider: z.enum(['claude', 'codex']), prompt: z.string().min(1).max(32_000), cwd: z.string().max(4096).optional(),
    model: z.string().max(200).optional(), effort: z.string().max(40).optional() }).strict(), write: true, agent: true, keyField: 'requestId',
    summary: 'Hand a task to the right project agent through Auto Prompt. The requestId identifies the request: reuse it to retry or check, never for a different task.' },
  'autoPrompt.get': { input: z.object({ requestId: uuid }).strict(), write: false, agent: true, summary: 'Read an Auto Prompt request and the run it started.' },
  'triggers.list': { input: z.object({}).strict(), write: false, agent: true, summary: 'List triggers with their state and recent runs.' },
  'triggers.get': { input: z.object({ id }).strict(), write: false, agent: true, summary: 'Read one trigger with its earlier revisions and recent runs.' },
  'triggers.events': { input: z.object({ triggerId: id.optional(), beforeId: id.optional(), ...page }).strict(), write: false, agent: true,
    summary: 'Read trigger runs, newest first. Pass the last run’s id as beforeId for the next page.' },
  'triggers.event': { input: z.object({ id }).strict(), write: false, agent: true, summary: 'Read one trigger run with its instructions and what its source saw.' },
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
  'triggers.updateSettings': { input: z.object({ settings: TriggerSettingsSchema }).strict(), write: true, ownerOnly: true, summary: 'Change trigger limits and the private hosts HTTP triggers may call.' },
  'triggers.testHttp': { input: z.object({ request: HttpRequestSchema, condition: HttpConditionSchema.optional() }).strict(), write: true, ownerOnly: true,
    summary: 'Send an HTTP trigger’s request once and show the response, without recording or running anything.' },
  'triggers.checkGitHub': { input: z.object({ auth: GitHubAuthSchema }).strict(), write: false, ownerOnly: true,
    summary: 'Check a GitHub connection and show the account it acts as.' },
  'triggers.previewIssues': { input: z.object({ source: GitHubSourceSchema, id: id.optional() }).strict(), write: false, agent: true,
    summary: 'List the open issues a GitHub issue watch would work on, in its order, with where each stands; nothing is recorded or run.' },
  'github.conversation': { input: z.object({ sessionId: id }).strict(), write: false, ownerOnly: true,
    summary: 'Read the reply proposals and status of a GitHub coordinator conversation.' },
  'github.approveReply': { input: z.object({ workflowId: uuid, requestKey: z.string().min(1).max(200), text: z.string().min(1).max(4000) }).strict(), write: true, ownerOnly: true,
    summary: 'Post one exact reply proposal to its GitHub issue as a comment.' },
  'secrets.list': { input: z.object({}).strict(), write: false, agent: true, summary: 'List saved header secrets by name and origin. Values are never shown.' },
  'secrets.create': { input: z.object({ secret: SecretInputSchema }).strict(), write: true, ownerOnly: true, summary: 'Save a header value that is sent only to one origin.' },
  'secrets.delete': { input: z.object({ id: uuid }).strict(), write: true, ownerOnly: true, summary: 'Delete a saved header secret.' },
  'permissions.request': { input: PermissionRequestInputSchema, write: true, agent: true,
    summary: 'Ask the owner to allow an action Claude Code or Codex refused or keeps asking approval for (a permission rule, the auto-mode classifier, or a sandbox), when the task needs it. kind "command" is a command prefix without arguments you do not need (e.g. "gh pr merge"; no quotes, pipes or wildcards) and applies to Claude Code and Codex; kind "claude" is a Claude Code permission rule for other tools (e.g. "WebFetch(domain:example.com)"). scope "project" allows it in this folder only; ask for "global" only when it is needed everywhere. Ask for the narrowest rule and say why in reason, naming the step of the owner’s task that needs it. Tower’s permission reviewer (checking it against the owner’s instructions for this task) or the owner decides in Tower: never work around the refusal. When the reviewer asks for a narrower rule, send a new request for that. A command rule with dangerous options, or options before its subcommand, always waits for the owner; harmless options are fine (e.g. "gh pr merge --squash"). An allowed rule applies from your next turn, so say what waits on it and end your turn (or do other work first); the owner can send the decision to this conversation, and permissions_list shows it.' },
  'permissions.run': { input: PermissionRunInputSchema, write: true, agent: true,
    summary: 'Ask Tower to run one exact shell command once for you, in this conversation’s folder, when Claude Code or Codex refused it and a lasting rule would allow more than the task needs (stopping one process, one cleanup step). Tower’s permission reviewer or the owner judges the exact command; when allowed, Tower runs it with sh -c (no input, at most timeoutSeconds, default and limit 600) and keeps its output (the first and last 64 KiB of each stream). Say in reason which step of the owner’s task needs it. Sending the same command again (or the same key) returns the same request instead of running it twice. Then call permissions_runResult with the id to wait for the result; if you end your turn first, the result arrives as a message.' },
  'permissions.runResult': { input: PermissionRunResultInputSchema, write: false, agent: true,
    summary: 'The state of a permissions_run request this conversation sent, waiting up to waitSeconds (default 0, at most 50) for it to finish. Once it has run: exit code, whether it timed out, and its output.' },
  'permissions.forgetConversation': { input: z.object({ sessionId: z.string().min(1).max(500) }).strict(), write: true, ownerOnly: true,
    summary: 'Remove the rules given to one conversation, as when it is closed.' },
  'permissions.list': { input: z.object({ cwd: z.string().max(4096).optional() }).strict(), write: false, agent: true,
    summary: 'List the allow rules Tower keeps for this folder (or cwd) and every project, and the permission requests this conversation sent with their status.' },
  'permissions.overview': { input: z.object({ cwd: z.string().max(4096).optional() }).strict(), write: false, ownerOnly: true, summary: 'Read every permission rule, request and rules file, or one folder’s.' },
  'permissions.save': { input: z.object({ id: uuid.optional(), rule: PermissionRuleInputSchema }).strict(), write: true, ownerOnly: true, summary: 'Add or change an allow rule.' },
  'permissions.delete': { input: z.object({ id: uuid }).strict(), write: true, ownerOnly: true, summary: 'Delete an allow rule.' },
  'permissions.decide': { input: z.object({ id: uuid, approve: z.boolean(), rule: PermissionRuleInputSchema.optional(), resume: z.boolean().optional() }).strict(), write: true, ownerOnly: true,
    summary: 'Allow a permission request, as asked or as edited, or refuse it; with resume, tell the requesting conversation so it goes on.' },
  'permissions.saveAutoReview': { input: z.object({ settings: PermissionAutoReviewSchema }).strict(), write: true, ownerOnly: true,
    summary: 'Turn Tower\'s permission reviewer on or off, choose its model, and whether it tells the requesting conversation.' },
  'permissions.acknowledge': { input: z.object({}).strict(), write: true, ownerOnly: true, summary: 'Dismiss the notice about an earlier permission record that could not be read.' },
} as const;

export type OperationName = keyof typeof OPERATIONS;
/**
 * Operations a controlling computer's pages may use on this computer: its triggers and the names of its secrets.
 * The worker answers them with only what this computer shares.
 */
export const REMOTE_PAGE_OPERATIONS: ReadonlySet<string> = new Set(['triggers.list', 'triggers.get', 'triggers.events', 'triggers.event', 'triggers.audit', 'triggers.deleted',
  'triggers.preview', 'triggers.previewIssues', 'triggers.settings', 'triggers.create', 'triggers.update', 'triggers.setEnabled', 'triggers.delete', 'triggers.restore', 'triggers.revert', 'triggers.run', 'secrets.list']);
export const isOperationName = (value: unknown): value is OperationName => typeof value === 'string' && Object.hasOwn(OPERATIONS, value);
