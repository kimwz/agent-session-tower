import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ProjectGroup, ProjectGroupPatch } from '../shared/types.js';
import { normalizeSessionTitle } from './session-titles.js';

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

export function normalizeProjectGroupPatch(value: unknown): ProjectGroupPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('폴더 그룹 변경 형식이 올바르지 않습니다.');
  const patch = value as Record<string, unknown>;
  if (typeof patch.cwd !== 'string' || !isAbsolute(patch.cwd) || patch.cwd.length > 4096 || patch.cwd.includes('\0')) {
    throw invalid('폴더 그룹의 절대 경로가 필요합니다.');
  }
  const hasTitle = Object.hasOwn(patch, 'title');
  const hasPinned = Object.hasOwn(patch, 'pinned');
  const hasHidden = Object.hasOwn(patch, 'hidden');
  if (!hasTitle && !hasPinned && !hasHidden) throw invalid('제목, 고정 상태 또는 숨김 상태를 지정하세요.');
  if (hasPinned && typeof patch.pinned !== 'boolean') throw invalid('폴더 그룹의 고정 상태는 boolean이어야 합니다.');
  if (hasHidden && typeof patch.hidden !== 'boolean') throw invalid('폴더 그룹의 숨김 상태는 boolean이어야 합니다.');
  return {
    cwd: patch.cwd,
    ...(hasTitle ? { title: normalizeSessionTitle(patch.title) } : {}),
    ...(hasPinned ? { pinned: patch.pinned as boolean } : {}),
    ...(hasHidden ? { hidden: patch.hidden as boolean } : {}),
  };
}

/** Folder display metadata only; cwd remains the native identity, even without sessions. */
export class ProjectGroupStore {
  private readonly path: string;
  private groups = new Map<string, ProjectGroup>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly stateDir: string) { this.path = join(stateDir, 'project-groups.json'); }

  async start(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 12_000_000) throw new Error('Saved project groups are invalid or too large.');
      const saved: unknown = JSON.parse(await file.readFile('utf8'));
      if (!Array.isArray(saved)) throw new Error('Saved project groups are invalid.');
      const groups = new Map<string, ProjectGroup>();
      for (const value of saved) {
        const patch = normalizeProjectGroupPatch(value);
        if (patch.title === undefined || patch.pinned === undefined || groups.has(patch.cwd)) throw new Error('Saved project groups are invalid.');
        if (patch.title || patch.pinned || patch.hidden) groups.set(patch.cwd, {
          cwd: patch.cwd, title: patch.title, pinned: patch.pinned, ...(patch.hidden ? { hidden: true } : {}),
        });
      }
      await file.chmod(0o600);
      this.groups = groups;
    } finally { await file.close(); }
  }

  list(): ProjectGroup[] { return [...this.groups.values()].map(group => ({ ...group })); }

  set(value: ProjectGroupPatch): Promise<ProjectGroup> {
    const patch = normalizeProjectGroupPatch(value);
    const write = this.writes.then(async () => {
      // Merge against the last committed document, so concurrent partial edits retain each field.
      const prior = this.groups.get(patch.cwd) || { cwd: patch.cwd, title: '', pinned: false };
      const group: ProjectGroup = { ...prior, ...patch };
      if (!group.hidden) delete group.hidden;
      if (group.title === prior.title && group.pinned === prior.pinned && group.hidden === prior.hidden) return { ...group };
      const next = new Map(this.groups);
      if (group.title || group.pinned || group.hidden) next.set(group.cwd, group);
      else next.delete(group.cwd);
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(`${JSON.stringify([...next.values()])}\n`); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw Object.assign(new Error(`폴더 그룹을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 503 });
      }
      this.groups = next;
      return { ...group };
    });
    this.writes = write.then(() => {}, () => {});
    return write;
  }

  async flush(): Promise<void> { await this.writes; }
}
