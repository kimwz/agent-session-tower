import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { OPERATIONS, type OperationName } from '../../shared/api/operations.js';
import type { Run } from '../../shared/types.js';
import { GITHUB_SESSION_TOOLS } from '../triggers/github-coordinator.js';
import { SLACK_SESSION_TOOLS } from '../slack/mcp-bridge.js';
import type { TowerApi } from './tower-api.js';

/** What a capability lets its holder do. The holder never chooses; the worker decides when it issues one. */
export type Capability = { kind: 'owner-run'; runId: string; sessionId: string } | { kind: 'slack-workflow'; workflowId: string } | { kind: 'github-workflow'; workflowId: string };
const MAX_CAPABILITIES = 2000;

/**
 * Run-scoped credentials for tool servers the worker attaches to provider turns. They live only in this
 * worker's memory, never in a file or in native configuration, and differ from the worker's own RPC credential.
 */
export class CapabilityRegistry {
  private readonly tokens = new Map<string, Capability>();
  private readonly issued = new Map<string, string>();
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
  resolve(token: string): Capability | undefined { return /^[a-f\d]{64}$/.test(token) ? this.tokens.get(token) : undefined; }
}

/** Tool names agents see (`mcp__tower__triggers_create`), with a requestKey on operations that create something. */
export function towerTools() {
  return (Object.entries(OPERATIONS) as [OperationName, (typeof OPERATIONS)[OperationName]][]).filter(([, operation]) => 'agent' in operation && operation.agent).map(([name, operation]) => {
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
  slackTool?(workflowId: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  githubTool?(workflowId: string, name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Handles one request from a tool server process. Only the capability decides what it may do. */
export async function handleMcpRequest(context: McpContext, token: string, body: { method?: unknown; name?: unknown; arguments?: unknown }): Promise<unknown> {
  const capability = context.capabilities.resolve(token);
  if (!capability) throw Object.assign(new Error('This tool credential is not valid.'), { statusCode: 403 });
  if (capability.kind === 'slack-workflow') {
    if (body.method === 'tools/list') return { tools: SLACK_SESSION_TOOLS };
    if (body.method !== 'tools/call' || typeof body.name !== 'string' || !SLACK_SESSION_TOOLS.some(tool => tool.name === body.name)) throw Object.assign(new Error('Unknown Slack session tool.'), { statusCode: 404 });
    if (!context.slackTool) throw Object.assign(new Error('Slack is unavailable.'), { statusCode: 503 });
    return context.slackTool(capability.workflowId, body.name, (body.arguments ?? {}) as Record<string, unknown>);
  }
  if (capability.kind === 'github-workflow') {
    if (body.method === 'tools/list') return { tools: GITHUB_SESSION_TOOLS };
    if (body.method !== 'tools/call' || typeof body.name !== 'string' || !GITHUB_SESSION_TOOLS.some(tool => tool.name === body.name)) throw Object.assign(new Error('Unknown GitHub conversation tool.'), { statusCode: 404 });
    if (!context.githubTool) throw Object.assign(new Error('GitHub conversations are unavailable.'), { statusCode: 503 });
    return context.githubTool(capability.workflowId, body.name, (body.arguments ?? {}) as Record<string, unknown>);
  }
  // The credential works only for its own run, only while that run works, and only if Tower's tools were
  // actually attached to it (not a turn forwarded to the desktop app).
  const run = context.run(capability.runId);
  if (!run || run.sessionId !== capability.sessionId || run.status !== 'running' || run.origin?.kind !== 'owner' || run.towerTools !== 'attached') {
    throw Object.assign(new Error('Tower tools work only during the turn you started from Tower that they were given to.'), { statusCode: 403 });
  }
  if (body.method === 'tools/list') return { tools: towerTools() };
  const operation = typeof body.name === 'string' ? operationOf(body.name) : undefined;
  if (body.method !== 'tools/call' || !operation) throw Object.assign(new Error('Unknown Tower tool.'), { statusCode: 404 });
  if (!context.api) throw Object.assign(new Error('Tower operations are unavailable.'), { statusCode: 503 });
  const { requestKey, ...input } = (body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {}) as Record<string, unknown>;
  // A turn started from a controlling computer keeps to what that computer may see and change.
  return context.api.call(operation, input, { kind: 'agent', via: 'mcp', sessionId: capability.sessionId, runId: run.id, ...(run.origin.controllerId ? { controllerId: run.origin.controllerId } : {}) },
    typeof requestKey === 'string' ? requestKey : undefined);
}
