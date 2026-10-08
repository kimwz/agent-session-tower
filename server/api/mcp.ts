import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { OPERATIONS, type OperationName } from '../../shared/api/operations.js';
import type { Run, RunDelegation } from '../../shared/types.js';
import { GITHUB_SESSION_TOOLS } from '../triggers/github-coordinator.js';
import { SLACK_SESSION_TOOLS } from '../slack/mcp-bridge.js';
import { SESSION_TOOL_OPERATIONS } from './session-tools.js';
import type { TowerApi } from './tower-api.js';
import { TowerError } from '../../shared/errors.js';

/** What a capability lets its holder do. The holder never chooses; the worker decides when it issues one. */
export type Capability = { kind: 'owner-run'; runId: string; sessionId: string } | { kind: 'slack-workflow'; workflowId: string } | { kind: 'github-workflow'; workflowId: string }
  /** Reports who started work through the local HTTP API; grants no API or owner approval rights. */
  | { kind: 'caller-run'; runId: string; sessionId: string }
  | { kind: 'secret-run'; runId: string; sessionId: string }
  /** The standing key of the session lookup tools every agent here gets (see session-tools.ts). */
  | { kind: 'session-reader' };
const MAX_CAPABILITIES = 2000;

/**
 * Run-scoped credentials for tool servers the worker attaches to provider turns. They live only in this
 * worker's memory, never in a file or in native configuration, and differ from the worker's own RPC credential.
 */
export class CapabilityRegistry {
  private readonly tokens = new Map<string, Capability>();
  private readonly issued = new Map<string, string>();
  private readonly standing = new Map<string, Capability>();
  /** `live` says whether a credential may still be used; only credentials that cannot are forgotten first. */
  constructor(private readonly live: (capability: Capability) => boolean = () => true) {}
  issue(capability: Capability): string {
    const key = JSON.stringify(capability);
    const existing = this.issued.get(key);
    if (existing) return existing;
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, capability); this.issued.set(key, token);
    if (this.tokens.size > MAX_CAPABILITIES) {
      for (const [stale, value] of [...this.tokens]) if (!this.live(value)) { this.tokens.delete(stale); this.issued.delete(JSON.stringify(value)); }
      // Only if every credential is still in use are the oldest forgotten; their holders then get a clear refusal.
      while (this.tokens.size > MAX_CAPABILITIES) {
        const [oldest, value] = this.tokens.entries().next().value!;
        this.tokens.delete(oldest); this.issued.delete(JSON.stringify(value));
      }
    }
    return token;
  }
  /** A credential that is never forgotten, for tools that outlive any one run. */
  grant(token: string, capability: Capability): void { this.standing.set(token, capability); }
  resolve(token: string): Capability | undefined { return /^[a-f\d]{64}$/.test(token) ? this.standing.get(token) ?? this.tokens.get(token) : undefined; }
}

/** An authenticated calling run, with a stable ancestor even after intermediate runs leave history. */
export function delegationOf(run: Run): RunDelegation {
  return { parentRunId: run.id, rootRunId: run.delegation?.rootRunId ?? run.origin?.runId ?? run.id };
}

export function callerDelegation(registry: CapabilityRegistry, find: (id: string) => Run | undefined, token: string): RunDelegation {
  const capability = registry.resolve(token);
  const run = capability?.kind === 'caller-run' ? find(capability.runId) : undefined;
  if (!run || capability?.kind !== 'caller-run' || run.sessionId !== capability.sessionId || run.status !== 'running' || run.origin?.controllerId) {
    throw new TowerError('forbidden', 'The calling turn is no longer running here, or its reporting credential is invalid. Nothing was submitted.', { disposition: 'not-admitted' });
  }
  return delegationOf(run);
}

/** Tool names agents see (`mcp__tower__triggers_create`), with a requestKey on operations that create something. */
export function towerTools(only?: ReadonlySet<string>) {
  return (Object.entries(OPERATIONS) as [OperationName, (typeof OPERATIONS)[OperationName]][]).filter(([name, operation]) => 'agent' in operation && operation.agent && (!only || only.has(name))).map(([name, operation]) => {
    const { $schema: _schema, ...schema } = z.toJSONSchema(operation.input, { io: 'input' }) as Record<string, any>;
    if (operation.write && !('keyField' in operation)) {
      schema.properties = { ...schema.properties, requestKey: { type: 'string', minLength: 1, maxLength: 100, description: 'A stable key for this request. Reuse the same key to retry the same request; a new request needs a new key.' } };
      schema.required = [...(schema.required ?? []), 'requestKey'];
    }
    return { name: name.replace('.', '_'), description: operation.summary, inputSchema: schema };
  });
}
const operationOf = (tool: string) => (Object.keys(OPERATIONS) as OperationName[]).find(name => name.replace('.', '_') === tool);

export interface McpContext {
  api?: TowerApi;
  capabilities: CapabilityRegistry;
  /** The run a credential was issued for, as the run registry knows it now. */
  run(runId: string): Run | undefined;
  heartbeatAllowed?(run: Run): boolean;
  slackTool?(workflowId: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  githubTool?(workflowId: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  secretTools?: unknown[];
  secretTool?(capability: Extract<Capability, { kind: 'secret-run' }>, name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Handles one request from a tool server process. Only the capability decides what it may do. */
export async function handleMcpRequest(context: McpContext, token: string, body: { method?: unknown; name?: unknown; arguments?: unknown }): Promise<unknown> {
  const capability = context.capabilities.resolve(token);
  if (!capability) throw new TowerError('forbidden', 'This tool credential is not valid.');
  if (capability.kind === 'caller-run') {
    const run = context.run(capability.runId);
    if (body.method !== 'heartbeat/context' || !run || run.id !== capability.runId || run.sessionId !== capability.sessionId
      || context.heartbeatAllowed?.(run) === false || run.status !== 'running' || run.origin?.kind !== 'agent' || run.origin.controllerId || run.ownerStopped || run.approvals?.length || !run.heartbeat?.targets?.length) {
      throw new TowerError('forbidden', 'A reporting credential cannot call Tower tools.');
    }
    return { runId: run.id, sessionId: run.sessionId, heartbeat: structuredClone(run.heartbeat) };
  }
  if (capability.kind === 'session-reader') {
    if (body.method === 'tools/list') return { tools: towerTools(SESSION_TOOL_OPERATIONS) };
    const operation = typeof body.name === 'string' ? operationOf(body.name) : undefined;
    if (body.method !== 'tools/call' || !operation || !SESSION_TOOL_OPERATIONS.has(operation)) throw new TowerError('not-found', 'Unknown session tool.');
    if (!context.api) throw new TowerError('unavailable', 'Tower operations are unavailable.');
    return context.api.call(operation, body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {}, { kind: 'agent', via: 'mcp' });
  }
  if (capability.kind === 'slack-workflow') {
    if (body.method === 'tools/list') return { tools: SLACK_SESSION_TOOLS };
    if (body.method !== 'tools/call' || typeof body.name !== 'string' || !SLACK_SESSION_TOOLS.some(tool => tool.name === body.name)) throw new TowerError('not-found', 'Unknown Slack session tool.');
    if (!context.slackTool) throw new TowerError('unavailable', 'Slack is unavailable.');
    return context.slackTool(capability.workflowId, body.name, (body.arguments ?? {}) as Record<string, unknown>);
  }
  if (capability.kind === 'github-workflow') {
    if (body.method === 'tools/list') return { tools: GITHUB_SESSION_TOOLS };
    if (body.method !== 'tools/call' || typeof body.name !== 'string' || !GITHUB_SESSION_TOOLS.some(tool => tool.name === body.name)) throw new TowerError('not-found', 'Unknown GitHub conversation tool.');
    if (!context.githubTool) throw new TowerError('unavailable', 'GitHub conversations are unavailable.');
    return context.githubTool(capability.workflowId, body.name, (body.arguments ?? {}) as Record<string, unknown>);
  }
  // The credential works only for its own run, only while that run works, and only if Tower's tools were
  // actually attached to it (not a turn forwarded to the desktop app).
  const run = context.run(capability.runId);
  if (!run || run.sessionId !== capability.sessionId || run.status !== 'running' || run.origin?.kind !== 'owner' || run.towerTools !== 'attached') {
    throw new TowerError('forbidden', 'Tower tools work only during the turn you started from Tower that they were given to.');
  }
  if (capability.kind === 'secret-run') {
    if (!context.secretTool || !context.secretTools) throw new TowerError('unavailable', '시크릿 도구를 사용할 수 없습니다.');
    if (body.method === 'tools/list') return { tools: context.secretTools };
    if (body.method !== 'tools/call' || typeof body.name !== 'string') throw new TowerError('not-found', '알 수 없는 시크릿 도구입니다.');
    return context.secretTool(capability, body.name, body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments as Record<string, unknown> : {});
  }
  if (body.method === 'tools/list') return { tools: towerTools() };
  const operation = typeof body.name === 'string' ? operationOf(body.name) : undefined;
  if (body.method !== 'tools/call' || !operation) throw new TowerError('not-found', 'Unknown Tower tool.');
  if (!context.api) throw new TowerError('unavailable', 'Tower operations are unavailable.');
  const { requestKey, ...input } = (body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {}) as Record<string, unknown>;
  // Admission may prepare files asynchronously. Recheck the credential at its commit point, without
  // keeping this transient gate on an already admitted durable job.
  const controllerId = run.origin.controllerId;
  const validate = () => {
    const current = context.run(capability.runId);
    if (context.capabilities.resolve(token) !== capability || !current || current.sessionId !== capability.sessionId
      || current.status !== 'running' || current.origin?.kind !== 'owner' || current.towerTools !== 'attached'
      || current.origin.controllerId !== controllerId) {
      throw new TowerError('forbidden', 'The calling turn lost its Tower authority before admission. Nothing was submitted.', { disposition: 'not-admitted' });
    }
  };
  // A turn started from a controlling computer keeps to what that computer may see and change.
  return context.api.call(operation, input, { kind: 'agent', via: 'mcp', sessionId: capability.sessionId, runId: run.id, ...(run.origin.controllerId ? { controllerId: run.origin.controllerId } : {}) },
    typeof requestKey === 'string' ? requestKey : undefined, { delegation: delegationOf(run), validate });
}
