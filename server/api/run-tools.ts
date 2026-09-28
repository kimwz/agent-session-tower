import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import type { Run, Session } from '../../shared/types.js';
import type { RunManager } from '../runs/manager.js';
import { NO_RUN_TOOLS, type RunTools, type SessionMcpServer } from '../runs/session-mcp.js';
import type { SlackService } from '../slack/service.js';
import type { GitHubCoordinator } from '../triggers/github-coordinator.js';
import type { CapabilityRegistry } from './mcp.js';
import { SESSION_TOOLS_SERVER, sessionToolServer } from './session-tools.js';

/** How to start this build's own entry, so a tool server always matches the worker that answers it. */
export function thisBuild(): { command: string; args: string[] } {
  const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url));
  return { command: process.execPath, args: isSea() ? [] : [...process.execArgv.filter(arg => !/^--inspect(?:-brk|-port|-publish-uid)?(?:=|$)/.test(arg)), entry] };
}
function toolServer(stateDir: string, mode: '--tower-mcp' | '--slack-mcp', extra: string[], capability: string): SessionMcpServer {
  const build = thisBuild();
  return { command: build.command, args: [...build.args, mode, stateDir, ...extra], env: { TOWER_MCP_CAPABILITY: capability } };
}

/**
 * Which tools a turn receives. Slack coordinator turns get their conversation tools. A turn the owner started
 * from Tower, here or from a controlling computer, gets Tower's tools, unless its conversation holds outside content
 * or its origin cannot be proven; a controlling computer's turn then sees only what that computer may see.
 * Trigger, Slack and agent-started turns never get Tower's tools. Every turn started here also gets the read-only session
 * lookups, which Claude Code and Codex elsewhere on this computer get from their user configuration.
 */
export function runToolResolver(options: { stateDir: string; runs: Pick<RunManager, 'sessionOrigin'>; slack?: Pick<SlackService, 'sessionMcp'>; github?: Pick<GitHubCoordinator, 'sessionWorkflow'>; capabilities: CapabilityRegistry }) {
  const lookups = { [SESSION_TOOLS_SERVER]: sessionToolServer(options.stateDir, thisBuild()) };
  return (run: Run, session: Session): RunTools => {
    const tools = resolve(run, session);
    // Given here too, so they work even where the user configuration does not name them.
    return run.origin?.controllerId ? tools : { ...tools, servers: { ...tools.servers, ...lookups } };
  };
  function resolve(run: Run, session: Session): RunTools {
    const origin = run.origin;
    const slack = options.slack?.sessionMcp(session.id)?.tower_slack;
    const coordinated = options.github?.sessionWorkflow(session.id);
    // Remote work never receives a coordinator's tools, whatever conversation it lands in.
    if (origin?.controllerId && (slack || coordinated)) return { required: false, towerTools: 'remote' };
    if (slack) {
      const workflowId = slack.args.at(-1)!;
      return { servers: { tower_slack: toolServer(options.stateDir, '--slack-mcp', [workflowId], options.capabilities.issue({ kind: 'slack-workflow', workflowId })) }, required: true };
    }
    // A GitHub coordinator conversation gets its conversation tools, whoever started the turn.
    if (coordinated) return { servers: { tower_github: toolServer(options.stateDir, '--tower-mcp', [], options.capabilities.issue({ kind: 'github-workflow', workflowId: coordinated })) }, required: true };
    if (origin?.kind !== 'owner') return NO_RUN_TOOLS;
    const provenance = options.runs.sessionOrigin(session.id);
    if (provenance?.untrustedInput) return { required: false, towerTools: 'external-input' };
    if (provenance && provenance.kind !== 'owner') return { required: false, towerTools: 'not-owner-session' };
    // Bound to this run: a later turn, even in the same conversation, gets its own credential.
    return { servers: { tower: toolServer(options.stateDir, '--tower-mcp', [], options.capabilities.issue({ kind: 'owner-run', runId: run.id, sessionId: session.id })) }, required: false, towerTools: 'attached' };
  }
}
