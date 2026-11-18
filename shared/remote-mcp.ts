/** What a remote MCP key may do: read only, or change things too. */
export const REMOTE_MCP_SCOPES = ['read', 'write'] as const;
export type RemoteMcpScope = typeof REMOTE_MCP_SCOPES[number];

/** The header an outside MCP client sends its Tower key in (its `Authorization` carries Cloudflare Access's token). */
export const REMOTE_MCP_KEY_HEADER = 'X-Tower-Mcp-Key';

/** A key as the owner's page sees it: never the key or its hash. */
export interface RemoteMcpKeyView {
  id: string;
  name: string;
  scope: RemoteMcpScope;
  /** The key's last four characters, to tell keys apart. */
  hint: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface RemoteMcpOverview {
  keys: RemoteMcpKeyView[];
  /** The `/mcp` address of each HTTPS public URL this Tower answers; none means remote MCP cannot be used. */
  endpoints: string[];
  /** Whether creating a key from this page asks for the Tower password (pages not on this computer). */
  passwordRequired: boolean;
  /** Why saved keys could not be read, when they could not. */
  error?: string;
}

/** The answer to creating a key: the key itself, shown this once. */
export interface RemoteMcpCreated extends RemoteMcpOverview { key: string; created: RemoteMcpKeyView }
