import { stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { ChatMessage, Run, Session } from '../../shared/types.js';
import type { Skill, SkillDetail, SkillOverview, SkillSummary } from '../../shared/skills.js';
import { proposalReady, proposalsFor } from '../../shared/skills.js';
import type { AutoPromptModelRequest } from '../auto-prompt/native.js';
import { SkillAdvisor } from './advisor.js';
import { SkillError, SkillFiles, type SkillHomes } from './files.js';
import { SkillStateStore } from './state.js';
import { ClosedSessionStore } from '../stores/closed-sessions.js';

export interface SkillServiceOptions {
  stateDir: string;
  homes: SkillHomes;
  /** Every conversation on this computer, closed ones marked. */
  sessions: () => Session[];
  runs: () => Run[];
  /** How Tower created the session, kept as long as the session is known; absent for sessions started elsewhere. */
  origin?: (sessionId: string) => { kind: string; controllerId?: string; untrustedInput?: boolean } | undefined;
  /** Project folders the owner set up (named or pinned) beside those sessions work in. */
  projects?: () => string[];
  /** Whether the advisor reads finished sessions by itself; off for Towers on another state folder, such as tests. */
  advise?: boolean;
  history: (session: Session, limit: number) => Promise<ChatMessage[] | undefined>;
  model: (request: AutoPromptModelRequest, options?: { timeoutMs?: number }) => Promise<unknown>;
  onChange?: () => void;
}

const MAX_TURN_NOTES = 6_000;
/** Work a trigger, Slack or another agent started, or the owner at a controlling computer. */
const foreign = (kind: string | undefined, controllerId: unknown) => kind !== undefined && kind !== 'owner' || Boolean(controllerId);
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/**
 * Skills on this computer, run by the execution worker: the owner's pages list and edit them, the advisor proposes new
 * ones from finished sessions, and every Tower turn is told which pinned skills to check before it starts.
 */
export class SkillService {
  readonly files: SkillFiles;
  private readonly state: SkillStateStore;
  private readonly advisor: SkillAdvisor;

  constructor(private readonly options: SkillServiceOptions) {
    this.files = new SkillFiles(options.homes);
    this.state = new SkillStateStore(options.stateDir);
    this.advisor = new SkillAdvisor({
      stateDir: options.stateDir, state: this.state, skills: cwd => this.files.list(cwd), sessions: options.sessions,
      automated: session => this.automated(session), history: options.history,
      closed: async () => { const store = new ClosedSessionStore(options.stateDir); await store.start(); return store.closedIds(); }, model: options.model, onChange: () => options.onChange?.(),
    });
  }

  async start(): Promise<void> { await this.state.start(); this.recordRuns(); if (this.options.advise !== false) this.advisor.start(); }
  close(): void { this.advisor.stop(); }
  inFlight(): boolean { return this.advisor.inFlight(); }
  pause(): void { this.advisor.pause(); }
  resume(): void { this.advisor.resume(); }
  flush(): Promise<void> { return this.state.update(() => {}); }

  /**
   * Work someone other than the owner here asked for: a trigger, Slack, another agent, or the owner at a controlling
   * computer. Only conversations the owner had on this computer teach the advisor how they work.
   */
  private automated(session: Session): boolean {
    const ids = [session.id, `${session.provider}:${session.nativeId}`];
    if (ids.some(id => this.state.get().excluded.includes(id))) return true;
    const origin = this.options.origin?.(session.id);
    return Boolean(origin && (foreign(origin.kind, origin.controllerId) || origin.untrustedInput))
      || this.options.runs().some(run => ids.includes(run.sessionId) && foreign(run.origin?.kind, run.origin?.controllerId));
  }

  /**
   * Marks, as they are accepted, the sessions someone other than the owner here works in: runs are pruned after a while,
   * the mark is not, and it is kept whether or not the advisor is on. The worker calls this on every change of its runs.
   */
  recordRuns(): void {
    const excluded = new Set(this.state.get().excluded);
    const fresh = [...new Set(this.options.runs().filter(run => foreign(run.origin?.kind, run.origin?.controllerId) && !excluded.has(run.sessionId)).map(run => run.sessionId))];
    if (fresh.length) void this.state.update(state => { state.excluded.push(...fresh); }).catch(() => {});
  }

  private async project(cwd: unknown): Promise<string | undefined> {
    if (cwd === undefined || cwd === null || cwd === '') return undefined;
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096) throw new SkillError('프로젝트 폴더가 올바르지 않습니다.');
    const folder = resolve(cwd);
    // Only a folder Tower knows as a project on this computer; a request cannot point the listing anywhere else.
    if (!(this.options.sessions().some(session => !session.node && session.cwd === folder) || this.options.projects?.().includes(folder)) || !(await stat(folder).catch(() => undefined))?.isDirectory()) {
      throw new SkillError('Tower가 아는 프로젝트 폴더가 아닙니다.', 404);
    }
    return folder;
  }

  private withPins(skills: Skill[]): Skill[] {
    const pinned = new Set(this.state.get().pinned.map(item => item.dir));
    return skills.map(skill => ({ ...skill, pinned: pinned.has(skill.dir) }));
  }

  async overview(input: { cwd?: unknown } = {}): Promise<SkillOverview> {
    const cwd = await this.project(input.cwd);
    const state = this.state.get();
    const proposals = proposalsFor(state.proposals.filter(item => item.status === 'open'), cwd)
      .sort((a, b) => Number(proposalReady(b)) - Number(proposalReady(a)) || b.updatedAt.localeCompare(a.updatedAt));
    const notes = state.notes.filter(note => !cwd || note.cwd === cwd).slice(-40).reverse();
    return { skills: this.withPins(await this.files.list(cwd)), proposals, notes, settings: state.settings, advisor: this.advisor.status(), ...(cwd ? { cwd } : {}) };
  }

  summary(): SkillSummary {
    return { proposals: this.state.get().proposals.filter(proposalReady).length };
  }

  async detail(input: Record<string, unknown>): Promise<SkillDetail> {
    const cwd = await this.project(input.cwd);
    const [skill] = this.withPins([await this.files.detail(text(input.dir), cwd)]);
    return skill as SkillDetail;
  }

  async mutate(action: string, body: Record<string, unknown>): Promise<SkillOverview> {
    const cwd = await this.project(body.cwd);
    switch (action) {
      case 'save': {
        const scope = body.scope === 'project' ? 'project' : 'global';
        const target = scope === 'project' ? await this.project(body.projectCwd ?? body.cwd) : undefined;
        const skill = await this.files.save({ ...(typeof body.dir === 'string' && body.dir ? { dir: body.dir, revision: text(body.revision) } : {}),
          scope, ...(target ? { cwd: target } : {}), name: text(body.name), description: text(body.description), body: text(body.body) });
        const proposalId = text(body.proposalId);
        await this.state.update(state => {
          state.pinned = state.pinned.filter(item => item.dir !== skill.dir);
          if (body.pinned === true) state.pinned.push({ dir: skill.dir, ...(skill.cwd ? { cwd: skill.cwd } : {}) });
          const proposal = proposalId && state.proposals.find(item => item.id === proposalId && item.status === 'open');
          if (proposal) { proposal.status = 'accepted'; proposal.skillDir = skill.dir; proposal.updatedAt = new Date().toISOString(); }
        });
        break;
      }
      case 'pin': {
        const skill = (await this.files.list(cwd)).find(item => item.dir === text(body.dir));
        if (!skill) throw new SkillError('스킬을 찾을 수 없습니다.', 404);
        await this.state.update(state => {
          state.pinned = state.pinned.filter(item => item.dir !== skill.dir);
          if (body.pinned === true) state.pinned.push({ dir: skill.dir, ...(skill.cwd ? { cwd: skill.cwd } : {}) });
        });
        break;
      }
      case 'link': await this.files.link(text(body.dir), cwd); break;
      case 'delete': {
        const dir = text(body.dir);
        await this.files.remove(dir, cwd);
        await this.state.update(state => { state.pinned = state.pinned.filter(item => item.dir !== dir); });
        break;
      }
      case 'dismiss': {
        const id = text(body.id);
        await this.state.update(state => {
          const proposal = state.proposals.find(item => item.id === id && item.status === 'open');
          if (!proposal) throw new SkillError('추천을 찾을 수 없습니다.', 404);
          proposal.status = 'dismissed'; proposal.updatedAt = new Date().toISOString();
        });
        break;
      }
      case 'settings': {
        await this.state.update(state => {
          if (typeof body.enabled === 'boolean') state.settings.enabled = body.enabled;
          if (body.provider === 'claude' || body.provider === 'codex') state.settings.provider = body.provider;
        });
        break;
      }
      case 'backfill': {
        const days = typeof body.days === 'number' && Number.isInteger(body.days) && body.days >= 1 && body.days <= 30 ? body.days : 7;
        // It takes minutes; the page follows its progress in the overview.
        void this.advisor.backfill(days).catch(() => {});
        break;
      }
      default: throw new SkillError('알 수 없는 스킬 작업입니다.', 404);
    }
    this.options.onChange?.();
    return this.overview({ cwd });
  }

  /**
   * What a Tower turn is told before it starts: the pinned skills that apply where it works. Global ones everywhere,
   * a project's own only inside that project.
   */
  async turnNotes(session: Session): Promise<string | undefined> {
    const pinned = this.state.get().pinned;
    if (!pinned.length) return undefined;
    const cwd = resolve(session.cwd);
    const applies = (item: { cwd?: string }) => !item.cwd || cwd === item.cwd || cwd.startsWith(item.cwd + sep);
    const skills = this.withPins(await this.files.list(session.cwd)).filter(skill => skill.pinned && applies(skill));
    if (!skills.length) return undefined;
    const lines = skills.map(skill => `- ${skill.name}: ${skill.description} (${skill.dir}/SKILL.md)`);
    const notes = ['The owner asked every agent to check these skills of theirs before starting a task. When one fits this request, read its SKILL.md and follow it, even though the request does not name it. Explicit instructions in the request and the project\'s own instructions come first.', ...lines].join('\n');
    return notes.length > MAX_TURN_NOTES ? `${notes.slice(0, MAX_TURN_NOTES)}…` : notes;
  }
}
