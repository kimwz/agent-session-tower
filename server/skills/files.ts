import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Skill, SkillDetail, SkillProvider, SkillScope } from '../../shared/skills.js';
import { MAX_SKILL_BODY, MAX_SKILL_DESCRIPTION, SKILL_NAME } from '../../shared/skills.js';
import { formatSkillFile, parseSkillFile } from './skill-file.js';

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
}
/** `base` is the folder the root must stay inside: no link between it and the root may lead elsewhere. */
interface Root { dir: string; base: string; scope: SkillScope; provider: SkillProvider; cwd?: string; canonical: boolean }
export interface SkillWrite {
  /** An existing skill's folder; absent to create one. */
  dir?: string;
  revision?: string;
  scope: SkillScope;
  cwd?: string;
  name: string;
  description: string;
  body: string;
}

const MAX_FILE = 256 * 1024;

/** The folders of this account, from the same variables the agents themselves read. */
export function skillHomes(stateDir: string, env: NodeJS.ProcessEnv = process.env): SkillHomes {
  const home = homedir();
  return { home, agentsHome: join(home, '.agents'), claudeHome: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    codexHome: env.CODEX_HOME || join(home, '.codex'), trash: join(stateDir, 'skills-trash') };
}
export class SkillError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

/**
 * The skill folders both agents read. A skill is written once in the shared `.agents/skills` folder (global or in the
 * project) and linked into Claude Code's `skills` folder, the layout the `skills` command also uses.
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
    return roots;
  }

  /** Every skill the agents find here: the global ones, and the project's own when a project is given. */
  async list(cwd?: string): Promise<Skill[]> {
    const external = await this.installedBySkillsCommand();
    const found = new Map<string, Skill>();
    for (const root of this.roots(cwd)) {
      let names: string[];
      try { names = await readdir(root.dir); } catch { continue; }
      for (const name of names.sort()) {
        if (name.startsWith('.')) continue;
        const dir = await realpath(join(root.dir, name)).catch(() => undefined);
        if (!dir || !(await stat(dir).catch(() => undefined))?.isDirectory()) continue;
        const existing = found.get(dir);
        if (existing) { if (!existing.providers.includes(root.provider)) existing.providers.push(root.provider); continue; }
        const text = await readSkillText(join(dir, 'SKILL.md'));
        if (text === undefined) continue;
        const parsed = parseSkillFile(text);
        found.set(dir, {
          dir, name: parsed.name?.trim() || name, description: (parsed.description ?? '').trim(),
          scope: root.scope, ...(root.cwd ? { cwd: root.cwd } : {}), providers: [root.provider], pinned: false,
          external: root.scope === 'global' && external.has(basename(dir)), revision: revisionOf(text),
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
    for (const [first, ...others] of groups.values()) {
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
      const link = `${copy.dir}.tower-link-${randomUUID().slice(0, 8)}`;
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
    const roots = this.roots(input.scope === 'project' ? input.cwd : undefined).filter(root => root.scope === input.scope);
    const canonical = roots.find(root => root.canonical)!;
    const dir = join(canonical.dir, name);
    for (const root of roots) {
      if (await lstat(join(root.dir, name)).catch(() => undefined)) throw new SkillError('같은 이름의 스킬이 이미 있습니다.', 409);
    }
    await ensureRoot(canonical);
    await mkdir(dir);
    await writeFile(join(dir, 'SKILL.md'), formatSkillFile({ name, description, body: input.body }), { flag: 'wx' });
    await this.linkNow(dir, input.scope === 'project' ? input.cwd : undefined);
    return this.find(dir, input.cwd);
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
      // Relative to the folder's real place, so the link holds when part of the path is itself a link (/tmp on macOS).
      await symlink(relative(await realpath(root.dir), skill.dir), path, 'dir');
    }
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

  /** Only a skill this listing shows can be read or changed, whatever path a request names. */
  private async find(dir: string, cwd?: string): Promise<Skill> {
    const real = await realpath(dir).catch(() => undefined);
    const skill = real && (await this.list(cwd)).find(item => item.dir === real || item.copies?.some(copy => copy.dir === real));
    if (!skill) throw new SkillError('스킬을 찾을 수 없습니다.', 404);
    return skill;
  }

  private async installedBySkillsCommand(): Promise<Set<string>> {
    try {
      const lock = JSON.parse(await readFile(join(this.homes.agentsHome, '.skill-lock.json'), 'utf8')) as { skills?: Record<string, unknown> };
      return new Set(Object.keys(lock.skills ?? {}));
    } catch { return new Set(); }
  }
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
