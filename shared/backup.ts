/** A full backup of Tower's settings: one encrypted file, made on the page or uploaded on a schedule. */
export const BACKUP_FORMAT = 'agent-session-tower.backup';
export const BACKUP_EXTENSION = '.towerbackup';
export const MIN_BACKUP_PASSPHRASE = 8;
/** An encrypted backup file is never larger than this; its skills alone may take 20 MB. */
export const MAX_BACKUP_FILE_BYTES = 40 * 1024 * 1024;

/** What a restore brings back, in the words the page shows. */
export type BackupPart = 'triggers' | 'triggerSecrets' | 'permissions' | 'models' | 'slack' | 'github' | 'publicAgents' | 'skills' | 'decisions' | 'projectGroups' | 'remoteExclusions' | 'master' | 'backup';

/** A checked backup, before it is applied. */
export interface BackupPreview {
  id: string;
  createdAt: string;
  from: string;
  towerVersion: string;
  parts: BackupPart[];
  skills: number;
  /** Made on another computer: its triggers and Slack would also run there while its Tower is on. */
  otherComputer: boolean;
}

/** Where the last restore is: waiting for the execution worker to take its part, or done. */
export interface RestoreReport {
  id: string;
  status: 'waiting-worker' | 'applied' | 'cancelled';
  requestedAt: string;
  from: string;
  createdAt: string;
  /** Applied right away by the web and the master. */
  applied: BackupPart[];
  /** Waiting for (or applied by) the execution worker. */
  worker: BackupPart[];
  appliedAt?: string;
  /** Skills written, and those left out with why. */
  skills?: { restored: string[]; skipped: { name: string; reason: string }[] };
  errors: string[];
  /** What the owner should know that is not a failure. */
  notes?: string[];
  /** The folder with copies of every file this restore replaced. */
  before?: string;
}

export interface BackupRemoteInput {
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
  accessKeyId: string;
  /** Write only: left out keeps the saved one. */
  secretAccessKey?: string;
}

export interface BackupSettingsInput {
  enabled: boolean;
  remote: BackupRemoteInput;
  /** Write only: left out keeps the saved one. */
  passphrase?: string;
  intervalHours: number;
  keep: number;
}

export interface BackupStatus {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastKey?: string;
  lastError?: string;
  /** The last backup went up, but removing older ones failed. */
  lastWarning?: string;
  running: boolean;
}

export interface BackupOverview {
  settings: Omit<BackupSettingsInput, 'passphrase' | 'remote'> & { remote: Omit<BackupRemoteInput, 'secretAccessKey'> & { secretSet: boolean }; passphraseSet: boolean };
  status: BackupStatus;
  restore?: RestoreReport;
  /** The execution worker cannot export skills yet (an older build), so no backup can be made until it is replaced. */
  unavailable?: string;
}

export interface RemoteBackup { key: string; size: number; modifiedAt: string }

export const DEFAULT_BACKUP_SETTINGS: BackupSettingsInput = {
  enabled: false,
  remote: { endpoint: '', bucket: '', prefix: 'tower/', region: 'auto', accessKeyId: '' },
  intervalHours: 24,
  keep: 14,
};
