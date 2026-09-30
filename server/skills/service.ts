import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ChatMessage, Run, Session } from '../../shared/types.js';
import type { GuidanceOverview, Skill, SkillBundle, SkillDetail, SkillImportChoice, SkillImportPlan, SkillOverview, SkillSummary, SkillTargets } from '../../shared/skills.js';
import { MAX_SKILL_BUNDLE_BYTES, MAX_SKILL_TARGETS, SKILL_BUNDLE_FORMAT, SKILL_NAME, targetsCover, targetsRevision } from '../../shared/skills.js';
import { AGENT_GUIDANCE } from '../agent-guidance/guidance.js';
import { OWNER_GUIDANCE_FILE, withoutTowerMarkers } from '../agent-guidance/install.js';
import { writePrivateFile } from '../stores/private-json.js';
import { readSkillSnapshot, revisionOf } from './files.js';
import { parseBundle } from './store.js';
import { proposalReady, proposalsFor } from '../../shared/skills.js';
import type { AutoPromptModelRequest } from '../auto-prompt/native.js';
import { SkillAdvisor } from './advisor.js';
import { DEFAULT_SKILLS } from './defaults.js';
import { SkillError, SkillFiles, type SkillHomes } from './files.js';
import { SkillStateStore, type SkillTargetRecord } from './state.js';
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
  /** Whether Tower makes its default skills; only the Tower on the account's own state folder links into the account. */
  seed?: boolean;
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

  private initialized?: Promise<void>;
  /**
   * Moves a crash interrupted are finished or undone before any skill is listed or named to a turn. A start that failed
   * is tried again on the next use rather than leaving skills unusable until the worker restarts.
   */
  private ready(): Promise<void> {
    this.initialized ??= (async () => {
      await this.state.start();
      const finished = await this.files.recover().catch(error => { console.error(`Skill moves were not recovered: ${error instanceof Error ? error.message : String(error)}`); return []; });
      await this.moved(finished.map(move => ({ from: move.places, to: move.to })));
      // Links are brought in line in the background, among the other changes: a project on a volume that stopped
      // answering never holds up the worker, the listing or a turn, which all read the records.
      void this.exclusive(() => this.syncTargets()).catch(error => console.error(`Skill targets were not checked: ${error instanceof Error ? error.message : String(error)}`));
    })().catch(error => { this.initialized = undefined; throw error; });
    return this.initialized;
  }

  async start(): Promise<void> {
    await this.ready().catch(error => console.error(`Skills did not start: ${error instanceof Error ? error.message : String(error)}`));
    this.recordRuns();
    if (this.options.seed) void this.exclusive(() => this.seed()).catch(error => console.error(`Default skills were not made: ${error instanceof Error ? error.message : String(error)}`));
    if (this.options.advise !== false) this.advisor.start();
  }

  /**
   * Makes each default skill once, as a Tower skill for every project. A skill of that name the owner already has keeps
   * it from being made; one made before is never made again or overwritten, so the owner's edits and removals stand.
   */
  private async seed(): Promise<void> {
    await this.ready();
    for (const skill of DEFAULT_SKILLS) {
      if (this.state.get().seeded.includes(skill.name)) continue;
      const present = (await this.files.list()).some(item => item.scope === 'global' && item.name === skill.name)
        || Boolean(await stat(await this.files.towerDir(skill.name)).catch(() => undefined));
      let made = !present;
      if (made) {
        try { await this.create({ name: skill.name, description: skill.description, body: skill.body }, { all: true, projects: [] }); }
        catch (error) {
          // Something of that name already sits where the skill would be linked: that stays, and Tower does not ask again.
          if (!(error instanceof SkillError && error.statusCode === 409)) throw error;
          made = false;
        }
      }
      await this.state.update(state => { if (!state.seeded.includes(skill.name)) state.seeded.push(skill.name); });
      if (made) this.options.onChange?.();
    }
  }
  close(): void { this.advisor.stop(); }
  inFlight(): boolean { return this.advisor.inFlight(); }
  pause(): void { this.advisor.pause(); }
  resume(): void { this.advisor.resume(); }
  flush(): Promise<void> { return this.state.update(() => {}); }
  /** Resolves once the changes queued so far, the start-up link check included, are done. */
  settled(): Promise<void> { return this.queue.then(() => {}, () => {}); }

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
    const real = moves.filter(move => move.from.length);
    if (!real.length) return;
    await this.state.update(state => {
      for (const move of real) {
        const pin = state.pinned.find(item => move.from.includes(item.dir));
        state.pinned = state.pinned.filter(item => !move.from.includes(item.dir));
        if (pin && !state.pinned.some(item => item.dir === move.to)) state.pinned.push({ ...pin, dir: move.to });
        for (const proposal of state.proposals) if (proposal.skillDir && move.from.includes(proposal.skillDir)) proposal.skillDir = move.to;
      }
    });
  }

  /** Replaces the pins of a skill (on any of its copies) with one on the folder that is edited, or none. */
  private async pin(skill: Skill, pinned: boolean): Promise<void> {
    const dirs = folders(skill);
    // A pin left on an old place (a link to the skill now) belongs to the skill too.
    const reals = new Map(await Promise.all(this.state.get().pinned.map(async item => [item.dir, await realpath(item.dir).catch(() => item.dir)] as const)));
    await this.state.update(state => {
      state.pinned = state.pinned.filter(item => !dirs.includes(item.dir) && !dirs.includes(reals.get(item.dir) ?? item.dir));
      if (pinned) state.pinned.push({ dir: skill.dir, ...(skill.cwd ? { cwd: skill.cwd } : {}) });
    });
  }

  private record(dir: string): SkillTargetRecord | undefined { return this.state.get().targets.find(item => item.dir === dir); }

  /**
   * Writes where a Tower skill applies. The places it may be linked only grow here (`narrow` aside), so a link made
   * before a crash is always among those a later change looks at.
   */
  private writeRecord(record: SkillTargetRecord, narrow = false): Promise<void> {
    return this.state.update(state => {
      const before = state.targets.find(item => item.dir === record.dir);
      const kept = narrow || !before ? record : { ...record, linked: [...new Set([...before.linked, ...record.linked])], globalLinked: before.globalLinked || record.globalLinked };
      state.targets = [...state.targets.filter(item => item.dir !== record.dir), kept];
    });
  }

  /**
   * Gives every Tower skill without a record the targets it had as a global or project skill, forgets records of
   * folders that are gone (a creation that never finished), and makes each skill's links match its record.
   */
  private async syncTargets(): Promise<void> {
    const stored = await this.files.managed();
    const gone = new Set<string>();
    // Only a folder that is certainly gone loses its record; one that cannot be read right now keeps it.
    for (const item of this.state.get().targets) if (await stat(item.dir).then(() => false, error => (error as NodeJS.ErrnoException).code === 'ENOENT')) gone.add(item.dir);
    const derived: SkillTargetRecord[] = [];
    const known = [...new Set([...this.options.projects?.() ?? [], ...this.options.sessions().filter(session => !session.node).map(session => session.cwd)])];
    for (const skill of stored) {
      if (this.record(skill.dir)) continue;
      // Rebuilt from where it is linked now, so a lost record never makes a skill apply to more projects than before.
      const targets = await this.files.linkedTargets(skill.dir, known);
      derived.push({ dir: skill.dir, ...targets, linked: targets.projects, globalLinked: targets.all });
    }
    if (gone.size || derived.length) await this.state.update(state => { state.targets = [...state.targets.filter(item => !gone.has(item.dir)), ...derived]; });
    for (const item of [...this.state.get().targets]) {
      try { await this.settle(item); }
      catch (error) { console.error(`Links of the skill ${item.dir} do not match its projects yet: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /** Links a recorded skill where it applies and nowhere else, then stops tracking the places it left. */
  private async settle(item: SkillTargetRecord): Promise<void> {
    await this.files.reconcile(item.dir, item, { projects: item.linked, global: item.globalLinked });
    await this.writeRecord({ ...item, linked: item.projects, globalLinked: item.all }, true);
  }

  /**
   * Changes where a Tower skill applies: the record first (with every place it may be linked), then the links, then
   * the record narrowed to where it applies now. On an error the previous targets are written back and restored.
   */
  private async apply(dir: string, next: SkillTargets, check = true): Promise<void> {
    const before = this.record(dir);
    if (check) await this.files.checkTargets(dir, next);
    const tracked = { projects: [...new Set([...before?.linked ?? [], ...next.projects])], global: Boolean(before?.globalLinked) || next.all };
    await this.writeRecord({ dir, all: next.all, projects: next.projects, linked: tracked.projects, globalLinked: tracked.global });
    try { await this.files.reconcile(dir, next, tracked); }
    catch (error) {
      if (before) {
        await this.writeRecord({ ...before, linked: tracked.projects, globalLinked: tracked.global });
        await this.files.reconcile(dir, before, tracked).catch(() => {});
      }
      throw error;
    }
    await this.writeRecord({ dir, all: next.all, projects: next.projects, linked: next.projects, globalLinked: next.all }, true);
  }

  /** Targets a request names: everywhere, or projects this Tower knows. Undefined when it names none. */
  private async targetsFrom(value: unknown, dir?: string): Promise<SkillTargets | undefined> {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object') throw new SkillError('적용 프로젝트가 올바르지 않습니다.');
    const input = value as { all?: unknown; projects?: unknown };
    if (input.all === true) return { all: true, projects: [] };
    const list = Array.isArray(input.projects) ? input.projects : [];
    if (list.length > MAX_SKILL_TARGETS) throw new SkillError(`적용 프로젝트는 ${MAX_SKILL_TARGETS}개까지 고를 수 있습니다.`);
    const projects: string[] = [];
    // A project the skill already applies to stays, even when Tower no longer lists it, so it never blocks other edits.
    const recorded = dir ? this.record(dir)?.projects ?? [] : [];
    for (const cwd of list) {
      const folder = typeof cwd === 'string' && recorded.includes(cwd) ? cwd : await this.project(cwd);
      if (folder && !projects.includes(folder)) projects.push(folder);
    }
    return { all: false, projects };
  }

  /** An editor opened before a change made elsewhere must not overwrite it. */
  private checkRevision(dir: string, body: Record<string, unknown>): void {
    if (typeof body.targetsRevision !== 'string') return;
    const current = this.record(dir);
    if (body.targetsRevision !== targetsRevision(current && { all: current.all, projects: current.projects })) throw new SkillError('다른 곳에서 적용 프로젝트가 바뀌었습니다. 다시 열어 최신 상태로 고치세요.', 409);
  }

  /** A new skill kept in Tower: its record is written before its folder exists, so a crash never leaves it applying everywhere. */
  private async create(body: Record<string, unknown>, targets: SkillTargets): Promise<Skill> {
    const name = text(body.name).trim();
    if (!SKILL_NAME.test(name)) throw new SkillError('스킬 이름은 영어 소문자, 숫자, 하이픈으로 64자 이내로 쓰세요.');
    const dir = await this.files.towerDir(name);
    if (await stat(dir).catch(() => undefined)) throw new SkillError('타워에 같은 이름의 스킬이 이미 있습니다.', 409);
    await this.files.checkTargets(dir, targets);
    await this.writeRecord({ dir, all: targets.all, projects: targets.projects, linked: targets.projects, globalLinked: targets.all });
    let skill: Skill;
    try { skill = await this.files.save({ scope: 'global', name, description: text(body.description), body: text(body.body), link: false }); }
    catch (error) {
      // A folder left without its SKILL.md is no skill: it goes, with its record.
      if (await stat(dir).catch(() => undefined) && !await stat(join(dir, 'SKILL.md')).catch(() => undefined)) await rm(dir, { recursive: true, force: true }).catch(() => {});
      if (!await stat(dir).catch(() => undefined)) await this.state.update(state => { state.targets = state.targets.filter(item => item.dir !== dir); });
      throw error;
    }
    await this.apply(dir, targets, false);
    return skill;
  }

  /** A Tower skill's targets in this state, copied. */
  private recordIn(state: { targets: SkillTargetRecord[] }, dir: string): { all: boolean; projects: string[] } | undefined {
    const item = state.targets.find(entry => entry.dir === dir);
    return item ? { all: item.all, projects: [...item.projects] } : undefined;
  }

  private withTargets(skill: Skill): Skill {
    const item = skill.managed ? this.record(skill.dir) : undefined;
    return item ? { ...skill, targets: { all: item.all, projects: item.projects }, confirmed: this.state.get().confirmed[skill.dir] === skill.revision } : skill;
  }

  /**
   * What the owner set down for work in `cwd`, for Tower's permission reviewer: the Tower skills that apply there and
   * the owner guidance, each only at the revision the owner saved or confirmed in Tower. Others are named in `unconfirmed`.
   */
  async authority(cwd: string): Promise<{ skills: { name: string; description: string; body: string }[]; guidance?: string; unconfirmed: string[] }> {
    await this.ready();
    const state = this.state.get();
    const folder = resolve(cwd);
    const skills: { name: string; description: string; body: string }[] = [];
    const unconfirmed: string[] = [];
    for (const item of state.targets) {
      if (!targetsCover(item, folder)) continue;
      const owned = state.confirmedTargets[item.dir];
      // Name, description and body come from the one read whose revision is checked.
      const read = await readSkillSnapshot(item.dir);
      if (!read) continue;
      if (state.confirmed[item.dir] === read.revision && owned && targetsCover(owned, folder)) skills.push({ name: read.name, description: read.description, body: read.body });
      else unconfirmed.push(read.name);
    }
    const guidance = await this.guidance();
    return { skills, ...(guidance.confirmed && guidance.owner.trim() ? { guidance: guidance.owner } : {}), unconfirmed };
  }

  async overview(input: { cwd?: unknown } = {}): Promise<SkillOverview> {
    await this.ready();
    const cwd = await this.project(input.cwd);
    const state = this.state.get();
    const proposals = proposalsFor(state.proposals.filter(item => item.status === 'open'), cwd)
      .sort((a, b) => Number(proposalReady(b)) - Number(proposalReady(a)) || b.updatedAt.localeCompare(a.updatedAt));
    const notes = state.notes.filter(note => !cwd || note.cwd === cwd).slice(-40).reverse();
    const pinned = await this.pinned();
    const stored = (await this.files.managed()).map(skill => this.withTargets({ ...skill, pinned: folders(skill).some(dir => pinned.has(dir)) }));
    return { skills: (await this.withPins(await this.files.list(cwd))).map(skill => this.withTargets(skill)), stored, proposals, notes, settings: state.settings, advisor: this.advisor.status(),
      guidance: await this.guidance(), ...(cwd ? { cwd } : {}) };
  }

  summary(): SkillSummary {
    const ready = this.state.get().proposals.filter(proposalReady);
    return { proposals: ready.length, projects: [...new Set(ready.flatMap(item => item.scope === 'project' && item.cwd ? [item.cwd] : []))] };
  }

  async detail(input: Record<string, unknown>): Promise<SkillDetail> {
    await this.ready();
    const cwd = await this.project(input.cwd);
    const [skill] = await this.withPins([await this.files.detail(text(input.dir), cwd)]);
    return this.withTargets(skill!) as SkillDetail;
  }

  private queue: Promise<unknown> = Promise.resolve();
  /** Changes run one at a time, from reading what they change to writing Tower's record of it. */
  private exclusive<T>(change: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(change);
    this.queue = next;
    return next;
  }

  /** `typed`: the owner's own page sent it, so what it saves or confirms is the owner's word (see `Skill.confirmed`). */
  async mutate(action: string, body: Record<string, unknown>, options: { typed?: boolean } = {}): Promise<SkillOverview> {
    await this.ready();
    const cwd = await this.project(body.cwd);
    await this.exclusive(() => this.change(action, body, cwd, options.typed === true));
    this.options.onChange?.();
    return this.overview({ cwd });
  }

  private async change(action: string, body: Record<string, unknown>, cwd: string | undefined, typed = false): Promise<void> {
    switch (action) {
      case 'save': {
        const editing = typeof body.dir === 'string' && body.dir ? body.dir : undefined;
        const targets = await this.targetsFrom(body.targets, editing && await realpath(editing).catch(() => undefined));
        let skill: Skill;
        if (!editing && targets) skill = await this.create(body, targets);
        else {
          if (editing && targets) {
            const current = await this.files.lookup(editing, cwd);
            if (!current.managed) throw new SkillError('타워에 있는 스킬만 적용 프로젝트를 정할 수 있습니다.', 409);
            this.checkRevision(current.dir, body);
            await this.files.checkTargets(current.dir, targets);
          }
          const scope = body.scope === 'project' ? 'project' : 'global';
          // An edit finds the skill from where the panel was opened; only a new one needs its project checked again.
          const target = editing ? cwd : scope === 'project' ? await this.project(body.projectCwd ?? body.cwd) : undefined;
          skill = await this.files.save({ ...(editing ? { dir: editing, revision: text(body.revision) } : {}),
            scope, ...(target ? { cwd: target } : {}), name: text(body.name), description: text(body.description), body: text(body.body) });
          if (editing && targets) await this.apply(skill.dir, targets, false);
          // Made the older way, as a global or one project's skill: it applies where it was made.
          if (!editing && skill.managed && !this.record(skill.dir)) {
            const derived = await this.files.storedTargets(skill.dir);
            await this.writeRecord({ dir: skill.dir, ...derived, linked: derived.projects, globalLinked: derived.all });
          }
        }
        const proposalId = text(body.proposalId);
        await this.pin(skill, body.pinned === true);
        await this.state.update(state => {
          const proposal = proposalId && state.proposals.find(item => item.id === proposalId && item.status === 'open');
          if (proposal) { proposal.status = 'accepted'; proposal.skillDir = skill.dir; proposal.updatedAt = new Date().toISOString(); }
          // What the owner just saved (the text written, whatever the file holds by now) is what they confirmed, where it applies now.
          if (typed) { state.confirmed[skill.dir] = skill.revision; const targets = this.recordIn(state, skill.dir); if (targets) state.confirmedTargets[skill.dir] = targets; }
        });
        break;
      }
      case 'confirm': {
        if (!typed) throw new SkillError('스킬 내용 확인은 소유자 페이지에서만 할 수 있습니다.', 403);
        // The owner confirms the text they were shown: its revision must still be the file's.
        const skill = await this.files.detail(text(body.dir), cwd);
        if (!text(body.revision) || text(body.revision) !== skill.revision) throw new SkillError('다른 곳에서 이 스킬이 바뀌었습니다. 다시 열어 최신 내용을 확인하세요.', 409);
        await this.state.update(state => { state.confirmed[skill.dir] = skill.revision; const targets = this.recordIn(state, skill.dir); if (targets) state.confirmedTargets[skill.dir] = targets; });
        break;
      }
      case 'confirmGuidance': {
        if (!typed) throw new SkillError('지침 확인은 소유자 페이지에서만 할 수 있습니다.', 403);
        const current = await this.guidance();
        if (text(body.revision) !== current.revision) throw new SkillError('다른 곳에서 지침이 바뀌었습니다. 다시 열어 최신 내용을 확인하세요.', 409);
        await this.state.update(state => { state.guidanceConfirmed = current.revision; });
        break;
      }
      case 'pin': {
        const skill = (await this.files.list(cwd)).find(item => folders(item).includes(text(body.dir))) ?? await this.files.lookup(text(body.dir), cwd);
        await this.pin(skill, body.pinned === true);
        break;
      }
      case 'assign': {
        const skill = await this.files.lookup(text(body.dir), cwd);
        if (!skill.managed) throw new SkillError('타워에 있는 스킬만 적용 프로젝트를 정할 수 있습니다.', 409);
        const targets = await this.targetsFrom(body.targets, skill.dir);
        if (!targets) throw new SkillError('적용 프로젝트를 고르세요.');
        this.checkRevision(skill.dir, body);
        await this.apply(skill.dir, targets);
        // Where the owner applies a skill in Tower is where the reviewer may rely on it; elsewhere it does not follow.
        if (typed) await this.state.update(state => { state.confirmedTargets[skill.dir] = { all: targets.all, projects: [...targets.projects] }; });
        break;
      }
      case 'link': {
        // A Tower skill is linked only where it applies.
        const skill = await this.files.lookup(text(body.dir), cwd);
        const item = skill.managed ? this.record(skill.dir) : undefined;
        if (item) await this.apply(skill.dir, { all: item.all, projects: item.projects });
        else await this.files.link(text(body.dir), cwd);
        break;
      }
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
        if (!this.record(skill.dir)) {
          const targets = await this.files.storedTargets(skill.dir);
          await this.writeRecord({ dir: skill.dir, ...targets, linked: targets.projects, globalLinked: targets.all });
        }
        break;
      }
      case 'guidance': {
        const owner = text(body.owner).replace(/\r\n/g, '\n');
        if (Buffer.byteLength(owner) > 256 * 1024) throw new SkillError('지침이 너무 깁니다.', 413);
        const written = await this.guidanceChange(async current => {
          if (text(body.revision) !== current.revision) throw new SkillError('다른 곳에서 지침이 바뀌었습니다. 다시 열어 최신 내용으로 고치세요.', 409);
          return owner;
        });
        if (typed) await this.state.update(state => { state.guidanceConfirmed = written; });
        break;
      }
      case 'import': {
        await this.import(body);
        break;
      }
      case 'delete': {
        const skill = await this.files.lookup(text(body.dir), cwd);
        // A Tower skill loses its links in every project it applied to first.
        const before = skill.managed ? this.record(skill.dir) : undefined;
        if (before) await this.apply(skill.dir, { all: false, projects: [] }, false);
        // A skill that could not be removed applies where it did again.
        try { await this.files.remove(skill.dir, skill.managed ? skill.cwd : cwd); }
        catch (error) { if (before) await this.apply(skill.dir, { all: before.all, projects: before.projects }, false).catch(() => {}); throw error; }
        await this.pin(skill, false);
        if (skill.managed) await this.state.update(state => { state.targets = state.targets.filter(item => item.dir !== skill.dir); });
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
  }

  /**
   * What a Tower turn is told before it starts: the pinned skills that apply where it works. Global ones everywhere,
   * a project's own only inside that project.
   */
  async turnNotes(session: Session): Promise<string | undefined> {
    await this.ready();
    const state = this.state.get();
    if (!state.pinned.length) return undefined;
    const cwd = resolve(session.cwd);
    const pinned = await this.pinned();
    const lines: string[] = [];
    // A Tower skill applies where its targets say, whether or not its links are in place.
    for (const item of state.targets) {
      if (!pinned.has(item.dir) || !targetsCover(item, cwd)) continue;
      const about = await this.files.describe(item.dir);
      if (about) lines.push(`- ${about.name}: ${about.description} (${item.dir}/SKILL.md)`);
    }
    const tower = new Set(state.targets.map(item => item.dir));
    const applies = (item: { cwd?: string }) => !item.cwd || cwd === item.cwd || cwd.startsWith(item.cwd + sep);
    const others = (await this.withPins(await this.files.list(session.cwd))).filter(skill => skill.pinned && !skill.managed && !tower.has(skill.dir) && applies(skill));
    lines.push(...others.map(skill => `- ${skill.name}: ${skill.description} (${skill.dir}/SKILL.md)`));
    if (!lines.length) return undefined;
    const notes = ['The owner asked every agent to check these skills of theirs before starting a task. When one fits this request, read its SKILL.md and follow it, even though the request does not name it. Explicit instructions in the request and the project\'s own instructions come first.', ...lines].join('\n');
    return notes.length > MAX_TURN_NOTES ? `${notes.slice(0, MAX_TURN_NOTES)}…` : notes;
  }

  private guidanceFile(): string { return join(this.options.stateDir, OWNER_GUIDANCE_FILE); }

  /** The owner's own guidance and Tower's fixed text, as every agent receives them. */
  async guidance(): Promise<GuidanceOverview> {
    const owner = await readFile(this.guidanceFile(), 'utf8').catch(() => '');
    const revision = revisionOf(owner);
    return { owner, revision, tower: AGENT_GUIDANCE, installed: Boolean(this.options.installGuidance), confirmed: this.state.get().guidanceConfirmed === revision };
  }

  private guidanceQueue: Promise<unknown> = Promise.resolve();
  /** Reads, checks and writes the owner's guidance one change at a time, then gives it to the agents. */
  /** Resolves with the revision of the text written. */
  private guidanceChange(change: (current: GuidanceOverview) => Promise<string>): Promise<string> {
    const next = this.guidanceQueue.catch(() => {}).then(async () => {
      const owner = withoutTowerMarkers(await change(await this.guidance()));
      const content = owner.trim() ? `${owner.trimEnd()}\n` : '';
      await mkdir(dirname(this.guidanceFile()), { recursive: true, mode: 0o700 });
      await writePrivateFile(this.guidanceFile(), content);
      await this.options.installGuidance?.();
      return revisionOf(content);
    });
    this.guidanceQueue = next;
    return next;
  }

  /** A backup of the chosen Tower skills (and the owner's guidance, when asked), as one file to download. */
  async exportBundle(input: Record<string, unknown>): Promise<SkillBundle> {
    await this.ready();
    const dirs = Array.isArray(input.dirs) ? input.dirs.filter((dir): dir is string => typeof dir === 'string') : [];
    const pinned = await this.pinned();
    const skills = await Promise.all((await this.files.bundle(dirs)).map(async (skill, index) => {
      const item = this.record(await realpath(dirs[index]!).catch(() => dirs[index]!));
      return { ...skill, pinned: pinned.has(dirs[index]!), ...(item ? { targets: { all: item.all, projects: item.projects.map(cwd => ({ cwd, title: basename(cwd) })) } } : {}) };
    }));
    const owner = input.guidance === true ? (await this.guidance()).owner : undefined;
    const bundle: SkillBundle = { format: SKILL_BUNDLE_FORMAT, version: 1, exportedAt: new Date().toISOString(), from: hostname(), ...(owner ? { guidance: owner } : {}), skills };
    if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_SKILL_BUNDLE_BYTES) throw new SkillError('백업이 20MB를 넘습니다. 스킬을 나눠서 내보내세요.', 413);
    return bundle;
  }

  /** What importing a backup would do here, item by item, before anything is written. */
  async importPlan(input: unknown): Promise<SkillImportPlan> {
    await this.ready();
    const bundle = parseBundle(input);
    const known = (cwd: string) => this.options.sessions().some(session => !session.node && session.cwd === cwd) || Boolean(this.options.projects?.().includes(cwd));
    const items = await Promise.all(bundle.skills.map(async (skill, index) => {
      const cwd = skill.project && known(skill.project.cwd) && (await stat(skill.project.cwd).catch(() => undefined))?.isDirectory() ? skill.project.cwd : undefined;
      const conflict = skill.scope === 'project' && !cwd ? 'new' as const : await this.files.conflict(skill.name, skill.scope, cwd);
      const targets = await this.importTargets(skill);
      const unknownProjects = skill.targets && !skill.targets.all ? skill.targets.projects.length - (targets?.projects.length ?? 0) : 0;
      return { index, name: skill.name, scope: skill.scope, ...(skill.project ? { fromCwd: skill.project.cwd } : {}), conflict, ...(cwd ? { cwd } : {}), pinned: skill.pinned, description: skill.description,
        ...(targets ? { targets } : {}), ...(unknownProjects ? { unknownProjects } : {}) };
    }));
    return { items, guidance: Boolean(bundle.guidance?.trim()), exportedAt: bundle.exportedAt, from: bundle.from };
  }

  /** Where a backed-up skill applies here: its targets on the other computer, keeping the projects this Tower knows. */
  private async importTargets(skill: SkillBundle['skills'][number]): Promise<SkillTargets | undefined> {
    if (!skill.targets) return undefined;
    if (skill.targets.all) return { all: true, projects: [] };
    const projects: string[] = [];
    for (const { cwd } of skill.targets.projects) if (await this.project(cwd).catch(() => undefined) && !projects.includes(cwd)) projects.push(cwd);
    return { all: false, projects };
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
        const dir = await this.files.installDir(item, cwd);
        const existing = this.record(dir);
        let skill: Skill;
        if (existing && await stat(dir).catch(() => undefined)) {
          // A replaced skill keeps where it applies here; only its content comes from the backup.
          skill = await this.files.install(item, cwd, choice.action === 'replace', false);
          await this.apply(dir, { all: existing.all, projects: existing.projects }, false);
        } else {
          const carried = await this.importTargets(item);
          // A project skill applies to the project chosen for it here, in place of the one it came from.
          const targets = carried && item.scope === 'project' && !carried.all ? { all: false, projects: [...new Set([...carried.projects.filter(path => path !== item.project?.cwd), cwd!])] }
            : carried ?? (item.scope === 'global' ? { all: true, projects: [] } : { all: false, projects: [cwd!] });
          await this.files.checkTargets(dir, targets);
          await this.writeRecord({ dir, all: targets.all, projects: targets.projects, linked: targets.projects, globalLinked: targets.all });
          try { skill = await this.files.install(item, cwd, choice.action === 'replace', false); }
          catch (error) {
            if (!await stat(dir).catch(() => undefined)) await this.state.update(state => { state.targets = state.targets.filter(entry => entry.dir !== dir); });
            throw error;
          }
          await this.apply(dir, targets, false);
        }
        if (body.pins === true && item.pinned) await this.pin(skill, true);
      } catch (error) { failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    // The guidance is taken only when every chosen skill came in, so trying again never adds it twice.
    if (failures.length) throw new SkillError(`가져오지 못한 스킬이 있습니다. 지침은 가져오지 않았습니다. ${failures.join(' / ')}`, 409);
    const guidance = bundle.guidance?.trim();
    if (guidance && (body.guidance === 'replace' || body.guidance === 'append')) {
      await this.guidanceChange(async current => body.guidance === 'append' && current.owner.trim() ? `${current.owner.trim()}\n\n${guidance}` : guidance);
    }
  }
}
