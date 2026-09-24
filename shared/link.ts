/** What this browser sees about remote links. Only this computer's own browser receives it. */
export interface LinkAddress { url: string; kind: 'custom' | 'tailscale' | 'local-name' | 'lan' }
export interface HubStatus { enabled: boolean; port: number; listening: boolean; error?: string; addresses: LinkAddress[] }
export type NodeStatus = 'connected' | 'offline' | 'update-required' | 'removed-by-node';
/** Where an update of a joined computer stands. Until `done`, the computer runs its previous version again on failure. */
export type UpdateStage = 'installing' | 'checking' | 'switching' | 'verifying' | 'rolling-back' | 'done' | 'failed';
export type UpdateFailure = 'low-disk' | 'install-failed' | 'check-failed' | 'switch-failed' | 'start-failed' | 'link-failed' | 'rollback-failed' | 'interrupted';
export interface UpdateStatus {
  version: string; previous: string; stage: UpdateStage; startedAt: string; updatedAt: string;
  /** Why it failed, and the stage it failed in. */
  code?: UpdateFailure; failedStage?: UpdateStage;
}
/** What a joined computer reports about itself: structured facts only, never paths or log text. */
export interface NodeReport {
  versions: { web: string; worker?: string; terminalHost?: string };
  /** It runs as the background service and can update itself. */
  service: boolean;
  update?: UpdateStatus;
  diskFree?: number;
}
/** A computer this one controls. */
export interface NodeSummary {
  id: string; name: string; label?: string; fingerprint: string; status: NodeStatus;
  version?: string; features: string[]; pairedAt: string; lastSeenAt?: string;
  /** The code it last joined with. */
  invite?: string;
  /** Its last report, kept while it restarts for an update. */
  report?: NodeReport;
}
export type ControllerStatus = 'connected' | 'connecting' | 'offline' | 'expired' | 'refused' | 'removed';
/** A computer that controls this one. */
export interface ControllerSummary {
  id: string; name: string; fingerprint: string; state: 'claiming' | 'paired' | 'expired' | 'removed'; status: ControllerStatus;
  pairedAt?: string; lastConnectedAt?: string; error?: string;
}
export interface LinkOverview {
  identity: { name: string; fingerprint: string; version: string };
  hub: HubStatus;
  nodes: NodeSummary[];
  controllers: ControllerSummary[];
  /** `error` is set while the saved list cannot be read; every folder is then hidden from remote computers. */
  exclusions: { folders: string[]; revision: number; error?: string };
  /** Saved link state that could not be read; nothing is changed until the owner deals with it. */
  errors?: string[];
}
/** A change a controlling computer made on this one, as this computer's owner reads it. */
export type RemoteAction = 'joined' | 'update' | 'session' | 'message' | 'title' | 'close' | 'reopen' | 'approval' | 'steer' | 'cancel' | 'dismiss' | 'auto-prompt'
  | 'auto-prompt-cancel' | 'repository' | 'folder-name' | 'file' | 'directory' | 'terminal-open' | 'terminal-close' | 'trigger';
export interface RemoteChange {
  at: string; controllerId: string; action: RemoteAction;
  /** The controlling computer's name: now, or when it made the change if it has been released since. */
  controller?: string;
  /** Where it happened: a folder or file path, or a trigger's name. Never content. */
  target?: string;
  /** The conversation it was about, by id. Its title is looked up as the record is read here, never stored. */
  session?: string;
  /** That conversation's title now, while it still exists. */
  name?: string;
  /**
   * What was done: pull or push; what was done to a trigger (as in its change history); allow, deny, answered,
   * accept, decline or cancel for an approval; the version asked for by an update.
   */
  detail?: string;
}
export interface LinkInvite { id: string; code: string; command: string; expiresAt: number }
/** A joined computer as this Tower's own page shows it, beside its shared snapshot. */
export interface RemoteNode {
  id: string; name: string; label?: string; status: NodeStatus; version?: string; features: string[]; lastSeenAt?: string;
  /** Its shared state is arriving now; otherwise what is shown of it is the last state seen. */
  streaming: boolean;
  /** It is moving to this Tower's version and comes back by itself. */
  updating?: boolean;
}
