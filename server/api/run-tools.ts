import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import type { Run, Session } from '../../shared/types.js';
import type { RunManager } from '../runs/manager.js';
import { NO_RUN_TOOLS, type RunTools, type SessionMcpServer } from '../runs/session-mcp.js';
import type { SlackService } from '../slack/service.js';
import type { CapabilityRegistry } from './mcp.js';

/** This build's own entry, so a tool server always matches the worker that issued its capability. */
function toolServer(stateDir: string, mode: '--tower-mcp' | '--slack-mcp', extra: string[], capability: string): SessionMcpServer {
  const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url));
  const args = isSea() ? [mode, stateDir, ...extra] : [...process.execArgv.filter(arg => !/^--inspect(?:-brk|-port|-publish-uid)?(?:=|$)/.test(arg)), entry, mode, stateDir, ...extra];
  return { command: process.execPath, args, env: { TOWER_MCP_CAPABILITY: capability } };
}

/**
 * Which tools a turn receives. Slack coordinator turns get their conversation tools. A turn the owner started
 * from Tower gets Tower's tools, unless its conversation holds outside content or its origin cannot be proven.
 * Trigger, Slack and agent-started turns never get Tower's tools.
 */
export function runToolResolver(options: { stateDir: string; runs: Pick<RunManager, 'sessionOrigin'>; slack?: Pick<SlackService, 'sessionMcp'>; capabilities: CapabilityRegistry }) {
  return (run: Run, session: Session): RunTools => {
    const origin = run.origin;
    const slack = options.slack?.sessionMcp(session.id)?.tower_slack;
    if (slack) {
      const workflowId = slack.args.at(-1)!;
      return { servers: { tower_slack: toolServer(options.stateDir, '--slack-mcp', [workflowId], options.capabilities.issue({ kind: 'slack-workflow', workflowId })) }, required: true };
    }
    if (origin?.kind !== 'owner') return NO_RUN_TOOLS;
    const provenance = options.runs.sessionOrigin(session.id);
    if (provenance?.untrustedInput) return { required: false, towerTools: 'external-input' };
    if (provenance && provenance.kind !== 'owner') return { required: false, towerTools: 'not-owner-session' };
    // Bound to this run: a later turn, even in the same conversation, gets its own credential.
    return { servers: { tower: toolServer(options.stateDir, '--tower-mcp', [], options.capabilities.issue({ kind: 'owner-run', runId: run.id, sessionId: session.id })) }, required: false, towerTools: 'attached' };
  };
}
