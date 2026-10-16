import type { SessionMcpServer, SessionMcpServers } from './session-mcp.js';
import { MASTER_TOOL_TIMEOUT_SECONDS } from './subscription.js';

/** A tool server as Codex's `mcp_servers` config takes it, with the settings Tower adds for its own servers. */
export interface CodexMcpServer extends SessionMcpServer {
  tool_timeout_sec?: number;
  tools?: Record<string, { approval_mode: 'approve' }>;
}
export type CodexMcpServers = Record<string, CodexMcpServer>;

/**
 * Tower's tools that Codex calls without an approval review, by the server that offers them. The owner's order
 * (2026-10-16): looking up sessions, asking for a permission and listing secret names must never be stopped by the
 * provider's reviewer. What they lead to stays Tower's to decide: a requested rule or run goes through Tower's own
 * review, a secret's use through its broker. Claude turns get the same tools from the owner's saved rules.
 */
export const CODEX_APPROVED_TOWER_TOOLS: Readonly<Record<string, readonly string[]>> = {
  tower: ['sessions_list', 'sessions_read', 'sessions_search', 'permissions_request', 'permissions_list', 'permissions_run', 'permissions_runResult', 'secrets_list'],
  tower_sessions: ['sessions_list', 'sessions_read', 'sessions_search'],
  tower_secrets: ['secrets_list'],
};

/**
 * The servers a Codex turn is given. Codex reads per-tool approval only beside a server's definition, so it is added
 * here rather than in the user's Codex config, where it would name a server that has no command outside Tower. The
 * master's own tools may take longer than Codex's default minute (see MASTER_TOOL_TIMEOUT_SECONDS).
 */
export function codexMcpServers(servers: SessionMcpServers | undefined, master: boolean): CodexMcpServers | undefined {
  if (!servers) return undefined;
  return Object.fromEntries(Object.entries(servers).map(([name, server]): [string, CodexMcpServer] => {
    const approved = Object.hasOwn(CODEX_APPROVED_TOWER_TOOLS, name) ? CODEX_APPROVED_TOWER_TOOLS[name] : undefined;
    return [name, {
      ...server,
      ...(master && name === 'tower_master' ? { tool_timeout_sec: MASTER_TOOL_TIMEOUT_SECONDS } : {}),
      ...(approved ? { tools: Object.fromEntries(approved.map(tool => [tool, { approval_mode: 'approve' as const }])) } : {}),
    }];
  }));
}
