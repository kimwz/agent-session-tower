/** Trusted worker configuration; never accepted from a public session request. */
export interface SessionMcpServer {
  command: string;
  args: string[];
}
export type SessionMcpServers = Record<string, SessionMcpServer>;
