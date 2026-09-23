/** Trusted worker configuration; never accepted from a public session request. */
export interface SessionMcpServer {
  command: string;
  args: string[];
  /** Carries the run's capability; never logged, and Claude receives it in a private file rather than argv. */
  env?: Record<string, string>;
}
export type SessionMcpServers = Record<string, SessionMcpServer>;

/**
 * Tools Tower attaches to one run. Required tools must reach the turn, so a Codex thread
 * held by the desktop app waits instead of being forwarded there without them.
 * Optional tools are dropped when the turn is forwarded to the desktop app.
 */
export interface RunTools {
  servers?: SessionMcpServers;
  required: boolean;
  /** For an owner turn: whether Tower's own tools are attached, and if not, why. */
  towerTools?: 'attached' | 'external-input' | 'not-owner-session';
}
export const NO_RUN_TOOLS: RunTools = { required: false };
