import { encryptedVaultOf } from '../secrets/imports.js';
import { parseModelSettings } from '../../shared/models.js';
import { join } from 'node:path';
import type { BackupPart } from '../../shared/backup.js';
import { mergeTriggerSecrets, secretsBackupOf, type TriggerBackup } from '../triggers/backup.js';
import type { SkillBackup } from '../skills/backup.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { restoreSlackConnection } from '../slack/backup.js';
import { restorePublicAgents } from '../public-agents/backup.js';

export type { TriggerBackup, SkillBackup };

/** Files the execution worker reads once when it starts, by the part of the settings they hold. */
export const WORKER_FILES = {
  'trigger-secrets.json': 'triggerSecrets',
  'permissions.json': 'permissions',
  'models.json': 'models',
  'slack-connection.json': 'slack',
  'slack-tone.json': 'slack',
  'slack-automation.json': 'slack',
  'github-automation.json': 'github',
  'public-agents.json': 'publicAgents',
} as const satisfies Record<string, BackupPart>;
export type WorkerFile = keyof typeof WORKER_FILES;

/** Settings owned by the worker's SQL services; payload v1 keeps its existing file keys. */
export type WorkerSqlFile = 'permissions.json' | 'slack-automation.json' | 'github-automation.json';
export type WorkerSqlSettings = Record<WorkerSqlFile, unknown>;
export interface WorkerSettingsOwner {
  restore(name: WorkerSqlFile, incoming: unknown): Promise<void>;
  guardSlackConnection(existing: unknown, incoming: unknown): Promise<void>;
}
const sqlFile = (name: WorkerFile): name is WorkerSqlFile => name === 'permissions.json' || name === 'slack-automation.json' || name === 'github-automation.json';

/** What the execution worker restores when it starts. */
export interface WorkerRestore {
  /** The restore it belongs to (`RestoreReport.id`). */
  id?: string;
  /** Parts a worker already applied (files and triggers), so a later worker only does what is left. */
  done?: { parts: BackupPart[]; errors: string[] };
  files: Partial<Record<WorkerFile, unknown>>;
  encryptedVault?: string;
  triggers?: TriggerBackup;
  skills?: SkillBackup;
}

export interface BackupPayload {
  version: 1;
  /** The mark of the Tower that made it (see BackupService), telling this computer's backups from another's. */
  machine?: string;
  worker: WorkerRestore;
  web: { projectGroups?: unknown; remoteExclusions?: unknown; decisions?: unknown; backup?: unknown };
  master?: { settings?: Record<string, unknown>; voiceKey?: string };
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

async function readOptional(path: string): Promise<unknown> {
  try { return await readPrivateJson(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** The settings part of each worker file: what a backup keeps of it. Runtime records stay on their computer. */
function settingsOf(name: WorkerFile, value: unknown): unknown {
  if (name === 'trigger-secrets.json') return secretsBackupOf(value);
  if (!record(value)) return undefined;
  switch (name) {
    default: return value;
  }
}

/** SQL settings come from the worker owner; file-owned settings retain their existing format. */
export async function collectWorkerFiles(stateDir: string, owner?: () => Promise<WorkerSqlSettings>): Promise<WorkerRestore['files']> {
  const files: WorkerRestore['files'] = {};
  if (!owner) throw new Error('Worker SQL settings owner is unavailable.');
  const settings = await owner();
  const encryptedVault = await encryptedVaultOf(stateDir);
  for (const name of Object.keys(WORKER_FILES) as WorkerFile[]) {
    if (encryptedVault && name === 'trigger-secrets.json') continue;
    const kept = sqlFile(name) ? settings[name] : settingsOf(name, await readOptional(join(stateDir, name)));
    if (sqlFile(name) && kept === undefined) throw new Error('Worker SQL settings DTO is incomplete.');
    if (kept !== undefined) files[name] = kept;
  }
  return files;
}

/** Worker owner DTO; the web process never reads trigger JSON or opens a second DB. */
export async function collectTriggers(owner: () => Promise<TriggerBackup | undefined>): Promise<TriggerBackup | undefined> {
  return owner();
}

/**
 * Writes the worker's files from a backup, each merged with what this computer holds: the backup's settings, this
 * computer's runtime records. Only called by a worker that holds its lock and has not started its services yet.
 */
export async function applyWorkerFiles(stateDir: string, files: WorkerRestore['files'], owner?: WorkerSettingsOwner): Promise<{ parts: BackupPart[]; errors: string[] }> {
  const parts = new Set<BackupPart>(), errors: string[] = [];
  // A file here that cannot be read is left alone: merging into it would drop the records it holds.
  const unreadable = new Set<WorkerFile>();
  const current = async (name: WorkerFile) => readOptional(join(stateDir, name)).catch(() => { unreadable.add(name); return undefined; });
  // A different Slack account is not switched in while the current one still has work under way.
  let slackBlocked = false;
  if (files['slack-connection.json'] !== undefined) {
    try {
      if (!owner) throw new Error('Worker SQL settings owner is unavailable.');
      await owner.guardSlackConnection(await current('slack-connection.json'), files['slack-connection.json']);
      if (unreadable.has('slack-connection.json')) throw new Error('Slack connection cannot be read.');
    } catch (error) {
      slackBlocked = true;
      errors.push(`slack-connection.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const name of Object.keys(WORKER_FILES) as WorkerFile[]) {
    const incoming = files[name];
    if (name === 'trigger-secrets.json' && incoming !== undefined && await encryptedVaultOf(stateDir)) { errors.push('trigger-secrets.json: Vault가 초기화되어 평문 시크릿 복원은 거부했습니다. 암호화 가져오기를 사용하세요.'); continue; }
    if (incoming === undefined || (slackBlocked && (name === 'slack-connection.json' || name === 'slack-tone.json'))) continue;
    try {
      if (sqlFile(name)) {
        if (!owner) throw new Error('Worker SQL settings owner is unavailable.');
        await owner.restore(name, incoming);
        parts.add(WORKER_FILES[name]);
        continue;
      }
      const existing = await current(name);
      if (unreadable.has(name)) throw new Error('이 컴퓨터의 파일을 읽지 못해 건너뛰었습니다.');
      let next: unknown;
      switch (name) {
        case 'trigger-secrets.json': next = mergeTriggerSecrets(incoming, existing); if (next === undefined) throw new Error('invalid'); break;
        // Read again by every call, so it applies as soon as it is written. Read like a saved file: roles this version does not know are dropped.
        case 'models.json': if (!record(incoming)) throw new Error('invalid'); next = parseModelSettings(incoming); break;
        // What the worker's services refuse at start is never written: one would keep the worker from starting.
        case 'slack-connection.json': next = restoreSlackConnection(incoming); if (next === undefined) throw new Error('invalid'); break;
        case 'public-agents.json': next = await restorePublicAgents(stateDir, incoming, existing); if (next === undefined) throw new Error('invalid'); break;
        default: if (!record(incoming)) throw new Error('invalid'); next = incoming;
      }
      if (name === 'slack-connection.json') {
        if (!owner) throw new Error('Worker SQL settings owner is unavailable.');
        await owner.guardSlackConnection(await readOptional(join(stateDir, name)), next);
      }
      await writePrivateJson(join(stateDir, name), JSON.stringify(next));
      parts.add(WORKER_FILES[name]);
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error && error.message !== 'invalid' ? error.message : '백업의 내용이 올바르지 않아 건너뛰었습니다.'}`);
    }
  }
  return { parts: [...parts], errors };
}

/** Which parts a payload holds, in the order the page lists them. */
export function payloadParts(payload: BackupPayload): BackupPart[] {
  const parts = new Set<BackupPart>();
  if (payload.worker.encryptedVault) parts.add('secretVault');
  if (payload.worker.triggers) parts.add('triggers');
  for (const name of Object.keys(payload.worker.files) as WorkerFile[]) parts.add(WORKER_FILES[name]);
  if (payload.worker.skills) parts.add('skills');
  if (payload.web.decisions !== undefined) parts.add('decisions');
  if (payload.web.projectGroups !== undefined) parts.add('projectGroups');
  if (payload.web.remoteExclusions !== undefined) parts.add('remoteExclusions');
  if (payload.master) parts.add('master');
  if (payload.web.backup !== undefined) parts.add('backup');
  return ORDER.filter(part => parts.has(part));
}
const ORDER: BackupPart[] = ['triggers', 'triggerSecrets', 'secretVault', 'permissions', 'models', 'slack', 'github', 'publicAgents', 'skills', 'decisions', 'projectGroups', 'remoteExclusions', 'master', 'backup'];

/** A decrypted payload, checked for its shape; the parts themselves are checked when each is restored. */
export function parsePayload(value: unknown): BackupPayload {
  if (!record(value) || value.version !== 1 || !record(value.worker) || !record(value.web) || !record(value.worker.files)) throw new Error('백업의 내용이 올바르지 않습니다.');
  const files: WorkerRestore['files'] = {};
  for (const name of Object.keys(WORKER_FILES) as WorkerFile[]) if (value.worker.files[name] !== undefined) files[name] = value.worker.files[name];
  const encryptedVault = value.worker.encryptedVault;
  if (encryptedVault !== undefined && (typeof encryptedVault !== 'string' || encryptedVault.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encryptedVault) || Buffer.from(encryptedVault, 'base64').toString('base64') !== encryptedVault)) throw new Error('백업의 암호화 Vault가 올바르지 않습니다.');
  const triggers = value.worker.triggers, skills = value.worker.skills;
  if (triggers !== undefined && !(record(triggers) && Array.isArray(triggers.triggers) && Array.isArray(triggers.trustedFolders) && record(triggers.secretGrants) && record(triggers.fired) && record(triggers.github))) throw new Error('백업의 트리거가 올바르지 않습니다.');
  if (skills !== undefined && !(record(skills) && record(skills.bundle) && Array.isArray(skills.bundle.skills) && typeof skills.guidance === 'string' && record(skills.settings))) throw new Error('백업의 스킬이 올바르지 않습니다.');
  const master = value.master;
  if (master !== undefined && !(record(master) && (master.settings === undefined || record(master.settings)) && (master.voiceKey === undefined || typeof master.voiceKey === 'string'))) throw new Error('백업의 마스터 설정이 올바르지 않습니다.');
  const web = value.web;
  return { version: 1, ...(typeof value.machine === 'string' ? { machine: value.machine } : {}), worker: { files, ...(encryptedVault ? { encryptedVault } : {}), ...(triggers ? { triggers: triggers as unknown as TriggerBackup } : {}), ...(skills ? { skills: skills as unknown as SkillBackup } : {}) },
    web: { ...(web.projectGroups !== undefined ? { projectGroups: web.projectGroups } : {}), ...(web.remoteExclusions !== undefined ? { remoteExclusions: web.remoteExclusions } : {}),
      ...(web.decisions !== undefined ? { decisions: web.decisions } : {}), ...(web.backup !== undefined ? { backup: web.backup } : {}) },
    ...(master ? { master: master as BackupPayload['master'] } : {}) };
}
