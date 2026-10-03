import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillAdvisorSettings, SkillNote, SkillProposal } from '../../shared/skills.js';
import { quarantineFile, readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { SkillError } from './files.js';

/** What Tower keeps about skills beside the skill folders themselves, in `<state>/skills.json`. */
export interface SkillState {
  version: 1;
  /** Skills named in the guidance; a project skill with the project it belongs to. */
  pinned: { dir: string; cwd?: string }[];
  /** Where each skill kept in Tower applies, by its folder. */
  targets: SkillTargetRecord[];
  settings: SkillAdvisorSettings;
  proposals: SkillProposal[];
  notes: SkillNote[];
  /** Sessions someone other than the owner here worked in once; kept after their runs are gone. */
  excluded: string[];
  /** Per session, the time of the last owner request the advisor has read. */
  reflected: Record<string, string>;
  /** Requests before this were never read one by one; the 7-day analysis covers them. */
  startedAt: string;
  calls: { day: string; count: number };
  /** Default skills Tower made once (or found already there); never made again, even after the owner removed them. */
  seeded: string[];
}

/**
 * Where a Tower skill applies (`all`, `projects`), and every place Tower may have linked it (`linked`, `globalLinked`):
 * a superset written before any link is made and narrowed only after the links match, so a link is never forgotten.
 */
export interface SkillTargetRecord { dir: string; all: boolean; projects: string[]; linked: string[]; globalLinked: boolean }

export const MAX_PROPOSALS = 60;
export const MAX_NOTES = 200;
/** Far above what the limits below can add up to (60 drafts of 16,000 characters, 200 notes). */
const MAX_BYTES = 12_000_000;
const MAX_REFLECTED = 2_000;

export function emptySkillState(now = new Date()): SkillState {
  return { version: 1, pinned: [], targets: [], settings: { enabled: true, provider: 'claude' }, proposals: [], notes: [], excluded: [], reflected: {}, startedAt: now.toISOString(), calls: { day: '', count: 0 }, seeded: [] };
}

export class SkillStateStore {
  private readonly path: string;
  private state: SkillState = emptySkillState();
  private writes: Promise<void> = Promise.resolve();
  /** Set when an unreadable file could not be moved aside: no change is made or saved until Tower restarts. */
  locked?: string;

  constructor(private readonly stateDir: string) { this.path = join(stateDir, 'skills.json'); }

  async start(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    let saved: unknown;
    try { saved = await readPrivateJson(this.path, MAX_BYTES); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await this.save(); return; }
      return this.setAside(error);
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return this.setAside(new Error('Saved skill state is invalid.'));
    this.state = normalize(saved);
  }

  /**
   * A file this build cannot read is kept aside, never overwritten, and skills start over; the worker still starts.
   * One that cannot be moved locks the store: skills stay empty in memory and nothing changes until a restart.
   */
  private async setAside(error: unknown): Promise<void> {
    const message = (value: unknown) => value instanceof Error ? value.message : String(value);
    let moveError: Error | undefined;
    await quarantineFile(this.path).catch((reason: unknown) => { moveError = reason instanceof Error ? reason : new Error(String(reason)); });
    console.error(`Skill state was set aside: ${message(error)}`);
    if (!moveError) { await this.save(); return; }
    this.locked = 'Skill state could not be read or moved aside; skills are not changed until Tower restarts.';
    console.error(`${this.locked} ${moveError.message}`);
  }

  get(): SkillState { return this.state; }

  /** Changes the state and writes it; writes are kept in order. */
  update(change: (state: SkillState) => void): Promise<void> {
    if (this.locked) return Promise.reject(new SkillError(this.locked, 'unavailable'));
    change(this.state);
    trim(this.state);
    return this.save();
  }

  /** Waits for the writes under way; never saves and never fails, so a handoff is never held up. */
  flush(): Promise<void> { return this.writes.catch(() => {}); }

  private save(): Promise<void> {
    const data = JSON.stringify(this.state, null, 2);
    this.writes = this.writes.catch(() => {}).then(() => writePrivateJson(this.path, data));
    return this.writes;
  }
}

function trim(state: SkillState): void {
  state.notes = state.notes.slice(-MAX_NOTES);
  // Never cut by count: a session dropped from here could be read as the owner's own again.
  state.excluded = [...new Set(state.excluded)];
  // Accepted and dismissed proposals go first; they only keep the advisor from proposing them again.
  while (state.proposals.length > MAX_PROPOSALS) {
    const index = state.proposals.findIndex(item => item.status !== 'open');
    state.proposals.splice(index >= 0 ? index : 0, 1);
  }
  const reflected = Object.entries(state.reflected);
  if (reflected.length > MAX_REFLECTED) state.reflected = Object.fromEntries(reflected.sort((a, b) => a[1].localeCompare(b[1])).slice(-MAX_REFLECTED));
}

const text = (value: unknown, max: number): string => typeof value === 'string' ? value.slice(0, max) : '';

function normalize(value: unknown): SkillState {
  const input = value && typeof value === 'object' ? value as Partial<SkillState> : {};
  const state = emptySkillState();
  if (typeof input.startedAt === 'string') state.startedAt = input.startedAt;
  if (Array.isArray(input.pinned)) state.pinned = input.pinned.filter(item => item && typeof item.dir === 'string')
    .map(item => ({ dir: item.dir, ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}) }));
  if (Array.isArray(input.targets)) {
    const paths = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string'))] : [];
    state.targets = input.targets.filter(item => item && typeof item.dir === 'string')
      .map(item => ({ dir: item.dir, all: item.all === true, projects: paths(item.projects), linked: paths(item.linked), globalLinked: item.globalLinked === true }));
  }
  const settings = input.settings;
  if (settings && typeof settings === 'object') state.settings = { enabled: settings.enabled !== false, provider: settings.provider === 'codex' ? 'codex' : 'claude' };
  if (Array.isArray(input.proposals)) state.proposals = input.proposals.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string')
    .map(item => ({
      id: item.id, name: text(item.name, 64), description: text(item.description, 1024), body: text(item.body, 16_000),
      scope: item.scope === 'project' && typeof item.cwd === 'string' ? 'project' as const : 'global' as const,
      ...(item.scope === 'project' && typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
      reason: text(item.reason, 2000), explicit: item.explicit === true,
      evidence: Array.isArray(item.evidence) ? item.evidence.filter(entry => entry && typeof entry.sessionId === 'string')
        .map(entry => ({ sessionId: entry.sessionId, title: text(entry.title, 200), at: text(entry.at, 40) })) : [],
      status: item.status === 'accepted' || item.status === 'dismissed' ? item.status : 'open' as const,
      createdAt: text(item.createdAt, 40), updatedAt: text(item.updatedAt, 40),
      ...(typeof item.skillDir === 'string' ? { skillDir: item.skillDir } : {}),
    }));
  if (Array.isArray(input.notes)) state.notes = input.notes.filter(item => item && typeof item.note === 'string')
    .map(item => ({ at: text(item.at, 40), sessionId: text(item.sessionId, 200), title: text(item.title, 200), cwd: text(item.cwd, 4096), note: text(item.note, 600) }));
  if (Array.isArray(input.excluded)) state.excluded = input.excluded.filter((id): id is string => typeof id === 'string');
  if (input.reflected && typeof input.reflected === 'object') state.reflected = Object.fromEntries(Object.entries(input.reflected).filter(([, at]) => typeof at === 'string'));
  if (input.calls && typeof input.calls.day === 'string' && Number.isSafeInteger(input.calls.count)) state.calls = { day: input.calls.day, count: input.calls.count };
  if (Array.isArray(input.seeded)) state.seeded = [...new Set(input.seeded.filter((name): name is string => typeof name === 'string'))];
  trim(state);
  return state;
}
