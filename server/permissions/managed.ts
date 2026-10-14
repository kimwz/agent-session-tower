import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { MAX_RULE_LENGTH, MAX_RUN_COMMAND, normalizeCommand, ruleProblem, type PermissionRequest, type PermissionRule, type PermissionRuleInput } from '../../shared/permissions.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/**
 * The permission section of "호스트 설정 따르기" (design §2, §3.4): what a controlling Tower sends to the computers that
 * follow it, and what such a computer keeps of it. The host's rules for every project apply there as its own; its
 * project rules and approvals travel only as precedents, named by repository, never as rules.
 */

/** At most this many precedents of one repository travel, newest first. */
const PRECEDENTS_PER_REPOSITORY = 50;
/** Approvals without a rule left, per repository, newest first: reference for the reviewer only. */
const APPROVALS_PER_REPOSITORY = 20;
const MAX_REPOSITORIES = 200;

const provider = z.enum(['claude', 'codex']);
const providers = z.array(provider).min(1).max(2);
const repository = z.string().min(1).max(2048);
const time = z.string().min(1).max(40);
const reason = z.string().max(500).optional();
const ruleValue = z.string().min(1).max(MAX_RULE_LENGTH + 20);
const HostRuleSchema = z.object({ id: z.string().uuid(), kind: z.enum(['command', 'claude']), value: ruleValue, providers, source: z.enum(['owner', 'request']),
  note: z.string().max(500).optional(), createdAt: time, updatedAt: time }).strict();
const PrecedentSchema = z.object({ remoteUrl: repository, kind: z.enum(['command', 'claude']), value: ruleValue, providers, by: z.enum(['owner', 'reviewer']), reason, at: time }).strict();
const ApprovalSchema = z.object({ remoteUrl: repository, kind: z.enum(['command', 'claude', 'run']), value: z.string().min(1).max(MAX_RUN_COMMAND), by: z.enum(['owner', 'reviewer']), reason, at: time }).strict();
const sent = {
  rules: z.array(HostRuleSchema).max(200),
  precedents: z.array(PrecedentSchema).max(PRECEDENTS_PER_REPOSITORY * MAX_REPOSITORIES),
  approvals: z.array(ApprovalSchema).max(APPROVALS_PER_REPOSITORY * MAX_REPOSITORIES),
};
const HostPermissionsSchema = z.object({ ...sent, autoReview: z.object({ enabled: z.boolean(), resume: z.boolean() }).strict() }).strict();
/** The following computer's file: what it kept of the host's settings, and which host sent them. */
const KeptSchema = z.object({ ...sent, hostId: z.string().min(1).max(200) }).strict();

/** A live project rule of the host, by the repository its folder is a clone of. */
export type HostPrecedent = z.infer<typeof PrecedentSchema>;
/** An approval on the host that left no rule (a one-off run, or a rule deleted or expired since). */
export type HostApproval = z.infer<typeof ApprovalSchema>;
/** What a controlling Tower sends: its rules for every project, its reviewer setting and its precedents. */
export type HostPermissions = z.infer<typeof HostPermissionsSchema>;
/** What a following computer keeps (the reviewer setting goes into its own settings). */
export interface KeptHostPermissions { hostId: string; rules: PermissionRule[]; precedents: HostPrecedent[]; approvals: HostApproval[] }

/** Reads what a host sent; anything not in this shape is refused whole, so the computer keeps what it had. */
export function parseHostPermissions(value: unknown): HostPermissions { return checked(HostPermissionsSchema, value); }

function checked<T extends { rules: Array<z.infer<typeof HostRuleSchema>> }>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`호스트의 권한 설정 형식이 올바르지 않습니다: ${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`);
  for (const rule of parsed.data.rules) {
    const problem = ruleProblem({ ...rule, scope: 'global' });
    if (problem) throw new Error(`호스트의 권한 규칙 ${rule.value}: ${problem}`);
  }
  return parsed.data;
}

/**
 * The host's side: its rules for every project (the owner's and those approved for a request; the reviewer never
 * allows one for every project), its live project rules as precedents by repository, and approvals that left no rule.
 * A precedent is the rule a decision actually made, as narrowed then; a deleted or conversation rule is none.
 */
export async function exportHostPermissions(state: { rules: readonly PermissionRule[]; requests: readonly PermissionRequest[]; autoReview: { enabled: boolean; resume: boolean } },
  remoteUrl: (cwd: string) => Promise<string | undefined>): Promise<HostPermissions> {
  const requests = new Map(state.requests.map(request => [request.id, request]));
  const precedents: HostPrecedent[] = [];
  for (const rule of state.rules) {
    if (rule.scope !== 'project' || !rule.cwd || rule.kind === 'run') continue;
    const url = await remoteUrl(rule.cwd);
    if (!url) continue;
    const why = (rule.requestId ? requests.get(rule.requestId)?.reason : undefined) ?? rule.note;
    precedents.push({ remoteUrl: url, kind: rule.kind, value: rule.value, providers: [...rule.providers], by: rule.source === 'auto' ? 'reviewer' : 'owner', ...(why ? { reason: why.slice(0, 500) } : {}), at: rule.updatedAt });
  }
  const live = new Set(state.rules.map(rule => rule.id));
  const approvals: HostApproval[] = [];
  for (const request of state.requests) {
    if (request.status !== 'approved' || (request.rule.kind !== 'run' && request.ruleId && live.has(request.ruleId))) continue;
    const url = await remoteUrl(request.cwd);
    if (url) approvals.push({ remoteUrl: url, kind: request.rule.kind, value: request.rule.value, by: request.decidedBy === 'auto' ? 'reviewer' : 'owner', reason: request.reason.slice(0, 500), at: request.decidedAt ?? request.createdAt });
  }
  return {
    rules: state.rules.filter(rule => rule.scope === 'global' && rule.kind !== 'run' && rule.source !== 'auto').map(rule => ({ id: rule.id, kind: rule.kind as 'command' | 'claude', value: rule.value,
      providers: [...rule.providers], source: rule.source as 'owner' | 'request', ...(rule.note ? { note: rule.note } : {}), createdAt: rule.createdAt, updatedAt: rule.updatedAt })),
    autoReview: { enabled: state.autoReview.enabled, resume: state.autoReview.resume },
    precedents: newestPerRepository(precedents, PRECEDENTS_PER_REPOSITORY),
    approvals: newestPerRepository(approvals, APPROVALS_PER_REPOSITORY),
  };
}

/** Newest first, at most `limit` of each repository, of the most recently active repositories. */
function newestPerRepository<T extends { remoteUrl: string; at: string; value: string }>(items: T[], limit: number): T[] {
  const counts = new Map<string, number>();
  return [...items].sort((a, b) => b.at.localeCompare(a.at) || a.remoteUrl.localeCompare(b.remoteUrl) || a.value.localeCompare(b.value)).filter(item => {
    const count = counts.get(item.remoteUrl);
    if (count === undefined && counts.size >= MAX_REPOSITORIES) return false;
    counts.set(item.remoteUrl, (count ?? 0) + 1);
    return (count ?? 0) < limit;
  });
}

/** The host's precedent that allows exactly `rule` in this repository, for every agent asked. */
export function matchingPrecedent(kept: KeptHostPermissions, remoteUrl: string, rule: Pick<PermissionRuleInput, 'kind' | 'value' | 'providers'>): HostPrecedent | undefined {
  const same = (value: string) => rule.kind === 'command' ? normalizeCommand(value) === normalizeCommand(rule.value) : value.trim() === rule.value.trim();
  return kept.precedents.find(item => item.remoteUrl === remoteUrl && item.kind === rule.kind && same(item.value) && rule.providers.every(name => item.providers.includes(name)));
}

/**
 * The following computer's copy, in a private file of its own beside the permission SQL store (which stays this
 * computer's alone: backups, restores and its own rules never see the host's). Replaced whole on every apply.
 */
export class HostPermissionFile {
  private readonly path: string;
  constructor(stateDir: string) { this.path = join(stateDir, 'managed', 'permissions.json'); }

  /** The copy last applied; none when nothing was ever applied. One that cannot be read is reported and replaced by the next apply. */
  async load(): Promise<KeptHostPermissions | undefined> {
    let saved: unknown;
    try { saved = await readPrivateJson(this.path, 8_000_000); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      console.error(`The host's permission settings could not be read; they apply again with the next sync: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    try {
      const parsed = checked(KeptSchema, saved);
      return keepHostPermissions(parsed.hostId, parsed);
    } catch (error) {
      console.error(`The host's permission settings could not be read; they apply again with the next sync: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Writes `next` unless it is what the file holds already; answers whether anything changed. */
  async save(current: KeptHostPermissions | undefined, next: KeptHostPermissions): Promise<boolean> {
    if (current && stored(current) === stored(next)) return false;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writePrivateJson(this.path, stored(next));
    return true;
  }
}

/** The host's settings as this computer keeps them: its rules for every project, marked as the host's. */
export function keepHostPermissions(hostId: string, received: Pick<HostPermissions, 'rules' | 'precedents' | 'approvals'>): KeptHostPermissions {
  return { hostId, rules: received.rules.map(rule => ({ ...rule, scope: 'global' as const, host: true as const })), precedents: received.precedents, approvals: received.approvals };
}

const storedRules = (rules: readonly PermissionRule[]) => rules.map(rule => ({ id: rule.id, kind: rule.kind, value: rule.value, providers: rule.providers, source: rule.source,
  ...(rule.note ? { note: rule.note } : {}), createdAt: rule.createdAt, updatedAt: rule.updatedAt }));

/** The file's text: the same settings always give the same text, so an unchanged apply writes nothing. */
function stored(value: KeptHostPermissions): string {
  return JSON.stringify({ hostId: value.hostId, rules: storedRules(value.rules),
    precedents: value.precedents.map(item => ({ remoteUrl: item.remoteUrl, kind: item.kind, value: item.value, providers: item.providers, by: item.by, ...(item.reason ? { reason: item.reason } : {}), at: item.at })),
    approvals: value.approvals.map(item => ({ remoteUrl: item.remoteUrl, kind: item.kind, value: item.value, by: item.by, ...(item.reason ? { reason: item.reason } : {}), at: item.at })) });
}
