import { join } from 'node:path';
import type { BackupPart } from '../../shared/backup.js';
import type { SkillBundle, SkillAdvisorSettings } from '../../shared/skills.js';
import type { GitHubCursor } from '../triggers/github.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/** Trigger settings as a backup keeps them; the trigger service merges them with what it holds (`TriggerService.start`). */
export interface TriggerBackup {
  triggers: unknown[];
  settings: unknown;
  trustedFolders: string[];
  secretGrants: Record<string, string[]>;
  /** `${triggerId} ${dedupKey}` → when it fired. */
  fired: Record<string, string>;
  /** Per trigger, what its GitHub watch has already taken or noted. */
  github: Record<string, GitHubCursor>;
}

/** Tower's own skills as a backup keeps them; `SkillService.restore` writes them back exactly. */
export interface SkillBackup {
  bundle: SkillBundle;
  /** The owner's guidance, empty included. */
  guidance: string;
  guidanceConfirmed: boolean;
  /** Indexes into `bundle.skills` of the skills whose text the owner had saved or confirmed in Tower. */
  confirmed: number[];
  settings: SkillAdvisorSettings;
}

/** Files the execution worker reads once when it starts, by the part of the settings they hold. */
export const WORKER_FILES = {
  'trigger-secrets.json': 'triggerSecrets',
  'permissions.json': 'permissions',
  'slack-connection.json': 'slack',
  'slack-tone.json': 'slack',
  'slack-automation.json': 'slack',
  'github-automation.json': 'github',
  'public-agents.json': 'publicAgents',
} as const satisfies Record<string, BackupPart>;
export type WorkerFile = keyof typeof WORKER_FILES;

/** What the execution worker restores when it starts. */
export interface WorkerRestore {
  /** The restore it belongs to (`RestoreReport.id`). */
  id?: string;
  files: Partial<Record<WorkerFile, unknown>>;
  triggers?: TriggerBackup;
  skills?: SkillBackup;
}

export interface BackupPayload {
  version: 1;
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
  if (!record(value)) return name === 'trigger-secrets.json' && Array.isArray(value) ? value : undefined;
  switch (name) {
    case 'permissions.json': return { rules: Array.isArray(value.rules) ? value.rules : [], ...(record(value.autoReview) ? { autoReview: value.autoReview } : {}) };
    case 'slack-automation.json':
    case 'github-automation.json': return { rules: value.rules ?? [] };
    default: return value;
  }
}

/** Reads the worker's settings from its files as they are saved now. */
export async function collectWorkerFiles(stateDir: string): Promise<WorkerRestore['files']> {
  const files: WorkerRestore['files'] = {};
  for (const name of Object.keys(WORKER_FILES) as WorkerFile[]) {
    const kept = settingsOf(name, await readOptional(join(stateDir, name)));
    if (kept !== undefined) files[name] = kept;
  }
  return files;
}

/** The trigger engine's settings, from its saved state. */
export async function collectTriggers(stateDir: string): Promise<TriggerBackup | undefined> {
  const saved = await readOptional(join(stateDir, 'trigger-engine.json'));
  if (!record(saved)) return undefined;
  const github: Record<string, GitHubCursor> = {};
  if (record(saved.cursors)) for (const [id, cursor] of Object.entries(saved.cursors)) if (record(cursor) && record(cursor.github)) github[id] = cursor.github as GitHubCursor;
  return {
    triggers: Array.isArray(saved.triggers) ? saved.triggers : [],
    settings: saved.settings ?? {},
    trustedFolders: Array.isArray(saved.trustedFolders) ? saved.trustedFolders.filter((item): item is string => typeof item === 'string') : [],
    secretGrants: record(saved.secretGrants) ? saved.secretGrants as Record<string, string[]> : {},
    fired: record(saved.fired) ? saved.fired as Record<string, string> : {},
    github,
  };
}

/** Slack work not yet finished belongs to the account that received it. */
const UNFINISHED_SLACK = new Set(['received', 'matching', 'dispatching', 'running', 'composing', 'sending', 'reply-uncertain']);
const accountOf = (value: unknown) => record(value) && record(value.account) ? `${value.account.teamId}:${value.account.userId}` : '';

/**
 * Writes the worker's files from a backup, each merged with what this computer holds: the backup's settings, this
 * computer's runtime records. Only called by a worker that holds its lock and has not started its services yet.
 */
export async function applyWorkerFiles(stateDir: string, files: WorkerRestore['files']): Promise<{ parts: BackupPart[]; errors: string[] }> {
  const parts = new Set<BackupPart>(), errors: string[] = [];
  const current = async (name: WorkerFile) => readOptional(join(stateDir, name)).catch(() => undefined);
  // A different Slack account is not switched in while the current one still has work under way.
  let slackBlocked = false;
  if (files['slack-connection.json'] !== undefined && accountOf(files['slack-connection.json']) !== accountOf(await current('slack-connection.json'))) {
    const automation = await current('slack-automation.json');
    if (record(automation) && Array.isArray(automation.workflows) && automation.workflows.some(item => record(item) && UNFINISHED_SLACK.has(String(item.status)))) {
      slackBlocked = true;
      errors.push('진행 중인 Slack 작업이 있어 Slack 연결은 복원하지 않았습니다. 작업이 끝난 뒤 다시 복원하세요.');
    }
  }
  for (const name of Object.keys(WORKER_FILES) as WorkerFile[]) {
    const incoming = files[name];
    if (incoming === undefined || (slackBlocked && (name === 'slack-connection.json' || name === 'slack-tone.json'))) continue;
    try {
      const existing = await current(name);
      let next: unknown;
      switch (name) {
        case 'permissions.json': {
          if (!record(incoming) || !Array.isArray(incoming.rules)) throw new Error('invalid');
          const kept = record(existing) ? existing : {};
          next = { version: 1, requests: Array.isArray(kept.requests) ? kept.requests : [], codex: Array.isArray(kept.codex) ? kept.codex : [], ...(typeof kept.lost === 'string' ? { lost: kept.lost } : {}),
            rules: incoming.rules, ...(record(incoming.autoReview) ? { autoReview: incoming.autoReview } : {}) };
          break;
        }
        case 'slack-automation.json':
        case 'github-automation.json': {
          if (!record(incoming) || !Array.isArray(incoming.rules)) throw new Error('invalid');
          next = { rules: incoming.rules, workflows: record(existing) && Array.isArray(existing.workflows) ? existing.workflows : [] };
          break;
        }
        case 'trigger-secrets.json': if (!Array.isArray(incoming)) throw new Error('invalid'); next = incoming; break;
        default: if (!record(incoming)) throw new Error('invalid'); next = incoming;
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
const ORDER: BackupPart[] = ['triggers', 'triggerSecrets', 'permissions', 'slack', 'github', 'publicAgents', 'skills', 'decisions', 'projectGroups', 'remoteExclusions', 'master', 'backup'];

/** A decrypted payload, checked for its shape; the parts themselves are checked when each is restored. */
export function parsePayload(value: unknown): BackupPayload {
  if (!record(value) || value.version !== 1 || !record(value.worker) || !record(value.web) || !record(value.worker.files)) throw new Error('백업의 내용이 올바르지 않습니다.');
  const files: WorkerRestore['files'] = {};
  for (const name of Object.keys(WORKER_FILES) as WorkerFile[]) if (value.worker.files[name] !== undefined) files[name] = value.worker.files[name];
  const triggers = value.worker.triggers, skills = value.worker.skills;
  if (triggers !== undefined && !(record(triggers) && Array.isArray(triggers.triggers) && Array.isArray(triggers.trustedFolders) && record(triggers.secretGrants) && record(triggers.fired) && record(triggers.github))) throw new Error('백업의 트리거가 올바르지 않습니다.');
  if (skills !== undefined && !(record(skills) && record(skills.bundle) && Array.isArray(skills.bundle.skills) && typeof skills.guidance === 'string' && Array.isArray(skills.confirmed) && record(skills.settings))) throw new Error('백업의 스킬이 올바르지 않습니다.');
  const master = value.master;
  if (master !== undefined && !(record(master) && (master.settings === undefined || record(master.settings)) && (master.voiceKey === undefined || typeof master.voiceKey === 'string'))) throw new Error('백업의 마스터 설정이 올바르지 않습니다.');
  const web = value.web;
  return { version: 1, worker: { files, ...(triggers ? { triggers: triggers as unknown as TriggerBackup } : {}), ...(skills ? { skills: skills as unknown as SkillBackup } : {}) },
    web: { ...(web.projectGroups !== undefined ? { projectGroups: web.projectGroups } : {}), ...(web.remoteExclusions !== undefined ? { remoteExclusions: web.remoteExclusions } : {}),
      ...(web.decisions !== undefined ? { decisions: web.decisions } : {}), ...(web.backup !== undefined ? { backup: web.backup } : {}) },
    ...(master ? { master: master as BackupPayload['master'] } : {}) };
}
