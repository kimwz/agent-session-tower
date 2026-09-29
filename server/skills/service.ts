import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ChatMessage, Run, Session } from '../../shared/types.js';
import type { GuidanceOverview, Skill, SkillBundle, SkillDetail, SkillImportChoice, SkillImportPlan, SkillOverview, SkillSummary } from '../../shared/skills.js';
import { MAX_SKILL_BUNDLE_BYTES, SKILL_BUNDLE_FORMAT } from '../../shared/skills.js';
import { AGENT_GUIDANCE } from '../agent-guidance/guidance.js';
import { OWNER_GUIDANCE_FILE } from '../agent-guidance/install.js';
import { writePrivateJson } from '../stores/private-json.js';
import { revisionOf } from './files.js';
import { parseBundle } from './store.js';
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
  /** Gives the agents the guidance again after the owner changed theirs; only the Tower on the account's own state folder does. */
  installGuidance?: () => Promise<void>;
}

const MAX_TURN_NOTES = 6_000;
const folders = (skill: Skill) => [skill.dir, ...(skill.copies ?? []).map(copy => copy.dir)];
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

  private ready: Promise<void> = Promise.resolve();
  /** Moves a crash interrupted are finished or undone before any skill is listed or named to a turn. */
  async start(): Promise<void> {
    this.ready = (async () => {
      await this.state.start();
      const finished = await this.files.recover().catch(error => { console.error(`Skill moves were not recovered: ${error instanceof Error ? error.message : String(error)}`); return []; });
      await this.moved(finished.map(move => ({ from: move.places, to: move.to })));
    })();
    await this.ready;
    this.recordRuns();
    if (this.options.advise !== false) this.advisor.start();
  }
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

  /**
   * The folders pins point at, each also by its real place and by where a move in progress takes it, so a pin on a copy
   * or on a folder moved into Tower keeps working through the link left behind.
   */
  private async pinned(): Promise<Set<string>> {
    const dirs = new Set<string>();
    const moving = this.files.pending();
    for (const item of this.state.get().pinned) {
      dirs.add(item.dir);
      const real = await realpath(item.dir).catch(() => undefined);
      if (real) dirs.add(real);
      for (const move of moving) if (move.places.includes(item.dir)) dirs.add(move.to);
    }
    return dirs;
  }

  private async withPins(skills: Skill[]): Promise<Skill[]> {
    const pinned = await this.pinned();
    // A pin set on any copy of a skill pins the skill.
    return skills.map(skill => ({ ...skill, pinned: folders(skill).some(dir => pinned.has(dir)) }));
  }

  /** Pins and accepted proposals that named a folder now kept in Tower name the stored one. */
  private async moved(moves: { from: string[]; to: string }[]): Promise<void> {
    if (!moves.length) return;
    await this.state.update(state => {
      for (const move of moves) {
        const pin = state.pinned.find(item => move.from.includes(item.dir));
        state.pinned = state.pinned.filter(item => !move.from.includes(item.dir) && item.dir !== move.to);
        if (pin) state.pinned.push({ ...pin, dir: move.to });
        for (const proposal of state.proposals) if (proposal.skillDir && move.from.includes(proposal.skillDir)) proposal.skillDir = move.to;
      }
    });
  }

  /** Replaces the pins of a skill (on any of its copies) with one on the folder that is edited, or none. */
  private async pin(skill: Skill, pinned: boolean): Promise<void> {
    const dirs = folders(skill);
    await this.state.update(state => {
      state.pinned = state.pinned.filter(item => !dirs.includes(item.dir));
      if (pinned) state.pinned.push({ dir: skill.dir, ...(skill.cwd ? { cwd: skill.cwd } : {}) });
    });
  }

  async overview(input: { cwd?: unknown } = {}): Promise<SkillOverview> {
    await this.ready;
    const cwd = await this.project(input.cwd);
    const state = this.state.get();
    const proposals = proposalsFor(state.proposals.filter(item => item.status === 'open'), cwd)
      .sort((a, b) => Number(proposalReady(b)) - Number(proposalReady(a)) || b.updatedAt.localeCompare(a.updatedAt));
    const notes = state.notes.filter(note => !cwd || note.cwd === cwd).slice(-40).reverse();
    const pinned = await this.pinned();
    const stored = (await this.files.managed()).map(skill => ({ ...skill, pinned: folders(skill).some(dir => pinned.has(dir)) }));
    return { skills: await this.withPins(await this.files.list(cwd)), stored, proposals, notes, settings: state.settings, advisor: this.advisor.status(),
      guidance: await this.guidance(), ...(cwd ? { cwd } : {}) };
  }

  summary(): SkillSummary {
    return { proposals: this.state.get().proposals.filter(proposalReady).length };
  }

  async detail(input: Record<string, unknown>): Promise<SkillDetail> {
    const cwd = await this.project(input.cwd);
    const [skill] = await this.withPins([await this.files.detail(text(input.dir), cwd)]);
    return skill as SkillDetail;
  }

  async mutate(action: string, body: Record<string, unknown>): Promise<SkillOverview> {
    await this.ready;
    const cwd = await this.project(body.cwd);
    switch (action) {
      case 'save': {
        const scope = body.scope === 'project' ? 'project' : 'global';
        const target = scope === 'project' ? await this.project(body.projectCwd ?? body.cwd) : undefined;
        const skill = await this.files.save({ ...(typeof body.dir === 'string' && body.dir ? { dir: body.dir, revision: text(body.revision) } : {}),
          scope, ...(target ? { cwd: target } : {}), name: text(body.name), description: text(body.description), body: text(body.body) });
        const proposalId = text(body.proposalId);
        await this.pin(skill, body.pinned === true);
        await this.state.update(state => {
          const proposal = proposalId && state.proposals.find(item => item.id === proposalId && item.status === 'open');
          if (proposal) { proposal.status = 'accepted'; proposal.skillDir = skill.dir; proposal.updatedAt = new Date().toISOString(); }
        });
        break;
      }
      case 'pin': {
        const skill = (await this.files.list(cwd)).find(item => folders(item).includes(text(body.dir)));
        if (!skill) throw new SkillError('스킬을 찾을 수 없습니다.', 404);
        await this.pin(skill, body.pinned === true);
        break;
      }
      case 'link': await this.files.link(text(body.dir), cwd); break;
      case 'merge': {
        const before = (await this.withPins(await this.files.list(cwd))).find(item => folders(item).includes(text(body.dir)));
        // A pin moves to the kept folder first, so it holds even if the merge stops half way.
        if (before?.pinned) await this.pin(before, true);
        await this.files.merge(text(body.dir), cwd);
        break;
      }
      case 'adopt': {
        const { skill, from } = await this.files.adopt(text(body.dir), cwd);
        await this.moved([{ from, to: skill.dir }]);
        break;
      }
      case 'guidance': {
        const owner = text(body.owner).replace(/\r\n/g, '\n');
        if (Buffer.byteLength(owner) > 256 * 1024) throw new SkillError('지침이 너무 깁니다.', 413);
        if (text(body.revision) !== (await this.guidance()).revision) throw new SkillError('다른 곳에서 지침이 바뀌었습니다. 다시 열어 최신 내용으로 고치세요.', 409);
        await this.writeGuidance(owner);
        break;
      }
      case 'import': {
        await this.import(body);
        break;
      }
      case 'delete': {
        const skill = (await this.files.list(cwd)).find(item => folders(item).includes(text(body.dir)));
        await this.files.remove(text(body.dir), cwd);
        if (skill) await this.pin(skill, false);
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
    await this.ready;
    const pinned = this.state.get().pinned;
    if (!pinned.length) return undefined;
    const cwd = resolve(session.cwd);
    const applies = (item: { cwd?: string }) => !item.cwd || cwd === item.cwd || cwd.startsWith(item.cwd + sep);
    const skills = (await this.withPins(await this.files.list(session.cwd))).filter(skill => skill.pinned && applies(skill));
    if (!skills.length) return undefined;
    const lines = skills.map(skill => `- ${skill.name}: ${skill.description} (${skill.dir}/SKILL.md)`);
    const notes = ['The owner asked every agent to check these skills of theirs before starting a task. When one fits this request, read its SKILL.md and follow it, even though the request does not name it. Explicit instructions in the request and the project\'s own instructions come first.', ...lines].join('\n');
    return notes.length > MAX_TURN_NOTES ? `${notes.slice(0, MAX_TURN_NOTES)}…` : notes;
  }

  private guidanceFile(): string { return join(this.options.stateDir, OWNER_GUIDANCE_FILE); }

  /** The owner's own guidance and Tower's fixed text, as every agent receives them. */
  async guidance(): Promise<GuidanceOverview> {
    const owner = await readFile(this.guidanceFile(), 'utf8').catch(() => '');
    return { owner, revision: revisionOf(owner), tower: AGENT_GUIDANCE, installed: Boolean(this.options.installGuidance) };
  }

  private async writeGuidance(owner: string): Promise<void> {
    await mkdir(dirname(this.guidanceFile()), { recursive: true, mode: 0o700 });
    await writePrivateJson(this.guidanceFile(), owner.trim() ? `${owner.trimEnd()}\n` : '');
    await this.options.installGuidance?.();
  }

  /** A backup of the chosen Tower skills (and the owner's guidance, when asked), as one file to download. */
  async exportBundle(input: Record<string, unknown>): Promise<SkillBundle> {
    await this.ready;
    const dirs = Array.isArray(input.dirs) ? input.dirs.filter((dir): dir is string => typeof dir === 'string') : [];
    const pinned = await this.pinned();
    const skills = (await this.files.bundle(dirs)).map((skill, index) => ({ ...skill, pinned: pinned.has(dirs[index]) }));
    const owner = input.guidance === true ? (await this.guidance()).owner : undefined;
    const bundle: SkillBundle = { format: SKILL_BUNDLE_FORMAT, version: 1, exportedAt: new Date().toISOString(), from: hostname(), ...(owner ? { guidance: owner } : {}), skills };
    if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_SKILL_BUNDLE_BYTES) throw new SkillError('백업이 20MB를 넘습니다. 스킬을 나눠서 내보내세요.', 413);
    return bundle;
  }

  /** What importing a backup would do here, item by item, before anything is written. */
  async importPlan(input: unknown): Promise<SkillImportPlan> {
    await this.ready;
    const bundle = parseBundle(input);
    const known = (cwd: string) => this.options.sessions().some(session => !session.node && session.cwd === cwd) || Boolean(this.options.projects?.().includes(cwd));
    const items = await Promise.all(bundle.skills.map(async (skill, index) => {
      const cwd = skill.project && known(skill.project.cwd) && (await stat(skill.project.cwd).catch(() => undefined))?.isDirectory() ? skill.project.cwd : undefined;
      const conflict = skill.scope === 'project' && !cwd ? 'new' as const : await this.files.conflict(skill.name, skill.scope, cwd);
      return { index, name: skill.name, scope: skill.scope, ...(skill.project ? { fromCwd: skill.project.cwd } : {}), conflict, ...(cwd ? { cwd } : {}), pinned: skill.pinned, description: skill.description };
    }));
    return { items, guidance: Boolean(bundle.guidance?.trim()), exportedAt: bundle.exportedAt, from: bundle.from };
  }

  /** Writes the chosen items of a backup: each checked again right before it is written. */
  private async import(body: Record<string, unknown>): Promise<void> {
    const bundle = parseBundle(body.bundle);
    const choices = (Array.isArray(body.choices) ? body.choices : []) as SkillImportChoice[];
    const failures: string[] = [];
    for (const choice of choices) {
      const item = Number.isInteger(choice?.index) ? bundle.skills[choice.index] : undefined;
      if (!item || (choice.action !== 'add' && choice.action !== 'replace')) continue;
      try {
        const cwd = item.scope === 'project' ? await this.project(choice.cwd) : undefined;
        if (item.scope === 'project' && !cwd) throw new SkillError('프로젝트 폴더를 고르세요.');
        const skill = await this.files.install(item, cwd, choice.action === 'replace');
        if (body.pins === true && item.pinned) await this.pin(skill, true);
      } catch (error) { failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const guidance = bundle.guidance?.trim();
    if (guidance && (body.guidance === 'replace' || body.guidance === 'append')) {
      const current = (await this.guidance()).owner.trim();
      await this.writeGuidance(body.guidance === 'append' && current ? `${current}\n\n${guidance}` : guidance);
    }
    if (failures.length) throw new SkillError(`가져오지 못한 스킬이 있습니다. ${failures.join(' / ')}`, 409);
  }
}
