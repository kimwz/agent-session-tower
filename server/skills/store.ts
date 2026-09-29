import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { SkillBundle, SkillBundleFile } from '../../shared/skills.js';
import { MAX_SKILL_BUNDLE_BYTES, SKILL_BUNDLE_FORMAT, SKILL_NAME } from '../../shared/skills.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/**
 * Tower's own skill folder, `<state>/skills`: `global/<name>` and `projects/<folder>-<hash>/<name>` with the project's
 * path in `project.json`. The agents reach a stored skill through links in their own skill folders.
 */
export function projectKey(cwd: string): string {
  const name = basename(cwd).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'project';
  return `${name}-${createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 8)}`;
}

/**
 * A move of a skill into Tower, recorded before anything is changed so a crash can be finished or undone. `places` are
 * the folders the skill was in (the first is copied); each becomes a link to `to`.
 */
export interface SkillMove { id: string; to: string; incoming: string; places: string[] }

export async function readMoves(path: string): Promise<SkillMove[]> {
  try {
    const saved = await readPrivateJson(path, 1_000_000);
    return Array.isArray(saved) ? saved.filter((item): item is SkillMove => !!item && typeof item === 'object'
      && /^[0-9a-f]{8}$/.test(String((item as SkillMove).id)) && typeof (item as SkillMove).to === 'string' && typeof (item as SkillMove).incoming === 'string'
      && Array.isArray((item as SkillMove).places) && (item as SkillMove).places.length > 0 && (item as SkillMove).places.every(place => typeof place === 'string' && isAbsolute(place))) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
export async function writeMoves(path: string, moves: SkillMove[]): Promise<void> {
  await writePrivateJson(path, JSON.stringify(moves, null, 2));
}

const git = promisify(execFile);

/**
 * Keeps the links to a Tower skill out of the project's git status: they point into Tower's folder by absolute path and
 * must never be committed. Only the repository's local exclude file changes, never `.gitignore`.
 */
export async function excludeLinks(cwd: string, name: string, excluded: boolean): Promise<void> {
  let common: string, prefix: string;
  try {
    common = (await git('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 5_000 })).stdout.trim();
    prefix = (await git('git', ['-C', cwd, 'rev-parse', '--show-prefix'], { timeout: 5_000 })).stdout.trim();
  } catch { return; }
  // Only the repository's own exclude file, reached without any link: never a file a link leads to.
  if (!common || !isAbsolute(common) || await realpath(common).catch(() => '') !== resolve(common)) return;
  const info = join(common, 'info'), path = join(info, 'exclude');
  const folder = await lstat(info).catch(() => undefined);
  if (folder && (folder.isSymbolicLink() || !folder.isDirectory())) return;
  const file = await lstat(path).catch(() => undefined);
  if (file && (file.isSymbolicLink() || !file.isFile())) return;
  const lines = [`/${prefix}.agents/skills/${name}`, `/${prefix}.claude/skills/${name}`];
  const current = file ? await readFile(path, 'utf8') : '';
  const kept = current.split('\n').filter(line => !lines.includes(line));
  while (kept.length && !kept.at(-1)) kept.pop();
  const next = [...kept, ...(excluded ? lines : [])].join('\n');
  const text = next ? `${next}\n` : '';
  if (text === current) return;
  if (!folder) await mkdir(info);
  const temporary = `${path}.tower-${process.pid}-${Date.now()}`;
  await writeFile(temporary, text, { flag: 'wx', mode: file ? file.mode & 0o777 : 0o644 });
  await rename(temporary, path).catch(async error => { await unlink(temporary).catch(() => {}); throw error; });
}

const MAX_SKILL_FILES = 500;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;

/** A skill folder's regular files for a backup. A folder with any link inside is refused: its target would not come along. */
export async function bundleFiles(dir: string): Promise<SkillBundleFile[]> {
  const files: SkillBundleFile[] = [];
  let bytes = 0;
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw Object.assign(new Error('스킬 폴더 안에 링크가 있어 백업할 수 없습니다.'), { statusCode: 409 });
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) continue;
      const content = await readFile(path);
      bytes += content.length;
      if (files.length >= MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw Object.assign(new Error('스킬 폴더가 너무 커서 백업할 수 없습니다.'), { statusCode: 413 });
      files.push({ path: relative(dir, path).split(sep).join('/'), mode: (await lstat(path)).mode & 0o777, base64: content.toString('base64') });
    }
  };
  await walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Whether a folder has a link anywhere inside it. */
export async function containsLink(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && await containsLink(join(dir, entry.name))) return true;
  }
  return false;
}

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/** Checks a backup file from outside before anything of it is used: its shape, names, paths and sizes. */
export function parseBundle(value: unknown): SkillBundle {
  if (!value || typeof value !== 'object') throw bad('백업 파일 형식이 올바르지 않습니다.');
  const input = value as Record<string, unknown>;
  if (input.format !== SKILL_BUNDLE_FORMAT || input.version !== 1 || !Array.isArray(input.skills)) throw bad('Tower 스킬 백업 파일이 아닙니다.');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SKILL_BUNDLE_BYTES + 1024) throw Object.assign(new Error('백업 파일이 너무 큽니다.'), { statusCode: 413 });
  const text = (item: unknown, max: number) => typeof item === 'string' ? item.slice(0, max) : '';
  const skills = input.skills.map(raw => {
    const skill = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const name = text(skill.name, 64);
    if (!SKILL_NAME.test(name)) throw bad('백업 안의 스킬 이름이 올바르지 않습니다.');
    const scope = skill.scope === 'project' ? 'project' as const : 'global' as const;
    const project = skill.project && typeof skill.project === 'object' ? skill.project as Record<string, unknown> : undefined;
    if (scope === 'project' && (typeof project?.cwd !== 'string' || !isAbsolute(project.cwd))) throw bad('백업 안의 프로젝트 스킬에 폴더가 없습니다.');
    if (!Array.isArray(skill.files) || skill.files.length > MAX_SKILL_FILES) throw bad('백업 안의 스킬 파일 목록이 올바르지 않습니다.');
    const seen = new Set<string>();
    const files = skill.files.map(file => {
      const entry = file && typeof file === 'object' ? file as Record<string, unknown> : {};
      const path = typeof entry.path === 'string' ? entry.path : '';
      const parts = path.split('/');
      if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || normalize(path) !== path.split('/').join(sep)
        || parts.some(part => !part || part === '.' || part === '..') || seen.has(path)) throw bad('백업 안의 파일 경로가 올바르지 않습니다.');
      seen.add(path);
      if (typeof entry.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64)) throw bad('백업 안의 파일 내용이 올바르지 않습니다.');
      return { path, mode: Number.isInteger(entry.mode) ? (entry.mode as number) & 0o755 | 0o600 : 0o644, base64: entry.base64 };
    });
    if (!files.some(file => file.path === 'SKILL.md')) throw bad('백업 안의 스킬에 SKILL.md가 없습니다.');
    return { name, description: text(skill.description, 1024), scope, ...(scope === 'project' ? { project: { cwd: resolve(project!.cwd as string), title: text(project!.title, 200) } } : {}),
      pinned: skill.pinned === true, files };
  });
  const keys = skills.map(skill => `${skill.scope}\0${skill.project?.cwd ?? ''}\0${skill.name}`);
  if (new Set(keys).size !== keys.length) throw bad('백업 안에 같은 스킬이 두 번 들어 있습니다.');
  return { format: SKILL_BUNDLE_FORMAT, version: 1, exportedAt: text(input.exportedAt, 40), from: text(input.from, 200),
    ...(typeof input.guidance === 'string' ? { guidance: input.guidance.slice(0, 256 * 1024) } : {}), skills };
}

/** Writes a bundled skill's files into a new folder that must not exist yet. */
export async function writeBundleFiles(dir: string, files: SkillBundleFile[]): Promise<void> {
  await mkdir(dir);
  for (const file of files) {
    const path = join(dir, ...file.path.split('/'));
    if (!resolve(path).startsWith(resolve(dir) + sep)) throw bad('백업 안의 파일 경로가 올바르지 않습니다.');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, Buffer.from(file.base64, 'base64'), { flag: 'wx', mode: file.mode });
  }
}
