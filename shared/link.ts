/** What this browser sees about remote links. Only this computer's own browser receives it. */
export interface LinkAddress { url: string; kind: 'custom' | 'tailscale' | 'local-name' | 'lan' }
export interface HubStatus { enabled: boolean; port: number; listening: boolean; error?: string; addresses: LinkAddress[] }
export type NodeStatus = 'connected' | 'offline' | 'update-required' | 'removed-by-node';
/** A computer this one controls. */
export interface NodeSummary {
  id: string; name: string; label?: string; fingerprint: string; status: NodeStatus;
  version?: string; features: string[]; pairedAt: string; lastSeenAt?: string;
}
export type ControllerStatus = 'connected' | 'connecting' | 'offline' | 'expired' | 'refused';
/** A computer that controls this one. */
export interface ControllerSummary {
  id: string; name: string; fingerprint: string; state: 'claiming' | 'paired' | 'expired'; status: ControllerStatus;
  pairedAt?: string; lastConnectedAt?: string; error?: string;
}
export interface LinkOverview {
  identity: { name: string; fingerprint: string };
  hub: HubStatus;
  nodes: NodeSummary[];
  controllers: ControllerSummary[];
  /** `error` is set while the saved list cannot be read; every folder is then hidden from remote computers. */
  exclusions: { folders: string[]; revision: number; error?: string };
}
export interface LinkInvite { code: string; command: string; expiresAt: number }
