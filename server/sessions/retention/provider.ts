import { lstat, realpath, rename, link, unlink, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { channel } from 'node:diagnostics_channel';
import type { Provider } from '../../../shared/types.js';
import type { RetentionRecord } from './policy.js';
import type { RetentionAdapter, RetentionMember, RetentionOperationContext, RetentionSourceFile } from './types.js';
import { privateDirectory, validateOperationId } from './store.js';
import { CodexMaintenanceClient, type CodexMaintenance } from './codex-maintenance.js';
import { inspectNativeRetention, type NativeInspection } from './native-inspection.js';

export interface NativeRetentionOptions {
  coldRoot: string; codexHome: string; claudeHome: string; codexExecutable?: string;
  inspect?: () => Promise<NativeInspection>;
  codexClient?: () => CodexMaintenance;
}
function within(root: string, path: string): boolean { const child = relative(resolve(root), path); return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); }
function identity(info: Awaited<ReturnType<typeof lstat>>): RetentionMember['identity'] { return { dev: Number(info.dev), ino: Number(info.ino), size: Number(info.size), mtimeMs: Number(info.mtimeMs) }; }
function same(a: RetentionMember['identity'], b: RetentionMember['identity']): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function sync(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function safeFile(path: string, roots: readonly string[]): Promise<RetentionMember['identity']> {
  if (!isAbsolute(path)) throw new Error('Transcript must be absolute.');
  const root = roots.find(value => within(value, path)); if (!root) throw new Error('Transcript outside native roots.');
  const [rootReal, pathReal, info] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
  if (rootReal !== resolve(root) || pathReal !== path || !info.isFile()) throw new Error('Unsafe transcript identity.');
  return identity(info);
}
function codexRows(home: string, ids: readonly string[]): Map<string, { path: string; archived: boolean }> {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  channel('tower.retention.codex-metadata-open').publish({ database: 'state_5.sqlite' });
  try { const query = db.prepare('SELECT id, rollout_path, archived FROM threads WHERE id = ?'); const rows = new Map<string, { path: string; archived: boolean }>();
    for (const id of ids) { const row = query.get(id); if (row && typeof row.rollout_path === 'string') rows.set(id, { path: row.rollout_path, archived: row.archived === 1 }); } return rows;
  } finally { db.close(); }
}
function codexSubtree(home: string, root: string): string[] {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  try { const ids = new Set<string>(); const pending = [root]; const query = db.prepare('SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?');
    while (pending.length) { const id = pending.pop()!; if (ids.has(id)) continue; ids.add(id); if (ids.size > 1000) throw new Error('Native subtree exceeds retention budget.'); for (const row of query.all(id)) if (typeof row.child_thread_id === 'string') pending.push(row.child_thread_id); } return [...ids];
  } finally { db.close(); }
}

/** Originals remain in provider archive or managed cold storage; no thread/delete. */
export function createNativeRetentionAdapter(roots: Record<Provider, readonly string[]>, options?: NativeRetentionOptions): RetentionAdapter {
  const client = () => options!.codexClient?.() || new CodexMaintenanceClient(options!.codexExecutable || 'codex', options!.codexHome);
  const inspect = () => options!.inspect?.() || inspectNativeRetention(options!.claudeHome, { ...roots, codex: [...roots.codex, join(options!.codexHome, 'thread-writer-locks')] });
  const configured = () => { if (!options) throw new Error('Native retention configuration unavailable.'); };
  async function protectedNow(records: RetentionRecord[], context: RetentionOperationContext): Promise<boolean> {
    const fresh = await context.fresh(); const processes = await inspect(); if (!fresh.complete || !processes.complete) throw new Error('Fresh native retention inspection incomplete.');
    const current = new Map(fresh.records.map(record => [record.session.id, record]));
    for (const record of records) { let id: string | undefined = record.session.id; const seen = new Set<string>();
      while (id) { if (seen.has(id)) return true; seen.add(id); const native = current.get(id)?.session || (id === record.session.id ? record.session : undefined); if (fresh.protectedIds.has(id) || fresh.blockedIds?.has(id) || processes.activeIds.has(id) || (native && processes.activeIds.has(`${native.provider}:${native.nativeId}`))) return true;
        id = record.session.provider === 'claude' ? (current.get(id)?.session.parentId || (id === record.session.id ? record.session.parentId : undefined)) : undefined;
      }
    } return false;
  }
  async function coldInspection(input: RetentionMember[]): Promise<{ complete: boolean; members: RetentionMember[]; issues: string[] }> {
    configured(); const members: RetentionMember[] = []; const issues: string[] = [];
    if (input.length > 20_000) return { complete: false, members: structuredClone(input), issues: ['Native cold inspection exceeds member budget.'] };
    const processes = await inspect();
    if (!processes.complete) return { complete: false, members: structuredClone(input), issues: processes.issues.length ? [...processes.issues] : ['Native cold inspection incomplete.'] };
    const codexIds = [...new Set(input.filter(member => member.provider === 'codex' && member.state !== 'restored').map(member => member.nativeId))];
    let metadata = new Map<string, { path: string; archived: boolean }>();
    try { if (codexIds.length) metadata = codexRows(options!.codexHome, codexIds); }
    catch { return { complete: false, members: structuredClone(input), issues: ['Native cold metadata inspection failed.'] }; }
    for (const saved of input) { const member = structuredClone(saved); if (member.state === 'restored') { members.push(member); continue; }
      try {
        if (member.provider === 'codex') {
          const row = metadata.get(member.nativeId); if (!row) throw new Error('Native archived metadata missing.');
          if (row.archived && roots.codex.some(root => basename(root) === 'archived_sessions' && within(root, row.path))) { member.coldPath = row.path; const observed = await safeFile(row.path, roots.codex); if ((processes.activeIds.has(member.sessionId) || processes.activeIds.has(`${member.provider}:${member.nativeId}`)) || !same(observed, member.identity)) { member.state = 'conflict'; member.error = 'Archived original changed; latest original preserved.'; } else { member.state = 'cold'; delete member.error; } }
          else if (!row.archived && roots.codex.some(root => basename(root) === 'sessions' && within(root, row.path))) { member.state = 'restored'; delete member.error; }
          else throw new Error('Unexpected native archived path.');
        } else {
          if (!member.coldPath || !within(options!.coldRoot, member.coldPath)) throw new Error('Invalid managed cold path.');
          const hot = await exists(member.originalPath); const cold = await exists(member.coldPath);
          if (hot && !cold) { member.state = 'restored'; delete member.error; }
          else if (cold) { const observed = await safeFile(member.coldPath, [options!.coldRoot]);
            if (hot || (processes.activeIds.has(member.sessionId) || processes.activeIds.has(`${member.provider}:${member.nativeId}`)) || !same(observed, member.identity)) { member.state = 'conflict'; member.error = 'New hot source or changed cold original preserved.'; }
            else { member.state = 'cold'; delete member.error; }
          } else throw new Error('Native source and managed cold original missing.');
          for (const sidecar of member.sidecars || []) {
            const source = await exists(sidecar.originalPath); const savedCold = await exists(sidecar.coldPath);
            if ((member.state === 'restored' && savedCold) || (member.state === 'cold' && (!savedCold || source || !same(sidecar.identity, await safeFile(sidecar.coldPath, [options!.coldRoot]))))) { member.state = 'conflict'; member.error = 'Sidecar move incomplete or changed; both originals preserved.'; }
          }
        }
      } catch (error) { issues.push(`${member.sessionId}: ${error instanceof Error ? error.message : 'Cold inspection failed.'}`); }
      members.push(member);
    } return { complete: !issues.length, members, issues };
  }
  return {
    capability: () => options ? { status: 'supported' } : { status: 'blocked', reason: 'Native retention configuration unavailable.' },
    async reserve(candidate, records, context) {
      configured(); if (!context?.fresh || !context.commitMember) throw new Error('Retention admission context required.'); validateOperationId(context.operationId);
      if (candidate.ids.length !== records.length || records.some(record => !candidate.ids.includes(record.session.id))) throw new Error('Retention membership mismatch.');
      if (await protectedNow(records, context)) return undefined;
      for (const record of records.filter(value => value.session.provider === 'codex')) {
        const expanded = codexSubtree(options!.codexHome, record.session.nativeId);
        const allowed = new Set(records.filter(value => value.session.provider === 'codex').map(value => value.session.nativeId));
        const extras = expanded.filter(id => !allowed.has(id));
        if (extras.length) {
          const managed = new Map(context.managedCold().filter(member => member.provider === 'codex' && member.state === 'cold').map(member => [member.nativeId, member]));
          const fresh = await context.fresh(); const processes = await inspect(); if (!fresh.complete || !processes.complete) throw new Error('Fresh native subtree inspection incomplete.');
          const rows = codexRows(options!.codexHome, extras);
          const managedBySession = new Map([...managed.values()].map(member => [member.sessionId, member]));
          const reservedRoots = new Set(records.map(value => value.session.id));
          const coveredByAdmission = (member: RetentionMember): boolean => {
            const seen = new Set<string>(); let parent = member.parentId;
            while (parent && !reservedRoots.has(parent)) { if (seen.has(parent)) return false; seen.add(parent); parent = managedBySession.get(parent)?.parentId; }
            return Boolean(parent && reservedRoots.has(parent));
          };
          for (const id of extras) {
            const member = managed.get(id), row = rows.get(id);
            if (!member || !coveredByAdmission(member)) return undefined;
            if (!member || !row?.archived || row.path !== member.coldPath || fresh.protectedIds.has(member.sessionId) || fresh.protectedIds.has(`codex:${id}`) || processes.activeIds.has(member.sessionId) || processes.activeIds.has(`codex:${id}`)) return undefined;
            if (!roots.codex.some(root => basename(root) === 'archived_sessions' && within(root, row.path)) || !same(member.identity, await safeFile(row.path, roots.codex))) return undefined;
          }
        }
      }
      const planned: RetentionMember[] = [];
      for (const { session } of records) {
        if (!session.filePath || !/^[A-Za-z0-9_-]+$/.test(session.nativeId)) throw new Error('Native transcript identity missing.');
        const member: RetentionMember = { sessionId: session.id, nativeId: session.nativeId, provider: session.provider, parentId: session.parentId, originalPath: session.filePath,
          coldPath: session.provider === 'claude' ? join(resolve(options!.coldRoot), context.operationId, 'claude', session.nativeId, basename(session.filePath)) : join(options!.codexHome, 'archived_sessions', basename(session.filePath)),
          operationId: context.operationId, state: 'intent', identity: await safeFile(session.filePath, roots[session.provider]) };
        if (session.provider === 'claude') { const sidecar = session.filePath.replace(/\.jsonl$/, '.meta.json'); if (await exists(sidecar)) member.sidecars = [{ originalPath: sidecar, coldPath: join(dirname(member.coldPath!), basename(sidecar)), identity: await safeFile(sidecar, roots.claude) }]; }
        planned.push(member);
      }
      let maintenance: CodexMaintenance | undefined;
      const revalidate = async () => !await protectedNow(records, context) && (await Promise.all(planned.filter(member => member.state === 'intent').map(async member => same(member.identity, await safeFile(member.originalPath, roots[member.provider]))))).every(Boolean);
      return {
        revalidate,
        async preserveOwnership() { if (!await revalidate()) throw new Error('Native retention preconditions changed.'); },
        async moveCold() {
          if (!await revalidate()) throw new Error('Native retention preconditions changed.'); for (const member of planned) await context.commitMember(member);
          for (const member of planned) {
            try {
              if (await protectedNow(records, context)) throw new Error('Native work resumed before cold move.');
              if (member.provider === 'codex') { const row = codexRows(options!.codexHome, [member.nativeId]).get(member.nativeId); if (!row?.archived) { maintenance ||= client(); await maintenance.archive(member.nativeId); } }
              else {
                const destination = await privateDirectory(dirname(member.coldPath!)); if ((await lstat(destination)).dev !== member.identity.dev) throw new Error('Cold move requires the same filesystem.');
                for (const file of [...member.sidecars || [], { originalPath: member.originalPath, coldPath: member.coldPath!, identity: member.identity }]) {
                  if (await exists(file.coldPath)) throw new Error('Cold destination already exists.'); if (!same(await safeFile(file.originalPath, roots.claude), file.identity)) throw new Error('Native source changed before cold move.');
                  await rename(file.originalPath, file.coldPath); await sync(dirname(file.originalPath)); await sync(destination);
                }
              }
              const observed = await coldInspection([member]); if (!observed.complete || observed.members[0]!.state !== 'cold') throw new Error(observed.issues.join('; ') || 'Native cold move conflicted.'); Object.assign(member, observed.members[0]);
            } catch (error) { member.state = 'conflict'; member.error = error instanceof Error ? error.message : 'Native cold move failed.'; }
            await context.commitMember(member);
          } return structuredClone(planned);
        },
        async sources(members): Promise<RetentionSourceFile[]> {
          const files: RetentionSourceFile[] = [];
          for (const member of members.filter(value => value.state === 'cold')) {
            for (const file of [{ originalPath: member.originalPath, coldPath: member.coldPath! }, ...member.sidecars || []]) {
              await safeFile(file.coldPath, member.provider === 'claude' ? [options!.coldRoot] : roots.codex); const root = roots[member.provider].find(value => within(value, file.originalPath)); if (!root) throw new Error('Original native root missing.');
              files.push({ path: file.coldPath, originalPath: file.originalPath, root, nativeId: member.nativeId, provider: member.provider, provenance: member.provider === 'codex' ? 'native-archive' : 'cold-original' });
            }
          } return files;
        },
        async release() { await maintenance?.close(); },
      };
    },
    async files(records) { const files = new Map<string, RetentionSourceFile>(); for (const { session } of records) { if (!session.filePath) throw new Error('Native transcript path missing.'); await safeFile(session.filePath, roots[session.provider]); const root = roots[session.provider].find(value => within(value, session.filePath!))!; const prior = files.get(session.filePath); if (prior && (prior.nativeId !== session.nativeId || prior.provider !== session.provider)) throw new Error('Conflicting transcript identity.'); files.set(session.filePath, { path: session.filePath, root, nativeId: session.nativeId, provider: session.provider }); } return [...files.values()]; },
    inspectCold: coldInspection,
    async restore(_manifest, operationId, members, context) {
      configured(); validateOperationId(operationId); if (!context) throw new Error('Restore admission context required.'); const result: RetentionMember[] = []; let maintenance: CodexMaintenance | undefined;
      try {
        for (const saved of members) { const member = structuredClone(saved);
          try {
            const fresh = await context.fresh(); const processes = await inspect(); if (!fresh.complete || !processes.complete) throw new Error('Fresh restore inspection incomplete.');
            if (fresh.protectedIds.has(member.sessionId) || (processes.activeIds.has(member.sessionId) || processes.activeIds.has(`${member.provider}:${member.nativeId}`))) throw new Error('Native restore target active.');
            if (member.provider === 'claude') {
              const records = new Map(fresh.records.map(record => [record.session.id, record])); const seen = new Set<string>(); let parent = member.parentId;
              while (parent) { if (seen.has(parent) || fresh.protectedIds.has(parent) || processes.activeIds.has(parent)) throw new Error('Native parent active or unproven.'); seen.add(parent); parent = records.get(parent)?.session.parentId; }
            }
            if (member.provider === 'codex') {
              const observation = await coldInspection([member]); if (!observation.complete) throw new Error(observation.issues.join('; '));
              if (observation.members[0]!.state !== 'restored') { maintenance ||= client(); await maintenance.unarchive(member.nativeId); }
            } else {
              if (!member.coldPath || !within(options!.coldRoot, member.coldPath)) throw new Error('Invalid managed restore path.');
              const files = [{ originalPath: member.originalPath, coldPath: member.coldPath, identity: member.identity }, ...member.sidecars || []];
              // Preflight every member before publication. Partial moves can be repaired without replacing a hot source.
              for (const file of files) {
                if (!roots.claude.some(root => within(root, file.originalPath)) || !within(options!.coldRoot, file.coldPath)) throw new Error('Restore outside approved roots.');
                if (await realpath(dirname(file.originalPath)) !== dirname(file.originalPath)) throw new Error('Unsafe native restore parent.');
                const hot = await exists(file.originalPath), cold = await exists(file.coldPath);
                if (!hot && !cold) throw new Error('Restore source missing.');
                if (cold) await safeFile(file.coldPath, [options!.coldRoot]);
                if (hot) {
                  const current = await safeFile(file.originalPath, roots.claude);
                  const linked = cold && same(current, await safeFile(file.coldPath, [options!.coldRoot]));
                  if (!linked && !same(current, file.identity)) throw new Error('New hot source preserved; restore refused.');
                  if (cold && !linked) throw new Error('Conflicting hot and cold sources preserved.');
                }
              }
              for (const file of files) {
                if (!await exists(file.coldPath)) continue;
                if (!await exists(file.originalPath)) await link(file.coldPath, file.originalPath);
                else if (!same(await safeFile(file.originalPath, roots.claude), await safeFile(file.coldPath, [options!.coldRoot]))) throw new Error('Hot source appeared during restore; both copies preserved.');
                await sync(dirname(file.originalPath)); await unlink(file.coldPath); await sync(dirname(file.coldPath));
              }
            }
            const restored = await coldInspection([{ ...member, state: 'intent' }]); if (!restored.complete || restored.members[0]!.state !== 'restored') throw new Error('Native restoration not confirmed.'); member.state = 'restored'; delete member.error;
          } catch (error) { member.state = 'conflict'; member.error = error instanceof Error ? error.message : 'Native restore failed.'; }
          await context.commitMember(member); result.push(member);
        }
      } finally { await maintenance?.close(); } return result;
    },
  };
}
