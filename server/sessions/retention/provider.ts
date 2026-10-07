import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Provider } from '../../../shared/types.js';
import type { RetentionRecord } from './policy.js';
import type { RetentionAdapter, RetentionCapability, RetentionSourceFile } from './types.js';

const BLOCKED_REASONS: Record<Provider, string> = {
  claude: 'Claude does not expose a verified per-session writer reservation and cold-transfer/restore contract. Completed subagents can resume while their native parent remains open; moving a transcript after a process snapshot cannot prevent that race.',
  codex: 'Codex thread/delete has no expected revision or backup lease handoff, may shut down a loaded ordinary thread, and deletes its spawned subtree. Native deletion alone does not guarantee that a verified backup contains the latest history and every deleted descendant.',
};

export class RetentionProviderBlockedError extends Error {
  readonly code = 'blocked-provider';
  constructor(readonly provider: Provider) {
    super(BLOCKED_REASONS[provider]);
    this.name = 'RetentionProviderBlockedError';
  }
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/**
 * Native safety gates are intentionally separate from file discovery. A successful
 * backup or an idle process snapshot must never grant permission to remove records.
 * See Codex thread_delete/thread_processor and Claude's documented subagent resume.
 */
export function createNativeRetentionAdapter(roots: Record<Provider, readonly string[]>): RetentionAdapter {
  const capability = (provider: Provider): RetentionCapability => ({ status: 'blocked', reason: BLOCKED_REASONS[provider] });
  return {
    capability,
    async reserve(candidate, records) {
      const member = records.find(record => candidate.ids.includes(record.session.id));
      if (!member) throw new Error('Retention candidate has no source records');
      throw new RetentionProviderBlockedError(member.session.provider);
    },
    async files(records: RetentionRecord[]): Promise<RetentionSourceFile[]> {
      const files = new Map<string, RetentionSourceFile>();
      for (const { session } of records) {
        const path = session.filePath;
        if (!path || !isAbsolute(path)) throw new Error(`Missing absolute transcript path for ${session.id}`);
        const candidates = roots[session.provider].map(root => resolve(root));
        const root = candidates.find(candidate => within(candidate, path));
        if (!root) throw new Error(`Transcript outside native roots for ${session.id}`);
        // A realpath mismatch also detects symlinked ancestors, not only leaf links.
        const [rootReal, pathReal, stat] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
        if (rootReal !== root || pathReal !== path || !stat.isFile() || !within(rootReal, pathReal)) {
          throw new Error(`Unsafe transcript path for ${session.id}`);
        }
        const previous = files.get(path);
        if (previous && (previous.nativeId !== session.nativeId || previous.provider !== session.provider)) {
          throw new Error(`Conflicting transcript identity for ${session.id}`);
        }
        files.set(path, { path, root, nativeId: session.nativeId, provider: session.provider });
      }
      return [...files.values()];
    },
    async restore(manifest) {
      const member = manifest.sessions[0];
      if (!member) throw new Error('Retention manifest has no sessions');
      throw new RetentionProviderBlockedError(member.provider);
    },
  };
}
