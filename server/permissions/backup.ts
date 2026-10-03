/** What a backup keeps of `permissions.json`, and how a restored one merges with this computer's. */
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The rules and the reviewer's settings; requests and the Codex files Tower wrote belong to this computer. */
export function permissionsBackupOf(saved: Record<string, unknown>): Record<string, unknown> {
  return { rules: Array.isArray(saved.rules) ? saved.rules : [], ...(record(saved.autoReview) ? { autoReview: saved.autoReview } : {}) };
}

/**
 * The backup's rules and reviewer settings over this computer's requests (pending approvals and their notices
 * included), Codex files and lost note. Undefined when the backup's part is not valid.
 */
export function mergePermissions(incoming: unknown, existing: unknown): Record<string, unknown> | undefined {
  if (!record(incoming) || !Array.isArray(incoming.rules)) return undefined;
  const kept = record(existing) ? existing : {};
  return { version: 1, requests: Array.isArray(kept.requests) ? kept.requests : [], codex: Array.isArray(kept.codex) ? kept.codex : [], ...(typeof kept.lost === 'string' ? { lost: kept.lost } : {}),
    rules: incoming.rules, ...(record(incoming.autoReview) ? { autoReview: incoming.autoReview } : {}) };
}
