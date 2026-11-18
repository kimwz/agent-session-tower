import type { RemoteMcpKeyView } from '../../shared/remote-mcp.js';
import { answerRpc, type ToolBridge } from '../mcp/stdio.js';
import { OWNER_TOOLS, OWNER_TOOLS_SERVER, OwnerTools } from '../owner-mcp/tools.js';
import { AGENT_REFUSED, apiTarget } from '../tower-tools/api-target.js';

const READ_ONLY = 'This key has read scope: tower_api may only read (GET routes and read-only /api/v1 operations).';

/** Whether a key of `scope` may make this call; a key with read scope never changes anything. */
export function remoteCallAllowed(scope: RemoteMcpKeyView['scope'], name: string, args: Record<string, unknown>): string | undefined {
  if (scope === 'write' || name !== 'tower_api') return undefined;
  try {
    const target = apiTarget(String(args.method), String(args.path), typeof args.node === 'string' && args.node ? args.node : undefined, AGENT_REFUSED);
    return target.write ? `읽기 권한 키로는 바꿀 수 없습니다: ${target.method} ${target.local}` : undefined;
  } catch { return undefined; /* The tools refuse a path they cannot read, with their own reason. */ }
}

/**
 * Tower's tools for the owner's outside MCP clients at `/mcp` on the public HTTPS address (MCP over HTTP, JSON answers,
 * no sessions). They call this web over loopback as a remote agent (`X-Tower-Agent: remote`), which the web serves with
 * a remote page's rights less the owner's own acts; a key's scope narrows them further here.
 */
export function remoteMcpOverHttp(stateDir: string, port: () => number | undefined): { answer(body: unknown, key: RemoteMcpKeyView): Promise<unknown>; close(): void } {
  const tools = new OwnerTools(stateDir, { agent: 'remote', ports: async () => { const known = port(); return known ? [known] : []; } });
  const bridge = (key: RemoteMcpKeyView): ToolBridge => ({
    name: OWNER_TOOLS_SERVER,
    listTools: async () => key.scope === 'write' ? OWNER_TOOLS : OWNER_TOOLS.map(tool => tool.name === 'tower_api' ? { ...tool, description: `${tool.description} ${READ_ONLY}` } : tool),
    callTool: async (name, args) => {
      const refused = remoteCallAllowed(key.scope, name, args);
      return refused ? { error: refused } : tools.call(name, args);
    },
  });
  return { answer: (body, key) => answerRpc(bridge(key), body), close: () => tools.close() };
}
