import { parseModelSettings } from '../../shared/models.js';
import { join } from 'node:path';
import type { BackupPart } from '../../shared/backup.js';
import type { SkillBundle, SkillAdvisorSettings } from '../../shared/skills.js';
import type { GitHubCursor } from '../triggers/github.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { validateSlackRules } from '../slack/automation.js';
import { validSlackConnection } from '../slack/service.js';
import { parsePublicAgents } from '../public-agents/service.js';

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
  settings: SkillAdvisorSettings;
}

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

/** What the execution worker restores when it starts. */
export interface WorkerRestore {
  /** The restore it belongs to (`RestoreReport.id`). */
  id?: string;
  /** Parts a worker already applied (files and triggers), so a later worker only does what is left. */
  done?: { parts: BackupPart[]; errors: string[] };
  files: Partial<Record<WorkerFile, unknown>>;
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
  // A file here that cannot be read is left alone: merging into it would drop the records it holds.
  const unreadable = new Set<WorkerFile>();
  const current = async (name: WorkerFile) => readOptional(join(stateDir, name)).catch(() => { unreadable.add(name); return undefined; });
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
      if (unreadable.has(name)) throw new Error('이 컴퓨터의 파일을 읽지 못해 건너뛰었습니다.');
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
          // GitHub automation keeps its rules in the same form as Slack's (one coordinator manager for both).
          try { validateSlackRules(incoming.rules); } catch { throw new Error('invalid'); }
          next = { rules: incoming.rules, workflows: record(existing) && Array.isArray(existing.workflows) ? existing.workflows : [] };
          break;
        }
        case 'trigger-secrets.json': {
          // The backup's secrets come in (its value wins for the same one); secrets only this computer has stay, so a
          // trigger kept here never loses the one it uses.
          if (!Array.isArray(incoming) || !incoming.every(item => record(item) && ['id', 'name', 'origin', 'value', 'createdAt'].every(key => typeof item[key] === 'string'))) throw new Error('invalid');
          const ids = new Set(incoming.map(item => (item as { id: string }).id));
          next = [...incoming, ...(Array.isArray(existing) ? existing.filter(item => record(item) && !ids.has(String(item.id))) : [])];
          break;
        }
        // Read again by every call, so it applies as soon as it is written. Read like a saved file: roles this version does not know are dropped.
        case 'models.json': if (!record(incoming)) throw new Error('invalid'); next = parseModelSettings(incoming); break;
        // What the worker's services refuse at start is never written: one would keep the worker from starting.
        case 'slack-connection.json': if (!validSlackConnection(incoming)) throw new Error('invalid'); next = incoming; break;
        case 'public-agents.json': {
          const agents = parsePublicAgents(incoming);
          if (!agents) throw new Error('invalid');
          await signOutChangedVisitors(stateDir, parsePublicAgents(existing) ?? [], agents);
          next = incoming;
          break;
        }
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

/**
 * A restored public agent whose password or address differs from this computer's signs its visitors out, as changing
 * them on the page does: a visitor let in under one password is never let in under another.
 */
async function signOutChangedVisitors(stateDir: string, current: { id: string; slug: string; password?: unknown; conversation?: string }[], restored: { id: string; slug: string; password?: unknown; conversation?: string }[]): Promise<void> {
  for (const agent of restored) {
    const before = current.find(item => item.id === agent.id);
    const moved = !before || before.slug !== agent.slug, repassworded = !before || JSON.stringify(before.password) !== JSON.stringify(agent.password);
    const regrouped = !before || before.conversation !== agent.conversation;
    if (!moved && !repassworded && !regrouped) continue;
    const path = join(stateDir, 'public-agents', `${agent.id}.json`);
    const data = await readOptional(path);
    if (!record(data) || !Array.isArray(data.visitors)) continue;
    // Another way of sharing conversations starts each visitor's anew, as it does on the page.
    const visitors = moved ? [] : data.visitors.map(visitor => {
      if (!record(visitor)) return visitor;
      const { conversationId: _conversation, ...rest } = visitor;
      return { ...(regrouped ? rest : visitor), ...(repassworded ? { authorized: false } : {}) };
    });
    await writePrivateJson(path, JSON.stringify({ ...data, visitors }));
  }
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
const ORDER: BackupPart[] = ['triggers', 'triggerSecrets', 'permissions', 'models', 'slack', 'github', 'publicAgents', 'skills', 'decisions', 'projectGroups', 'remoteExclusions', 'master', 'backup'];

/** A decrypted payload, checked for its shape; the parts themselves are checked when each is restored. */
export function parsePayload(value: unknown): BackupPayload {
  if (!record(value) || value.version !== 1 || !record(value.worker) || !record(value.web) || !record(value.worker.files)) throw new Error('백업의 내용이 올바르지 않습니다.');
  const files: WorkerRestore['files'] = {};
  for (const name of Object.keys(WORKER_FILES) as WorkerFile[]) if (value.worker.files[name] !== undefined) files[name] = value.worker.files[name];
  const triggers = value.worker.triggers, skills = value.worker.skills;
  if (triggers !== undefined && !(record(triggers) && Array.isArray(triggers.triggers) && Array.isArray(triggers.trustedFolders) && record(triggers.secretGrants) && record(triggers.fired) && record(triggers.github))) throw new Error('백업의 트리거가 올바르지 않습니다.');
  if (skills !== undefined && !(record(skills) && record(skills.bundle) && Array.isArray(skills.bundle.skills) && typeof skills.guidance === 'string' && record(skills.settings))) throw new Error('백업의 스킬이 올바르지 않습니다.');
  const master = value.master;
  if (master !== undefined && !(record(master) && (master.settings === undefined || record(master.settings)) && (master.voiceKey === undefined || typeof master.voiceKey === 'string'))) throw new Error('백업의 마스터 설정이 올바르지 않습니다.');
  const web = value.web;
  return { version: 1, ...(typeof value.machine === 'string' ? { machine: value.machine } : {}), worker: { files, ...(triggers ? { triggers: triggers as unknown as TriggerBackup } : {}), ...(skills ? { skills: skills as unknown as SkillBackup } : {}) },
    web: { ...(web.projectGroups !== undefined ? { projectGroups: web.projectGroups } : {}), ...(web.remoteExclusions !== undefined ? { remoteExclusions: web.remoteExclusions } : {}),
      ...(web.decisions !== undefined ? { decisions: web.decisions } : {}), ...(web.backup !== undefined ? { backup: web.backup } : {}) },
    ...(master ? { master: master as BackupPayload['master'] } : {}) };
}
