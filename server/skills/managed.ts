import { isAbsolute, join } from 'node:path';
import type { SkillBundleFile } from '../../shared/skills.js';
import { MAX_SKILL_TARGETS, SKILL_BUNDLE_FORMAT, SKILL_NAME } from '../../shared/skills.js';
import { TowerError } from '../../shared/errors.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { bundleFiles, parseBundle } from './store.js';
import { DEFAULT_SKILLS } from './defaults.js';
import { formatSkillFile } from './skill-file.js';

/**
 * The Tower skills and owner guidance of the Tower this computer follows ("호스트 설정 따르기"), as that Tower sends
 * them. A skill's projects travel as repository addresses (`normalizeRemoteUrl`): the computer links it into its own
 * folders of the same repositories.
 */
export interface ManagedSkills {
  skills: ManagedSkill[];
  /** The owner's guidance, empty included. */
  guidance: string;
  /**
   * Default skills the followed Tower keeps as Tower seeded them, by name only: every Tower seeds its own, so they are
   * not sent. A copy taken over from it before goes back to being this computer's own default.
   */
  defaults: string[];
}
export interface ManagedSkill { name: string; pinned: boolean; files: SkillBundleFile[]; targets: { all: boolean; repositories: string[] } }

const MAX_SKILLS = 500;
/** A repository address as `normalizeRemoteUrl` names one: `host/owner/repo`. */
const repositoryName = (value: unknown) => typeof value === 'string' && value.length <= 2048 && /^[a-z0-9.-]+(\/[^/\s]+){2,}$/.test(value) && !value.split('/').some(part => part === '.' || part === '..');
const bad = (message: string) => new TowerError('invalid', message);

/** Checks what the followed Tower sent before anything of it is used, with the same limits as a skill backup. */
export function parseManagedSkills(value: unknown): ManagedSkills {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!input || !Array.isArray(input.skills) || input.skills.length > MAX_SKILLS || typeof input.guidance !== 'string') throw bad('호스트의 스킬 설정 형식이 올바르지 않습니다.');
  const raw = input.skills.map(item => item && typeof item === 'object' ? item as Record<string, unknown> : {});
  const bundle = parseBundle({ format: SKILL_BUNDLE_FORMAT, version: 1, exportedAt: '', from: '', guidance: input.guidance,
    skills: raw.map(item => ({ name: item.name, description: '', scope: 'global', pinned: item.pinned === true, files: item.files })) });
  const skills = bundle.skills.map((skill, index) => {
    const targets = raw[index]!.targets as { all?: unknown; repositories?: unknown } | undefined;
    if (!targets || typeof targets.all !== 'boolean' || !Array.isArray(targets.repositories) || targets.repositories.length > MAX_SKILL_TARGETS
      || targets.repositories.some(url => !repositoryName(url))) throw bad('호스트 스킬의 적용 저장소가 올바르지 않습니다.');
    return { name: skill.name, pinned: skill.pinned, files: skill.files, targets: { all: targets.all, repositories: targets.all ? [] : [...new Set(targets.repositories as string[])] } };
  });
  const defaults = Array.isArray(input.defaults) ? input.defaults.filter((name): name is string => typeof name === 'string' && SKILL_NAME.test(name)).slice(0, MAX_SKILLS) : [];
  return { skills, guidance: bundle.guidance ?? '', defaults };
}

/**
 * What this computer's web hands its worker to apply: the section the followed Tower sent, and this computer's project
 * folders with the repositories they are clones of, as the web knows them right now (a folder cloned a moment ago
 * included), by repository.
 */
export function parseManagedApply(value: unknown): { section: ManagedSkills; folders: Map<string, string[]> } {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (!Array.isArray(input.folders)) throw bad('이 컴퓨터의 폴더 목록이 없습니다.');
  const folders = new Map<string, string[]>();
  for (const item of input.folders.slice(0, 2000)) {
    const folder = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (typeof folder.cwd !== 'string' || !isAbsolute(folder.cwd) || !repositoryName(folder.remoteUrl)) continue;
    folders.set(folder.remoteUrl as string, [...folders.get(folder.remoteUrl as string) ?? [], folder.cwd]);
  }
  return { section: parseManagedSkills(input.section), folders };
}

/**
 * The stored skills that came from the followed Tower, by folder, in `<state>/skills-managed.json`: only these are
 * ever replaced or removed by it. A file that cannot be read counts as none, so a skill is never taken from this
 * computer's owner by mistake; the followed Tower's skills then stay and are reported until the owner sorts them out.
 */
export class ManagedSkillList {
  private readonly path: string;
  constructor(stateDir: string) { this.path = join(stateDir, 'skills-managed.json'); }

  async read(): Promise<string[]> {
    try {
      const saved = await readPrivateJson(this.path, 1_000_000) as { dirs?: unknown } | null;
      if (Array.isArray(saved?.dirs)) return saved.dirs.filter((dir): dir is string => typeof dir === 'string');
      console.error('The list of skills from the followed Tower is invalid; none is counted as its.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`The list of skills from the followed Tower could not be read; none is counted as its: ${error instanceof Error ? error.message : String(error)}`);
    }
    return [];
  }

  async write(dirs: string[]): Promise<void> { await writePrivateJson(this.path, `${JSON.stringify({ dirs }, null, 2)}\n`); }
}

/** Whether a skill folder holds exactly these files: the same paths, contents and executable bits. */
export async function sameFiles(dir: string, files: SkillBundleFile[]): Promise<boolean> {
  // best-effort: a folder that cannot be read (or holds a link) is not the same, and is written again.
  const current = await bundleFiles(dir).catch(() => undefined);
  const key = (list: SkillBundleFile[]) => JSON.stringify(list.map(file => [file.path, file.base64, file.mode & 0o100]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  return Boolean(current) && key(current!) === key(files);
}

/** A default skill's files exactly as Tower writes them when it seeds one (`SkillService.seed`, through SkillFiles). */
export function defaultFiles(name: string): SkillBundleFile[] | undefined {
  const skill = DEFAULT_SKILLS.find(item => item.name === name);
  if (!skill) return undefined;
  const text = formatSkillFile({ name: skill.name, description: skill.description.trim().replace(/\s*\n\s*/g, ' '), body: skill.body });
  return [{ path: 'SKILL.md', mode: 0o644, base64: Buffer.from(text).toString('base64') }];
}

/** Whether a skill folder holds a default skill exactly as Tower seeds it. */
export async function defaultContent(dir: string, name: string): Promise<boolean> {
  const files = defaultFiles(name);
  return Boolean(files) && sameFiles(dir, files!);
}
