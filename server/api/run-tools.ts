import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { subscriptionOnly } from '../runs/subscription.js';
import type { Run, Session } from '../../shared/types.js';
import { browserTools, type BrowserEnvironment, type BrowserTools } from '../browser/tools.js';
import type { RunManager } from '../runs/manager.js';
import { CALLER_CAPABILITY_ENV, type RunTools, type SessionMcpServer, type SessionMcpServers } from '../runs/session-mcp.js';
import type { SlackService } from '../slack/service.js';
import type { GitHubCoordinator } from '../triggers/github-coordinator.js';
import type { CapabilityRegistry } from './mcp.js';
import type { SecretRuntime } from '../secrets/runtime.js';
import { SESSION_TOOLS_SERVER, sessionToolServer } from './session-tools.js';

/** How to start this build's own entry, so a tool server always matches the worker that answers it. */
export function thisBuild(): { command: string; args: string[] } {
  const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url));
  return { command: process.execPath, args: isSea() ? [] : [...process.execArgv.filter(arg => !/^--inspect(?:-brk|-port|-publish-uid)?(?:=|$)/.test(arg)), entry] };
}
/** The master session's page tools; they reach the master host, which only the owner's own processes can. */
function masterToolServer(stateDir: string, capability?: string): SessionMcpServer {
  const build = thisBuild();
  return { command: build.command, args: [...build.args, '--master-mcp', stateDir, ...(capability ? ['--heartbeat'] : [])], ...(capability ? { env: { TOWER_HEARTBEAT_CAPABILITY: capability } } : {}) };
}
function toolServer(stateDir: string, mode: '--tower-mcp' | '--slack-mcp', extra: string[], capability: string): SessionMcpServer {
  const build = thisBuild();
  return { command: build.command, args: [...build.args, mode, stateDir, ...extra], env: { TOWER_MCP_CAPABILITY: capability } };
}

/** The browsers a turn in this conversation gets; a conversation that holds outside content gets fewer (see browser/tools.ts). */
export function sessionBrowsers(stateDir: string, runs: Pick<RunManager, 'sessionOrigin'>, session: Session, environment?: BrowserEnvironment): BrowserTools {
  return browserTools(thisBuild(), stateDir, session.provider, runs.sessionOrigin(session.id)?.untrustedInput === true, environment);
}

/**
 * Which tools a turn receives. Every turn in a session that may use secrets (see secrets/access.ts) gets its own secret
 * broker, whoever started it; nothing else follows from that. Slack coordinator turns get their conversation tools. A turn
 * the owner started from Tower, here or from a controlling computer, gets Tower's tools, unless its conversation holds
 * outside content or its origin cannot be proven; a controlling computer's turn then sees only what that computer may see.
 * Trigger, Slack and ordinary agent-started turns never get Tower's tools. A trusted local heartbeat run receives only
 * two scoped master tools, without the generic lookups, browsers or owner capability below. Other turns started here get the read-only session
 * lookups, which Claude Code and Codex elsewhere on this computer get from their user configuration. The owner's turns in
 * the master's folder also get the master's page tools. Those other turns, whoever started them, get the browsers
 * (see browser/tools.ts).
 */
export function runToolResolver(options: { stateDir: string; runs: Pick<RunManager, 'sessionOrigin'>; slack?: Pick<SlackService, 'sessionMcp'>; github?: Pick<GitHubCoordinator, 'sessionWorkflow'>; capabilities: CapabilityRegistry; secrets?: Pick<SecretRuntime, 'initialized' | 'subject'>; browsers?: () => BrowserEnvironment }) {
  const lookups = { [SESSION_TOOLS_SERVER]: sessionToolServer(options.stateDir, thisBuild()) };
  const withBrowsers = (session: Session, tools: RunTools): RunTools => {
    const browsers = sessionBrowsers(options.stateDir, options.runs, session, options.browsers?.());
    return { ...tools, servers: { ...tools.servers, ...browsers.servers }, claudeChrome: browsers.claudeChrome };
  };
  /** The secret broker, bound to this run alone: a later turn, even in the same conversation, gets its own credential. */
  const secretTools = (run: Run, session: Session): SessionMcpServers => {
    if (!options.secrets || options.secrets.subject(session, run).mode === 'none') return {};
    const build = thisBuild();
    return { tower_secrets: { command: build.command, args: [...build.args, '--secrets-mcp', options.stateDir],
      env: { TOWER_SECRET_CAPABILITY: options.capabilities.issue({ kind: 'secret-run', runId: run.id, sessionId: session.id }), TOWER_SECRET_STATE_DIR: options.stateDir } } };
  };
  return (run: Run, session: Session): RunTools => {
    const provenance = options.runs.sessionOrigin(session.id);
    const secrets = secretTools(run, session);
    if (run.heartbeat?.targets?.length && run.sessionId === session.id && !run.ownerStopped && run.origin?.kind === 'agent' && !run.origin.controllerId
      && !provenance?.untrustedInput && (!provenance || provenance.kind === 'owner') && subscriptionOnly(options.stateDir, session.cwd)) {
      const capability = options.capabilities.issue({ kind: 'caller-run', runId: run.id, sessionId: run.sessionId });
      return { servers: { tower_master: masterToolServer(options.stateDir, capability), ...secrets }, required: true };
    }
    const tools = resolve(run, session, secrets);
    if (run.origin?.controllerId) return withBrowsers(session, tools);
    const env = { [CALLER_CAPABILITY_ENV]: options.capabilities.issue({ kind: 'caller-run', runId: run.id, sessionId: run.sessionId }) };
    // A global HTTP MCP connection has no per-turn environment. Override it only where owner tools already belong.
    const local: SessionMcpServers = tools.towerTools === 'attached' && !subscriptionOnly(options.stateDir, session.cwd)
      ? { tower_local: { ...thisBuild(), args: [...thisBuild().args, 'mcp', '--state-dir', options.stateDir], env } } : {};
    // Given here too, so they work even where the user configuration does not name them.
    return withBrowsers(session, { ...tools, env, servers: { ...tools.servers, ...local, ...lookups } });
  };
  /** `secrets` joins whatever else the turn gets; a turn that gains only them never waits or fails for them (`required` unchanged). */
  function resolve(run: Run, session: Session, secrets: SessionMcpServers): RunTools {
    const origin = run.origin;
    const slack = options.slack?.sessionMcp(session.id)?.tower_slack;
    const coordinated = options.github?.sessionWorkflow(session.id);
    // Remote work never receives a coordinator's tools, whatever conversation it lands in.
    if (origin?.controllerId && (slack || coordinated)) return { servers: secrets, required: false, towerTools: 'remote' };
    if (slack) {
      const workflowId = slack.args.at(-1)!;
      return { servers: { tower_slack: toolServer(options.stateDir, '--slack-mcp', [workflowId], options.capabilities.issue({ kind: 'slack-workflow', workflowId })), ...secrets }, required: true };
    }
    // A GitHub coordinator conversation gets its conversation tools, whoever started the turn.
    if (coordinated) return { servers: { tower_github: toolServer(options.stateDir, '--tower-mcp', [], options.capabilities.issue({ kind: 'github-workflow', workflowId: coordinated })), ...secrets }, required: true };
    if (origin?.kind !== 'owner') return { servers: secrets, required: false };
    const provenance = options.runs.sessionOrigin(session.id);
    if (provenance?.untrustedInput) return { servers: secrets, required: false, towerTools: 'external-input' };
    if (provenance && provenance.kind !== 'owner') return { servers: secrets, required: false, towerTools: 'not-owner-session' };
    // Bound to this run: a later turn, even in the same conversation, gets its own credential.
    const tower = toolServer(options.stateDir, '--tower-mcp', [], options.capabilities.issue({ kind: 'owner-run', runId: run.id, sessionId: session.id }));
    const servers: SessionMcpServers = { tower, ...secrets };
    if (!origin.controllerId && subscriptionOnly(options.stateDir, session.cwd)) servers.tower_master = masterToolServer(options.stateDir);
    // The owner's own top-level conversation waits for its secrets rather than starting without them, as it always has.
    const child = session.isSubagent || session.launchedByAgent || session.parentId || session.launchedBy;
    return { servers, required: Boolean(secrets.tower_secrets && !child && options.secrets?.initialized()), towerTools: 'attached' };
  }
}
