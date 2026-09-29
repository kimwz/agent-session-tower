import { createHash, randomUUID } from 'node:crypto';
import { access, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Skill, SkillBundleSkill, SkillDetail, SkillProvider, SkillScope, SkillTargets } from '../../shared/skills.js';
import { MAX_SKILL_BODY, MAX_SKILL_DESCRIPTION, SKILL_NAME } from '../../shared/skills.js';
import { formatSkillFile, parseSkillFile } from './skill-file.js';
import { asideOf, bundleFiles, containsLink, excludeLinks, projectKey, readMoves, trackedByGit, writeBundleFiles, writeMoves, type SkillMove } from './store.js';

export interface SkillHomes {
  /** The account's home folder: project skills are never looked for at or above it. */
  home: string;
  /** `~/.agents`: the shared skills folder Codex and the `skills` command use. */
  agentsHome: string;
  /** Claude Code's configuration directory (`CLAUDE_CONFIG_DIR`, normally `~/.claude`). */
  claudeHome: string;
  /** Codex's home (`CODEX_HOME`, normally `~/.codex`). */
  codexHome: string;
  /** Where deleted skills are moved, so a deletion can be undone by hand. */
  trash: string;
  /** Tower's own skill folder, `<state>/skills`: the skills Tower keeps, backed up and moved with it. */
  store: string;
  /** Moves into the store in progress, finished or undone at the next start. */
  journal: string;
}
/** `base` is the folder the root must stay inside: no link between it and the root may lead elsewhere. */
interface Root { dir: string; base: string; scope: SkillScope; provider?: SkillProvider; cwd?: string; canonical: boolean }
export interface SkillWrite {
  /** An existing skill's folder; absent to create one. */
  dir?: string;
  revision?: string;
  scope: SkillScope;
  cwd?: string;
  name: string;
  description: string;
  body: string;
  /** False for a Tower skill whose targets are applied right after: it is created without any link. */
  link?: boolean;
}

const MAX_FILE = 256 * 1024;

/** The folders of this account, from the same variables the agents themselves read. */
export function skillHomes(stateDir: string, env: NodeJS.ProcessEnv = process.env): SkillHomes {
  const home = homedir();
  return { home, agentsHome: join(home, '.agents'), claudeHome: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    codexHome: env.CODEX_HOME || join(home, '.codex'), trash: join(stateDir, 'skills-trash'),
    store: join(stateDir, 'skills'), journal: join(stateDir, 'skills-moves.json') };
}
export class SkillError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

/**
 * The skill folders both agents read, and Tower's own store. A skill made in Tower is kept in the store and linked into
 * each agent's folder (`.agents/skills` for Codex, `.claude/skills` for Claude Code), globally or in the project.
 */
export class SkillFiles {
  constructor(private readonly homes: SkillHomes) {}

  private roots(cwd?: string): Root[] {
    const roots: Root[] = [
      { dir: join(this.homes.agentsHome, 'skills'), base: this.homes.agentsHome, scope: 'global', provider: 'codex', canonical: true },
      { dir: join(this.homes.claudeHome, 'skills'), base: this.homes.claudeHome, scope: 'global', provider: 'claude', canonical: false },
      { dir: join(this.homes.codexHome, 'skills'), base: this.homes.codexHome, scope: 'global', provider: 'codex', canonical: false },
    ];
    for (const dir of projectFolders(cwd, this.homes.home)) roots.push(
      { dir: join(dir, '.agents', 'skills'), base: dir, scope: 'project', provider: 'codex', cwd: dir, canonical: dir === cwd },
      { dir: join(dir, '.claude', 'skills'), base: dir, scope: 'project', provider: 'claude', cwd: dir, canonical: false },
    );
    // Tower's store comes last: a stored skill is found through its links first, and alone when they are missing.
    roots.push({ dir: join(this.homes.store, 'global'), base: this.homes.store, scope: 'global', canonical: false });
    for (const dir of projectFolders(cwd, this.homes.home)) roots.push({ dir: this.projectStore(dir), base: this.homes.store, scope: 'project', cwd: dir, canonical: false });
    return roots;
  }

  private projectStore(cwd: string): string { return join(this.homes.store, 'projects', projectKey(cwd)); }

  /** The folder a new Tower skill of this name gets, by its real path: the key its targets are recorded under. */
  async towerDir(name: string): Promise<string> {
    await mkdir(this.homes.store, { recursive: true, mode: 0o700 });
    return join(await this.storeReal(), 'global', name);
  }

  /** Where a Tower skill applied before it had targets of its own: everywhere when global, else its project. */
  async storedTargets(dir: string): Promise<SkillTargets> {
    if (dirname(dir) === join(await this.storeReal(), 'global')) return { all: true, projects: [] };
    try {
      const saved = JSON.parse(await readFile(join(dirname(dir), 'project.json'), 'utf8')) as { cwd?: unknown };
      if (typeof saved.cwd === 'string' && isAbsolute(saved.cwd)) return { all: false, projects: [resolve(saved.cwd)] };
    } catch { /* A folder without its project record applies nowhere. */ }
    return { all: false, projects: [] };
  }

  /** The folder a backed-up skill is installed into, by its real path, before it exists. */
  async installDir(item: Pick<SkillBundleSkill, 'name' | 'scope'>, cwd?: string): Promise<string> {
    await mkdir(this.homes.store, { recursive: true, mode: 0o700 });
    const store = await this.storeReal();
    return join(item.scope === 'global' ? join(store, 'global') : join(store, 'projects', projectKey(cwd!)), item.name);
  }

  private async storeReal(): Promise<string> { return realpath(this.homes.store).catch(() => resolve(this.homes.store)); }

  /** Makes the store folder a skill of `scope` goes to, with the project's path beside it. */
  private async storeRoot(scope: SkillScope, cwd?: string): Promise<string> {
    await mkdir(this.homes.store, { recursive: true, mode: 0o700 });
    if (scope === 'global') { await ensureRoot({ dir: join(this.homes.store, 'global'), base: this.homes.store, scope, canonical: false }); return join(this.homes.store, 'global'); }
    const dir = this.projectStore(cwd!);
    await ensureRoot({ dir, base: this.homes.store, scope, cwd, canonical: false });
    const file = join(dir, 'project.json');
    if (!existsSync(file)) await writeFile(file, `${JSON.stringify({ cwd: resolve(cwd!) }, null, 2)}\n`);
    return dir;
  }

  /** Every skill the agents find here: the global ones, and the project's own when a project is given. */
  async list(cwd?: string): Promise<Skill[]> {
    const external = await this.installedBySkillsCommand();
    const store = await this.storeReal();
    const found = new Map<string, Skill>();
    for (const root of this.roots(cwd)) {
      let names: string[];
      try { names = await readdir(root.dir); } catch { continue; }
      for (const name of names.sort()) {
        if (name.startsWith('.')) continue;
        const dir = await realpath(join(root.dir, name)).catch(() => undefined);
        if (!dir || !(await stat(dir).catch(() => undefined))?.isDirectory()) continue;
        const existing = found.get(dir);
        if (existing) { if (root.provider && !existing.providers.includes(root.provider)) existing.providers.push(root.provider); continue; }
        const text = await readSkillText(join(dir, 'SKILL.md'));
        if (text === undefined) continue;
        const parsed = parseSkillFile(text);
        found.set(dir, {
          dir, name: parsed.name?.trim() || name, description: (parsed.description ?? '').trim(),
          scope: root.scope, ...(root.cwd ? { cwd: root.cwd } : {}), providers: root.provider ? [root.provider] : [], pinned: false,
          external: root.scope === 'global' && external.has(basename(dir)), managed: dir.startsWith(store + sep), revision: revisionOf(text),
        });
      }
    }
    // One skill in one place is one entry, however many folders hold a copy of it.
    const groups = new Map<string, Skill[]>();
    for (const skill of found.values()) {
      const key = `${skill.scope}\0${skill.cwd ?? ''}\0${skill.name}`;
      groups.set(key, [...groups.get(key) ?? [], skill]);
    }
    const skills: Skill[] = [];
    for (const group of groups.values()) {
      // The copy Tower keeps is the one listed, edited and kept when copies are merged.
      const [first, ...others] = [...group.filter(skill => skill.managed), ...group.filter(skill => !skill.managed)];
      if (!others.length) { skills.push(first); continue; }
      const all = [first, ...others];
      const digests = await Promise.all(all.map(skill => folderDigest(skill.dir)));
      skills.push({ ...first, providers: [...new Set(all.flatMap(skill => skill.providers))],
        copies: all.map(skill => ({ dir: skill.dir, providers: [...skill.providers].sort() })),
        copiesDiffer: digests.some(digest => !digest || digest !== digests[0]) });
    }
    return skills.map(skill => ({ ...skill, providers: [...skill.providers].sort() }))
      .sort((a, b) => a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1);
  }

  async detail(dir: string, cwd?: string): Promise<SkillDetail> {
    const skill = await this.find(dir, cwd);
    const text = await readSkillText(join(skill.dir, 'SKILL.md'));
    if (text === undefined) throw new SkillError('스킬 파일을 읽을 수 없습니다.', 404);
    return { ...skill, revision: revisionOf(text), body: parseSkillFile(text).body };
  }

  private queue: Promise<unknown> = Promise.resolve();
  /** Changes run one at a time, so two saves of the same revision can never both succeed. */
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(change);
    this.queue = next;
    return next;
  }

  save(input: SkillWrite): Promise<Skill> { return this.serial(() => this.write(input)); }
  link(dir: string, cwd?: string): Promise<Skill> { return this.serial(() => this.linkNow(dir, cwd)); }
  remove(dir: string, cwd?: string): Promise<void> { return this.serial(() => this.removeNow(dir, cwd)); }
  merge(dir: string, cwd?: string): Promise<Skill> { return this.serial(() => this.mergeNow(dir, cwd)); }

  /**
   * Keeps one folder of a skill whose copies are identical: the others go to Tower's trash and a link to the kept one
   * takes their place, so every agent still finds it and an edit reaches all of them.
   */
  private async mergeNow(dir: string, cwd?: string): Promise<Skill> {
    const skill = await this.find(dir, cwd);
    if (!skill.copies) return skill;
    if (skill.copiesDiffer) throw new SkillError('복사본의 내용이 달라 합칠 수 없습니다.', 409);
    const roots = await this.realRoots(skill.cwd);
    for (const copy of skill.copies) {
      if (copy.dir === skill.dir || !roots.has(dirname(copy.dir))) continue;
      // The link is made first beside the copy, then swapped in; if that fails, the copy comes back from the trash.
      const link = join(dirname(copy.dir), `.${basename(copy.dir)}.tower-link-${randomUUID().slice(0, 8)}`);
      await symlink(relative(dirname(copy.dir), skill.dir), link, 'dir');
      let kept: string;
      try { kept = await this.trash(copy.dir); }
      catch (error) { await unlink(link).catch(() => {}); throw error; }
      try { await rename(link, copy.dir); }
      catch (error) {
        await unlink(link).catch(() => {});
        await move(kept, copy.dir).catch(() => {});
        throw error;
      }
    }
    return this.find(skill.dir, cwd);
  }

  adopt(dir: string, cwd?: string): Promise<{ skill: Skill; from: string[] }> { return this.serial(() => this.adoptNow(dir, cwd)); }
  /** Finishes or undoes the moves a crash interrupted; run before skills serve anything. Returns the finished ones. */
  recover(): Promise<SkillMove[]> { return this.serial(() => this.recoverNow()); }
  /** Moves in progress right now, so a pin on an old place still counts. */
  pending(): readonly SkillMove[] { return this.moving; }
  private moving: SkillMove[] = [];

  /**
   * Moves a skill kept elsewhere into Tower's store: its folder is copied in, and every place it was (identical copies
   * included) becomes a link to the stored one; the other agent gets a link too. The move is recorded before anything
   * changes: until the copy is complete a crash undoes it, after that the next start finishes it.
   */
  private async adoptNow(dir: string, cwd?: string): Promise<{ skill: Skill; from: string[] }> {
    const skill = await this.find(dir, cwd);
    if (skill.managed) return { skill, from: [] };
    if (skill.copiesDiffer) throw new SkillError('에이전트별 복사본의 내용이 달라 옮길 수 없습니다. 먼저 하나로 정리하세요.', 409);
    const roots = await this.realRoots(skill.cwd);
    const places = [skill.dir, ...(skill.copies ?? []).map(copy => copy.dir).filter(place => place !== skill.dir)];
    if (places.some(place => !roots.has(dirname(place)))) throw new SkillError('스킬 폴더 밖에 있는 스킬은 옮길 수 없습니다.', 409);
    if (await containsLink(skill.dir)) throw new SkillError('스킬 폴더 안에 링크가 있어 옮길 수 없습니다. 링크가 가리키는 파일이 따라오지 않습니다.', 409);
    // A folder git tracks (a project's shared skill, or a dotfiles repository) would show as deleted, and a commit would
    // remove it for everyone; git would also turn the link back into a folder on the next checkout.
    for (const place of places) if (await trackedByGit(place)) throw new SkillError('git이 관리하는 스킬 폴더라 옮기지 않습니다. 저장소에서 함께 쓰는 스킬은 그대로 두세요.', 409);
    for (const place of places) {
      try { await access(dirname(place), constants.W_OK); }
      catch { throw new SkillError('스킬이 있는 폴더에 쓸 수 없어 옮길 수 없습니다.', 409); }
    }
    const root = await this.storeRoot(skill.scope, skill.cwd);
    const to = join(root, basename(skill.dir));
    if (await lstat(to).catch(() => undefined)) throw new SkillError('타워에 같은 이름의 스킬이 이미 있습니다.', 409);
    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    const move: SkillMove = { id, to, incoming: join(root, `.incoming-${id}`), places };
    await this.journal(moves => [...moves, move]);
    this.moving = [...this.moving, move];
    try {
      try {
        await cp(skill.dir, move.incoming, { recursive: true, errorOnExist: true, force: false });
        await rename(move.incoming, to);
      } catch (error) { await this.settle(move).catch(() => {}); throw error; }
      await this.settle(move);
    } finally { this.moving = this.moving.filter(item => item !== move); }
    return { skill: await this.find(to, cwd), from: places };
  }

  /**
   * Brings one recorded move to an end from what is on disk. Before the stored copy is complete the move is undone;
   * once it is, every place becomes a link to it, whatever step a crash stopped at. Each step can be repeated.
   */
  private async settle(move: SkillMove): Promise<boolean> {
    const aside = (place: string) => asideOf(place, move.id), link = (place: string) => join(dirname(place), `.${basename(place)}.tower-link-${move.id}`);
    for (const place of move.places) if ((await lstat(link(place)).catch(() => undefined))?.isSymbolicLink()) await unlink(link(place));
    const stored = await lstat(move.to).catch(() => undefined);
    if (!stored?.isDirectory()) {
      for (const place of move.places) if (!await lstat(place).catch(() => undefined) && await lstat(aside(place)).catch(() => undefined)) await rename(aside(place), place);
      await rm(move.incoming, { recursive: true, force: true });
      await this.journal(moves => moves.filter(item => item.id !== move.id));
      return false;
    }
    for (const place of move.places) {
      const at = await lstat(place).catch(() => undefined);
      if (at?.isSymbolicLink()) continue;
      if (!at) { await symlink(move.to, place, 'dir'); continue; }
      if (!at.isDirectory()) continue;
      await symlink(move.to, link(place), 'dir');
      await rename(place, aside(place));
      await rename(link(place), place);
    }
    await rm(move.incoming, { recursive: true, force: true });
    await this.finish(move);
    return true;
  }

  private async finish(move: SkillMove): Promise<void> {
    const skill = await this.find(move.to).catch(() => undefined) ?? await this.findStored(move.to);
    if (skill) await this.linkNow(skill.dir, skill.cwd);
    for (const place of move.places) {
      const aside = asideOf(place, move.id);
      if (await lstat(aside).catch(() => undefined)) await this.trash(aside);
    }
    await this.journal(moves => moves.filter(item => item.id !== move.id));
    this.finished.push(move);
  }
  private finished: SkillMove[] = [];

  /** Store folders Tower may clean up: real folders inside its own, never a link leading elsewhere. */
  private async storeFolders(): Promise<string[]> {
    const real = async (path: string) => { const info = await lstat(path).catch(() => undefined); return Boolean(info?.isDirectory() && !info.isSymbolicLink()); };
    if (!await real(this.homes.store)) return [];
    const folders: string[] = [];
    if (await real(join(this.homes.store, 'global'))) folders.push(join(this.homes.store, 'global'));
    if (await real(join(this.homes.store, 'projects'))) {
      for (const key of await readdir(join(this.homes.store, 'projects')).catch(() => [] as string[])) {
        if (await real(join(this.homes.store, 'projects', key))) folders.push(join(this.homes.store, 'projects', key));
      }
    }
    return folders;
  }

  private async recoverNow(): Promise<SkillMove[]> {
    this.finished = [];
    const folders = await this.storeFolders();
    for (const move of await readMoves(this.homes.journal)) {
      // Only a move into one of Tower's own folders is touched; anything else in the record is dropped as it is.
      if (!folders.includes(dirname(move.to)) || dirname(move.incoming) !== dirname(move.to)) { await this.journal(moves => moves.filter(item => item.id !== move.id)); continue; }
      // One move that cannot be settled now (a folder not writable, say) stays recorded and never blocks the others.
      try { await this.settle(move); }
      catch (error) { console.error(`A skill move could not be settled yet: ${error instanceof Error ? error.message : String(error)}`); }
    }
    // An import or replacement stopped half way: a replaced skill whose new copy never arrived comes back.
    for (const folder of folders) {
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        const path = join(folder, name);
        if (/^\.incoming-[0-9a-f]{8}$/.test(name)) { await rm(path, { recursive: true, force: true }); continue; }
        const aside = name.match(/^\.([a-z0-9][a-z0-9-]{0,63})\.tower-old-[0-9a-f]{8}$/)?.[1];
        if (!aside || !(await lstat(path).catch(() => undefined))?.isDirectory()) continue;
        try {
          if (await lstat(join(folder, aside)).catch(() => undefined)) await this.trash(path);
          else await rename(path, join(folder, aside));
        } catch (error) { console.error(`A replaced skill could not be restored yet: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    return this.finished.splice(0);
  }

  private async journal(change: (moves: SkillMove[]) => SkillMove[]): Promise<void> {
    await mkdir(dirname(this.homes.journal), { recursive: true, mode: 0o700 });
    await writeMoves(this.homes.journal, change(await readMoves(this.homes.journal)));
  }

  /** A stored skill found by its own folder, whatever project it belongs to. */
  private async findStored(dir: string): Promise<Skill | undefined> {
    return (await this.managed()).find(skill => skill.dir === dir);
  }

  /** Every skill Tower keeps: the global ones and those of every project it has a folder for. */
  async managed(): Promise<Skill[]> {
    const cwds: string[] = [];
    for (const key of await readdir(join(this.homes.store, 'projects')).catch(() => [] as string[])) {
      try {
        const saved = JSON.parse(await readFile(join(this.homes.store, 'projects', key, 'project.json'), 'utf8')) as { cwd?: unknown };
        if (typeof saved.cwd === 'string' && this.projectStore(saved.cwd) === join(this.homes.store, 'projects', key)) cwds.push(saved.cwd);
      } catch { /* A folder without its project record is not Tower's. */ }
    }
    const seen = new Set<string>();
    const all: Skill[] = [];
    for (const cwd of [undefined, ...cwds]) {
      for (const skill of await this.list(cwd)) {
        if (!skill.managed || seen.has(skill.dir) || (cwd && skill.scope === 'project' && skill.cwd !== cwd)) continue;
        seen.add(skill.dir);
        all.push(skill);
      }
    }
    return all;
  }

  /** The chosen stored skills as backup entries: their files, where they belong and what they are. */
  async bundle(dirs: string[]): Promise<Omit<SkillBundleSkill, 'pinned'>[]> {
    const stored = await this.managed();
    const chosen = dirs.map(dir => stored.find(skill => skill.dir === dir));
    if (chosen.some(skill => !skill)) throw new SkillError('타워가 관리하는 스킬만 백업할 수 있습니다.', 404);
    return Promise.all(chosen.map(async skill => ({ name: basename(skill!.dir), description: skill!.description, scope: skill!.scope,
      ...(skill!.scope === 'project' && skill!.cwd ? { project: { cwd: skill!.cwd, title: basename(skill!.cwd) } } : {}),
      files: await bundleFiles(skill!.dir) })));
  }

  /** What is in the way of a backed-up skill here: nothing, a Tower skill that may be replaced, or a skill Tower does not keep. */
  async conflict(name: string, scope: SkillScope, cwd?: string): Promise<'new' | 'managed' | 'external'> {
    const store = join(scope === 'global' ? join(this.homes.store, 'global') : this.projectStore(cwd!), name);
    const agents = this.roots(cwd).filter(root => root.provider && root.scope === scope && (scope === 'global' || root.cwd === cwd));
    const real = await this.storeReal();
    for (const root of agents) {
      const path = join(root.dir, name);
      if (!await lstat(path).catch(() => undefined)) continue;
      const target = await realpath(path).catch(() => '');
      if (!target.startsWith(real + sep)) return 'external';
    }
    return await lstat(store).catch(() => undefined) ? 'managed' : 'new';
  }

  /** Writes a backed-up skill into the store, replacing a Tower skill of that name only when asked, and links it. */
  install(item: SkillBundleSkill, cwd: string | undefined, replace: boolean, link = true): Promise<Skill> {
    return this.serial(async () => {
      const conflict = await this.conflict(item.name, item.scope, cwd);
      if (conflict === 'external' || conflict === 'managed' && !replace) throw new SkillError('같은 이름의 스킬이 이미 있습니다.', 409);
      const root = await this.storeRoot(item.scope, cwd);
      const target = join(root, item.name), id = randomUUID().replace(/-/g, '').slice(0, 8);
      const incoming = join(root, `.incoming-${id}`), aside = asideOf(target, id);
      await writeBundleFiles(incoming, item.files).catch(async error => { await rm(incoming, { recursive: true, force: true }); throw error; });
      if (conflict === 'managed') await rename(target, aside);
      try { await rename(incoming, target); }
      catch (error) { if (conflict === 'managed') await rename(aside, target).catch(() => {}); await rm(incoming, { recursive: true, force: true }); throw error; }
      if (conflict === 'managed') await this.trash(aside);
      return link ? this.linkNow(target, cwd) : this.find(target, cwd);
    });
  }

  private async realRoots(cwd?: string): Promise<Set<string>> {
    return new Set((await Promise.all(this.roots(cwd).map(root => realpath(root.dir).catch(() => '')))).filter(Boolean));
  }

  /** Moves a folder to Tower's trash and says where it went. */
  private async trash(dir: string): Promise<string> {
    await mkdir(this.homes.trash, { recursive: true, mode: 0o700 });
    const target = join(this.homes.trash, `${new Date().toISOString().replace(/[:.]/g, '-')}-${basename(dir)}-${randomUUID().slice(0, 8)}`);
    await move(dir, target);
    return target;
  }

  private async write(input: SkillWrite): Promise<Skill> {
    const name = input.name.trim(), description = input.description.trim().replace(/\s*\n\s*/g, ' ');
    if (!SKILL_NAME.test(name)) throw new SkillError('스킬 이름은 영어 소문자, 숫자, 하이픈으로 64자 이내로 쓰세요.');
    if (!description || description.length > MAX_SKILL_DESCRIPTION) throw new SkillError('언제 쓰는 스킬인지 1024자 이내로 쓰세요.');
    if (Buffer.byteLength(input.body) > MAX_SKILL_BODY) throw new SkillError('스킬 내용이 너무 깁니다.');
    if (input.dir) return this.update(input.dir, input.cwd, name, description, input.body, input.revision);
    if (input.scope === 'project' && !input.cwd) throw new SkillError('프로젝트 스킬은 프로젝트 폴더가 필요합니다.');
    const cwd = input.scope === 'project' ? resolve(input.cwd!) : undefined;
    const roots = this.roots(cwd).filter(root => root.scope === input.scope && (root.scope === 'global' || root.cwd === cwd || !root.provider));
    for (const root of roots) {
      if (await lstat(join(root.dir, name)).catch(() => undefined)) throw new SkillError('같은 이름의 스킬이 이미 있습니다.', 409);
    }
    // Two Tower skills of one name could never both be linked into the same project.
    if ((await this.managed()).some(skill => basename(skill.dir) === name)) throw new SkillError('타워에 같은 이름의 스킬이 이미 있습니다.', 409);
    // A skill made in Tower lives in Tower's store; the agents reach it through links.
    const dir = join(await this.storeRoot(input.scope, cwd), name);
    await mkdir(dir);
    await writeFile(join(dir, 'SKILL.md'), formatSkillFile({ name, description, body: input.body }), { flag: 'wx' });
    if (input.link !== false) await this.linkNow(dir, cwd);
    return this.find(dir, cwd);
  }

  /** Links a skill into every agent's folder of its scope that does not have it yet. */
  private async linkNow(dir: string, cwd?: string): Promise<Skill> {
    const skill = await this.find(dir, cwd);
    const roots = this.roots(skill.cwd).filter(root => root.scope === skill.scope && (root.canonical || root.provider === 'claude'));
    for (const provider of ['claude', 'codex'] as const) {
      if (skill.providers.includes(provider)) continue;
      const root = roots.find(item => item.provider === provider);
      if (!root) continue;
      const path = join(root.dir, basename(skill.dir));
      if (await lstat(path).catch(() => undefined)) throw new SkillError('연결할 스킬 폴더에 같은 이름이 이미 있습니다.', 409);
      await ensureRoot(root);
      // A stored skill is linked by its absolute path; others relative to the folder's real place, so the link holds
      // when part of the path is itself a link (/tmp on macOS).
      await symlink(skill.managed ? skill.dir : relative(await realpath(root.dir), skill.dir), path, 'dir');
    }
    if (skill.managed && skill.scope === 'project' && skill.cwd) await excludeLinks(skill.cwd, basename(skill.dir), true);
    return this.find(skill.dir, cwd);
  }

  /**
   * Moves the skill folder to Tower's trash, then removes the links to it. A skill that is only a link to a folder
   * outside the skill folders (a whole project, say) loses its links; that folder is never moved.
   */
  private async removeNow(dir: string, cwd?: string): Promise<void> {
    const skill = await this.find(dir, cwd);
    const roots = this.roots(skill.cwd);
    const owned = await this.realRoots(skill.cwd);
    const folders = skill.copies?.map(copy => copy.dir) ?? [skill.dir];
    for (const folder of folders) if (owned.has(dirname(folder))) await this.trash(folder);
    for (const root of roots) {
      // A skills folder reached through a link leads outside the folders Tower may change.
      if (!await rootIsSafe(root)) continue;
      let names: string[];
      try { names = await readdir(root.dir); } catch { continue; }
      const real = await realpath(root.dir).catch(() => root.dir);
      for (const name of names) {
        const path = join(root.dir, name);
        if (!(await lstat(path).catch(() => undefined))?.isSymbolicLink()) continue;
        const target = await readlink(path);
        const leads = [resolve(real, target), resolve(root.dir, target), await realpath(path).catch(() => '')];
        if (leads.some(lead => folders.includes(lead))) await unlink(path);
      }
    }
    // The exclude lines stay: other worktrees of the repository share them, and the owner may have written the same line.
  }

  private async update(dir: string, cwd: string | undefined, name: string, description: string, body: string, revision?: string): Promise<Skill> {
    const skill = await this.find(dir, cwd);
    const file = join(skill.dir, 'SKILL.md');
    const text = await readSkillText(file);
    if (text === undefined) throw new SkillError('스킬 파일을 읽을 수 없습니다.', 404);
    if (revision !== revisionOf(text)) throw new SkillError('다른 곳에서 이 스킬이 바뀌었습니다. 다시 열어 최신 내용으로 고치세요.', 409);
    const parsed = parseSkillFile(text);
    const temporary = join(skill.dir, `.SKILL.md.${process.pid}.${randomUUID()}.tmp`);
    const mode = (await stat(file)).mode & 0o777;
    try {
      await writeFile(temporary, formatSkillFile({ name, description, body, frontmatter: parsed.frontmatter }), { flag: 'wx', mode });
      await rename(temporary, file);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return this.find(skill.dir, cwd);
  }

  /**
   * Only a skill this listing shows can be read or changed, whatever path a request names; a skill kept in Tower is
   * found wherever it applies, even with no link anywhere.
   */
  private async find(dir: string, cwd?: string): Promise<Skill> {
    const real = await realpath(dir).catch(() => undefined);
    const match = (item: Skill) => item.dir === real || item.copies?.some(copy => copy.dir === real);
    const skill = real && ((await this.list(cwd)).find(match) ?? (real.startsWith(await this.storeReal() + sep) ? (await this.managed()).find(match) : undefined));
    if (!skill) throw new SkillError('스킬을 찾을 수 없습니다.', 404);
    return skill;
  }
  lookup(dir: string, cwd?: string): Promise<Skill> { return this.find(dir, cwd); }

  /** A Tower skill's name and description as its SKILL.md says, for naming it to a turn. */
  async describe(dir: string): Promise<{ name: string; description: string } | undefined> {
    const text = await readSkillText(join(dir, 'SKILL.md'));
    if (text === undefined) return undefined;
    const parsed = parseSkillFile(text);
    return { name: parsed.name?.trim() || basename(dir), description: (parsed.description ?? '').trim() };
  }

  /** The agents' global folders a Tower skill applying everywhere is linked into, and those only swept. */
  private globalRoots(): { link: Root[]; sweep: Root[] } {
    const link: Root[] = [
      { dir: join(this.homes.agentsHome, 'skills'), base: this.homes.agentsHome, scope: 'global', provider: 'codex', canonical: true },
      { dir: join(this.homes.claudeHome, 'skills'), base: this.homes.claudeHome, scope: 'global', provider: 'claude', canonical: false },
    ];
    return { link, sweep: [...link, { dir: join(this.homes.codexHome, 'skills'), base: this.homes.codexHome, scope: 'global', provider: 'codex', canonical: false }] };
  }
  private projectRoots(cwd: string): Root[] {
    return [{ dir: join(cwd, '.agents', 'skills'), base: cwd, scope: 'project', provider: 'codex', cwd, canonical: true },
      { dir: join(cwd, '.claude', 'skills'), base: cwd, scope: 'project', provider: 'claude', cwd, canonical: false }];
  }

  /**
   * Refuses targets a Tower skill cannot be linked into, before anything changes: a different skill of the same name
   * there, or a skills folder reached through a link.
   */
  async checkTargets(dir: string, targets: SkillTargets): Promise<void> {
    const name = basename(dir);
    const wanted = [...(targets.all ? this.globalRoots().link : []), ...targets.projects.flatMap(cwd => this.projectRoots(cwd))];
    for (const root of wanted) {
      const where = root.cwd ? basename(root.cwd) : root.dir;
      if (!await rootIsSafe(root)) throw new SkillError(`${where}의 스킬 폴더가 다른 곳을 가리키는 링크라 쓸 수 없습니다.`, 409);
      const path = join(root.dir, name);
      if (!await lstat(path).catch(() => undefined)) continue;
      if (await realpath(path).catch(() => '') !== dir) throw new SkillError(`${where}에 같은 이름의 다른 스킬이 이미 있습니다.`, 409);
    }
  }

  /**
   * Makes the links of a Tower skill match its targets: links where it applies, none where it may have been linked
   * before (`tracked`) and no longer applies. Only links leading to this skill are removed, never a folder.
   */
  reconcile(dir: string, targets: SkillTargets, tracked: { projects: string[]; global: boolean }): Promise<void> {
    return this.serial(async () => {
      const name = basename(dir);
      if (!(await stat(dir).catch(() => undefined))?.isDirectory()) throw new SkillError('스킬을 찾을 수 없습니다.', 404);
      // A project folder that is gone is never made again by linking into it.
      const present: string[] = [];
      for (const cwd of targets.projects) if ((await stat(cwd).catch(() => undefined))?.isDirectory()) present.push(cwd);
      const wanted = [...(targets.all ? this.globalRoots().link : []), ...present.flatMap(cwd => this.projectRoots(cwd))];
      // One place that cannot be linked never keeps the others from being linked and cleaned up.
      const failures: string[] = [];
      for (const root of wanted) {
        const path = join(root.dir, name);
        if (await lstat(path).catch(() => undefined)) {
          if (await realpath(path).catch(() => '') !== dir) failures.push(`${root.cwd ? basename(root.cwd) : root.dir}에 같은 이름의 다른 스킬이 이미 있습니다.`);
          continue;
        }
        try { await ensureRoot(root); await symlink(dir, path, 'dir'); }
        catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      }
      for (const cwd of present) await excludeLinks(cwd, name, true).catch(() => {});
      const keep = new Set(wanted.map(root => root.dir));
      const sweep = [...(targets.all ? [] : this.globalRoots().sweep), ...[...new Set(tracked.projects)].filter(cwd => !targets.projects.includes(cwd)).flatMap(cwd => this.projectRoots(cwd))]
        .filter(root => !keep.has(root.dir));
      // Every link is judged before any is removed: a link to a link reads as broken once the first one is gone.
      const doomed: string[] = [];
      for (const root of sweep) {
        if (!await rootIsSafe(root)) continue;
        const path = join(root.dir, name);
        if ((await lstat(path).catch(() => undefined))?.isSymbolicLink() && await realpath(path).catch(() => '') === dir) doomed.push(path);
      }
      for (const path of doomed) await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(error instanceof Error ? error.message : String(error)); });
      if (failures.length) throw new SkillError(failures.join(' / '), 409);
    });
  }

  private async installedBySkillsCommand(): Promise<Set<string>> {
    try {
      const lock = JSON.parse(await readFile(join(this.homes.agentsHome, '.skill-lock.json'), 'utf8')) as { skills?: Record<string, unknown> };
      return new Set(Object.keys(lock.skills ?? {}));
    } catch { return new Set(); }
  }
}

/**
 * Whether no folder from a root's base down to its skills folder is a link, checked without creating anything: a
 * missing folder is safe (there is nothing in it to remove).
 */
async function rootIsSafe(root: Root): Promise<boolean> {
  const base = await lstat(root.base).catch(() => undefined);
  if (!base) return true;
  if (!base.isDirectory() && !base.isSymbolicLink()) return false;
  let path = root.base;
  for (const part of relative(root.base, root.dir).split(/[\\/]/).filter(Boolean)) {
    path = join(path, part);
    const info = await lstat(path).catch(() => undefined);
    if (!info) return true;
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
  }
  return true;
}

/**
 * Creates a skills folder where it belongs. No folder between its base and it may be a link, so a write can never
 * land outside (a project's `.agents` linked to another disk, say).
 */
async function ensureRoot(root: Root): Promise<void> {
  await mkdir(root.base, { recursive: true });
  const parts = relative(root.base, root.dir).split(/[\\/]/).filter(Boolean);
  let path = root.base;
  for (const part of parts) {
    path = join(path, part);
    const info = await lstat(path).catch(() => undefined);
    if (info?.isSymbolicLink() || info && !info.isDirectory()) throw new SkillError('스킬 폴더가 다른 곳을 가리키는 링크라 쓸 수 없습니다.', 409);
    if (!info) await mkdir(path);
  }
}

/**
 * A project's folder and the folders above it up to its repository root, where both agents also look for project
 * skills (`/repo/.agents/skills` applies in `/repo/packages/app`). Never the home folder or above it.
 */
export function projectFolders(cwd: string | undefined, home: string): string[] {
  if (!cwd) return [];
  const start = resolve(cwd), stop = resolve(home);
  const folders = [start];
  for (let dir = start; !existsSync(join(dir, '.git')); ) {
    const parent = dirname(dir);
    // Outside a repository only the folder itself counts.
    if (parent === dir || parent === stop || folders.length >= 12) return [start];
    folders.push(dir = parent);
  }
  return folders;
}

/** Moves a folder; across volumes (a project on an external disk) it is copied, then the original removed. */
async function move(from: string, to: string): Promise<void> {
  try { await rename(from, to); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

/** A folder's files and contents in one hash; undefined when it is too large to compare. */
async function folderDigest(dir: string): Promise<string | undefined> {
  const hash = createHash('sha256');
  let files = 0, bytes = 0;
  const walk = async (folder: string, prefix: string): Promise<boolean> => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name), name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) { if (!await walk(path, `${name}/`)) return false; continue; }
      // A link's target may differ between copies even when its text is the same: such folders are never called equal.
      if (entry.isSymbolicLink()) return false;
      if (!entry.isFile()) continue;
      const content = await readFile(path);
      if (++files > 500 || (bytes += content.length) > 8_000_000) return false;
      hash.update(`file:${name}:${content.length}\0`).update(content);
    }
    return true;
  };
  try { return await walk(dir, '') ? hash.digest('hex') : undefined; } catch { return undefined; }
}

async function readSkillText(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE) return undefined;
    return await readFile(file, 'utf8');
  } catch { return undefined; }
}

export function revisionOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
