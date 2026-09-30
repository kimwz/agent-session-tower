import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUTO_REVIEW_MODELS, CONVERSATION_RULE_HOURS, DEFAULT_AUTO_REVIEW, MAX_RUN_COMMAND, MAX_RUN_SECONDS, autoReviewBlock, waitingForOwner, claudeRule, codexRule, normalizeCommand, ruleGuards, ruleIsNarrower, rulesOverlap, ruleProblem, sameRule,
  type PermissionAutoReview, type PermissionOverview, type PermissionProvider, type PermissionRequest, type PermissionReview, type PermissionReviewVerdict,
  type PermissionRule, type PermissionRuleInput, type PermissionRun, type PermissionRunOutput, type PermissionTarget,
} from '../../shared/permissions.js';
import type { Provider } from '../../shared/types.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { codexRulesPath, realLocation, syncCodex } from './native.js';

/** What Tower keeps about permission rules, in `<state>/permissions.json`. */
export interface PermissionState {
  version: 1;
  rules: PermissionRule[];
  requests: PermissionRequest[];
  /** Codex rules files Tower wrote, so a file whose last rule was deleted is removed too. */
  codex: CodexFile[];
  /** Set when an earlier record could not be read: Codex rules files Tower wrote before may still be in place. */
  lost?: string;
  autoReview?: PermissionAutoReview;
}

interface CodexFile { path: string; scope: PermissionRule['scope']; cwd?: string }

/** Few enough that the settings a Claude turn receives stay far below a command-line argument's limit. */
export const MAX_RULES = 200;
export const MAX_PENDING = 50;
const MAX_DECIDED = 200;
const DECIDED_DAYS = 30;
const MAX_BYTES = 4_000_000;

const failure = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const empty = (): PermissionState => ({ version: 1, rules: [], requests: [], codex: [] });
/** A conversation the reviewer sent back for a narrower request this often in a day hears from the owner next. */
const MAX_NARROW = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The reviewer's answer, as Tower's reviewer hands it over. */
export interface PermissionReviewResult {
  verdict: PermissionReviewVerdict;
  /** For an allowed rule: this conversation only (Claude), or the project. */
  scope?: 'conversation' | 'project';
  rule?: { kind: PermissionRuleInput['kind']; value: string; providers?: PermissionProvider[] } | null;
  suggestion?: string | null;
  reason: string;
  model?: string;
}
/** What the requesting conversation is told after a review, when anything. */
export interface PermissionReviewOutcome { request: PermissionRequest; message?: string }

export interface PermissionCaller { kind: string; sessionId?: string; runId?: string; controllerId?: string }
export interface PermissionServiceOptions {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  /** The folder and provider of a Tower session. */
  session(id: string): { cwd: string; provider: Provider } | undefined;
  /**
   * Whether this Tower writes the Codex rules file for every project. Only the Tower on the default state folder does:
   * another (a development or test Tower) would replace that Tower's rules.
   */
  globalCodex?: boolean;
  /** Sends the owner's decision to the requesting conversation as the owner's next message. */
  resume?(sessionId: string, prompt: string): Promise<void>;
  /** Why the reviewer may not decide requests from this conversation (a public agent's, for one); undefined when it may. */
  autoReviewSkip?(request: PermissionRequest): string | undefined;
  /** A request is waiting for Tower's reviewer. */
  onReviewQueued?(): void;
  /** The owner changed the reviewer's setting. */
  onAutoReviewChange?(settings: PermissionAutoReview): void;
  /** A run request was allowed: run its command now. */
  startRun?(request: PermissionRequest): void;
  /** A run finished (done or failed). */
  onRunFinished?(request: PermissionRequest): void;
  /** A run's whole output, kept apart from this record. */
  runOutput?(id: string): Promise<PermissionRunOutput | undefined>;
  /** A run request left the record: its output goes too. */
  forgetRun?(id: string): Promise<void>;
  now?: () => Date;
}

/**
 * The owner's allow rules for Claude Code and Codex in one list, and the requests agents send for rules they need.
 * Only the owner saves rules or decides requests. Claude Code receives the rules as settings of the turns Tower starts
 * (users' own settings files are never rewritten); Codex reads them from rules files only Tower writes.
 */
export class PermissionService {
  private state: PermissionState = empty();
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  private errors = new Map<string, string>();
  private closed = false;

  constructor(private readonly options: PermissionServiceOptions) { this.path = join(options.stateDir, 'permissions.json'); }

  async start(): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    try { this.state = normalize(await readPrivateJson(this.path, MAX_BYTES)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A file this build cannot read is kept aside, never overwritten. The files it wrote keep their rules.
        const aside = `${this.path}.unreadable-${Date.now()}`;
        await rename(this.path, aside).catch(() => {});
        console.error(`Permission rules were set aside: ${error instanceof Error ? error.message : String(error)}`);
        this.state = { ...empty(), lost: aside };
        await this.commit(() => {}).catch(() => {});
      }
    }
    // Rules files are brought in line in the background: a slow disk or git never holds up the worker's start.
    void this.serial(() => this.apply()).catch(() => {});
  }

  /** Waits for changes under way; later calls are refused once closed. */
  async flush(): Promise<void> { await this.queue.catch(() => {}); }
  close(): void { this.closed = true; }
  /** While the worker hands over, nothing changes; a handover that does not happen resumes. */
  pause(): void { this.closed = true; }
  resume(): void { this.closed = false; }

  /**
   * The settings a Claude Code turn Tower starts in `cwd` gets: every project's rules, and those of the project the
   * folder is in (the folder itself or one inside it). Undefined when no rule applies.
   */
  /** The rules a Claude turn in this folder and conversation receives. */
  private claudeRules(cwd: string, sessionId?: string): PermissionRule[] {
    const now = Date.parse(this.now());
    // A conversation rule reaches only its own conversation's turns, until it expires.
    const rules = this.state.rules.filter(rule => rule.kind !== 'run' && rule.providers.includes('claude') && (rule.scope === 'global'
      || (rule.scope === 'project' && within(cwd, rule.cwd!))
      || (rule.scope === 'conversation' && rule.sessionId === sessionId && sessionId !== undefined && !expired(rule, now))));
    // Where the owner allowed a command overlapping one the reviewer allowed (in any scope that reaches this turn), the
    // owner's rule decides here: the reviewer's rule and its guards are left out of this turn, as a same-scope rule is replaced.
    const owned = rules.filter(rule => rule.source !== 'auto' && rule.kind === 'command');
    return rules.filter(rule => !(rule.source === 'auto' && rule.kind === 'command' && owned.some(mine => rulesOverlap(mine.value, rule.value))));
  }

  claudeSettings(cwd: string, sessionId?: string): string | undefined {
    const used = this.claudeRules(cwd, sessionId);
    const allow = [...new Set(used.map(claudeRule))];
    // A rule the reviewer allowed never covers its family's destructive variants: deny comes before allow.
    const deny = [...new Set(used.filter(rule => rule.source === 'auto').flatMap(rule => ruleGuards(rule).claude))];
    return allow.length ? JSON.stringify({ permissions: { allow, ...(deny.length ? { deny } : {}) } }) : undefined;
  }

  autoReview(): PermissionAutoReview { return { ...(this.state.autoReview ?? DEFAULT_AUTO_REVIEW) }; }

  /** The owner turns the reviewer on or off, or picks its model. Turning it off leaves waiting requests to the owner. */
  saveAutoReview(input: PermissionAutoReview): Promise<PermissionOverview> {
    return this.serial(async () => {
      if (!AUTO_REVIEW_MODELS[input.provider]?.includes(input.model)) throw failure('자동 검토에 쓸 수 없는 모델입니다.');
      const settings: PermissionAutoReview = { enabled: input.enabled, provider: input.provider, model: input.model, resume: input.resume };
      await this.commit(state => {
        state.autoReview = settings;
        if (!settings.enabled) for (const request of state.requests) {
          if (request.status === 'pending' && request.review?.status === 'queued') request.review = { status: 'skipped', reason: '자동 검토가 꺼졌습니다.', at: this.now() };
        }
      });
      this.options.onAutoReviewChange?.(settings);
      return this.overview();
    });
  }

  /** The oldest request waiting for the reviewer. */
  nextReview(): PermissionRequest | undefined {
    // One the reviewer started but could not record the end of (a full disk) is taken again, as after a restart.
    return this.state.requests.find(request => request.status === 'pending' && (request.review?.status === 'queued' || request.review?.status === 'running'));
  }

  /** A request the reviewer starts on. False when it is no longer waiting for one. */
  startReview(id: string): Promise<boolean> {
    return this.serial(async () => {
      const request = this.state.requests.find(item => item.id === id);
      if (!request || request.status !== 'pending' || (request.review?.status !== 'queued' && request.review?.status !== 'running')) return false;
      if (!this.autoReview().enabled) { await this.setReview(id, { status: 'skipped', reason: '자동 검토가 꺼졌습니다.', at: this.now() }); return false; }
      await this.setReview(id, { status: 'running', model: this.autoReview().model, at: this.now() });
      return true;
    });
  }

  /** A review that did not finish, or found it may not decide: the request waits for the owner. */
  failReview(id: string, error: string, status: 'failed' | 'skipped' = 'failed'): Promise<void> {
    return this.serial(async () => {
      const request = this.state.requests.find(item => item.id === id);
      if (!request || request.review?.status !== 'running') return;
      await this.setReview(id, { ...request.review, status, reason: error.slice(0, 500), at: this.now() });
    });
  }

  /**
   * Applies the reviewer's verdict. Hard limits hold whatever the model said: an allowed rule is the asked one or
   * narrower, always for the project, and still one the reviewer may decide; anything else waits for the owner. A
   * request the owner decided meanwhile keeps the owner's decision.
   */
  applyReview(id: string, result: PermissionReviewResult): Promise<PermissionReviewOutcome | undefined> {
    return this.serial(async () => {
      const request = this.state.requests.find(item => item.id === id);
      if (!request || request.review?.status !== 'running') return undefined;
      const at = this.now();
      // Turned off while the model answered: its answer is not used.
      if (!this.autoReview().enabled) { await this.setReview(id, { status: 'skipped', reason: '자동 검토가 꺼졌습니다.', at }); return undefined; }
      const reason = result.reason.trim().slice(0, 1000) || '이유 없음';
      const review = (extra: Partial<PermissionReview>): PermissionReview => ({ status: 'done', reason, ...(result.model ? { model: result.model } : {}), at, ...extra });
      if (request.status !== 'pending') {
        await this.setReview(id, review({ verdict: result.verdict }));
        return undefined;
      }
      const owner = async (why?: string) => {
        await this.setReview(id, review({ verdict: 'owner', ...(why ? { reason: `${reason} (${why})` } : {}) }));
        return { request: this.state.requests.find(item => item.id === id)! };
      };
      if (result.verdict === 'approve' && request.rule.kind === 'run') {
        // The exact command, as asked: the reviewer cannot change it. Tower runs it once, now.
        const block = autoReviewBlock(request.rule, request.cwd);
        if (block) return owner(block);
        await this.commit(state => {
          const item = state.requests.find(entry => entry.id === id)!;
          item.status = 'approved'; item.decidedAt = at; item.decidedBy = 'auto'; item.run = { status: 'waiting', ...(this.autoReview().resume ? { notify: true } : {}) };
          item.review = review({ verdict: 'approve' });
        });
        const item = this.state.requests.find(entry => entry.id === id)!;
        this.options.startRun?.(item);
        return { request: item };
      }
      if (result.verdict === 'approve') {
        const asked = request.rule;
        // This conversation only when the reviewer says so (or it was asked so) and only Claude needs it: Codex takes no per-turn rules.
        const conversation = (result.scope === 'conversation' || asked.scope === 'conversation') && request.provider !== 'codex'
          && (result.rule?.providers ?? asked.providers).every(provider => provider === 'claude');
        // Meant for this conversation only but it cannot be (a Codex agent, or Codex asked for too): never kept for good.
        if (result.scope === 'conversation' && !conversation) return owner('이 대화에만 줄 수 없는 규칙이라 소유자에게 넘깁니다');
        let given: PermissionRuleInput;
        try {
          given = clean({ kind: result.rule?.kind ?? asked.kind, value: result.rule?.value ?? asked.value, providers: result.rule?.providers?.length ? result.rule.providers : asked.providers,
            scope: conversation ? 'conversation' : 'project', cwd: request.cwd, ...(conversation ? { sessionId: request.sessionId, expiresAt: this.expiry() } : {}), note: `자동 승인: ${reason}`.slice(0, 500) });
          given = await this.checked(given);
        } catch (error) { return owner(error instanceof Error ? error.message : String(error)); }
        const block = autoReviewBlock(given, request.cwd);
        if (block) return owner(block);
        // Where the owner has a rule of their own that overlaps (`git push --force-with-lease` beside `git push`), the
        // deny rules of an allowed one would override theirs, and theirs could widen it: the owner decides.
        if (this.state.rules.some(item => item.source !== 'auto' && item.kind === given.kind && (item.scope !== 'conversation' || item.sessionId === request.sessionId)
          && (item.scope === 'global' || within(request.cwd, item.cwd!) || within(item.cwd!, request.cwd))
          && (given.kind === 'command' ? rulesOverlap(item.value, given.value) : sameRule({ ...item, scope: 'global' }, { ...given, scope: 'global' })))) {
          return owner('겹치는 소유자 규칙이 이미 있습니다');
        }
        if (asked.scope === 'conversation' && given.scope !== 'conversation') return owner('이 대화에만 요청한 규칙을 넓힐 수 없습니다');
        if (!ruleIsNarrower({ ...asked, scope: 'project', cwd: request.cwd }, { ...given, scope: 'project' })) return owner('검토기가 요청보다 넓은 규칙을 냈습니다');
        try {
          await this.commit(state => {
            const made = upsert(state, given, undefined, 'auto', id, at);
            const item = state.requests.find(entry => entry.id === id)!;
            item.status = 'approved'; item.decidedAt = at; item.ruleId = made.id; item.decidedBy = 'auto';
            item.review = review({ verdict: 'approve' });
          });
        } catch (error) { return owner(error instanceof Error ? error.message : String(error)); }
        await this.apply();
        const item = this.state.requests.find(entry => entry.id === id)!;
        return { request: item, message: reviewMessage(item, given) };
      }
      if (result.verdict === 'narrow') {
        const since = Date.parse(at) - DAY_MS;
        const narrowed = this.state.requests.filter(item => item.sessionId === request.sessionId && item.review?.verdict === 'narrow' && Date.parse(item.review.at ?? item.createdAt) >= since).length;
        if (narrowed >= MAX_NARROW) return owner('이 대화는 오늘 이미 범위를 줄여 다시 요청했습니다');
        const suggestion = result.suggestion?.trim().slice(0, 500);
        await this.commit(state => {
          const item = state.requests.find(entry => entry.id === id)!;
          item.status = 'withdrawn'; item.decidedAt = at; item.decidedBy = 'auto';
          item.review = review({ verdict: 'narrow', ...(suggestion ? { suggestion } : {}) });
        });
        const item = this.state.requests.find(entry => entry.id === id)!;
        return { request: item, message: reviewMessage(item) };
      }
      return owner();
    });
  }

  /** A review whose material changed while it ran: it is done again. */
  requeueReview(id: string): Promise<void> {
    return this.serial(async () => {
      const request = this.state.requests.find(item => item.id === id);
      if (!request || request.status !== 'pending' || request.review?.status !== 'running') return;
      await this.setReview(id, { status: 'queued', at: this.now() });
    });
  }

  /** A request sent back for a narrower rule whose agent could not be told: it waits for the owner instead. */
  reopenForOwner(id: string, why: string): Promise<void> {
    return this.serial(async () => {
      await this.commit(state => {
        const item = state.requests.find(entry => entry.id === id);
        if (!item || item.status !== 'withdrawn' || item.decidedBy !== 'auto') return;
        item.status = 'pending'; delete item.decidedAt; delete item.decidedBy;
        item.review = { ...(item.review ?? { status: 'done' }), status: 'done', verdict: 'owner', reason: `${item.review?.reason ?? ''} (${why})`.trim() };
      });
    });
  }

  private async setReview(id: string, review: PermissionReview): Promise<void> {
    await this.commit(state => { const item = state.requests.find(entry => entry.id === id); if (item) item.review = review; });
  }

  pending(): number { return this.state.requests.filter(request => request.status === 'pending').length; }

  /** Everything, or what applies to one folder: rules for every project and that folder's own, and its requests. */
  overview(cwd?: string): PermissionOverview {
    const rules = this.state.rules.filter(rule => !cwd || rule.scope === 'global' || rule.cwd === cwd);
    const requests = this.state.requests.filter(request => !cwd || request.cwd === cwd).slice().reverse();
    return { rules, requests, targets: this.targets(cwd), pending: requests.filter(waitingForOwner).length, ...(this.state.lost ? { lost: this.state.lost } : {}),
      autoReview: this.autoReview() };
  }

  /** What an agent sees: the rules that apply to its folder, and the requests its own conversation sent. */
  forAgent(caller: PermissionCaller, cwd?: string) {
    const session = caller.sessionId ? this.options.session(caller.sessionId) : undefined;
    const folder = cwd ?? session?.cwd;
    return {
      rules: this.state.rules.filter(rule => rule.scope === 'global' || (rule.scope === 'project' && rule.cwd === folder) || (rule.scope === 'conversation' && caller.sessionId && rule.sessionId === caller.sessionId))
        .map(rule => ({ id: rule.id, kind: rule.kind, value: rule.value, providers: rule.providers, scope: rule.scope, ...(rule.cwd ? { cwd: rule.cwd } : {}), ...(rule.expiresAt ? { expiresAt: rule.expiresAt } : {}) })),
      requests: this.state.requests.filter(request => caller.sessionId && request.sessionId === caller.sessionId).slice(-20).reverse()
        .map(request => ({ id: request.id, status: request.status, rule: request.rule, createdAt: request.createdAt, ...(request.decidedAt ? { decidedAt: request.decidedAt } : {}),
          ...(request.decidedBy ? { decidedBy: request.decidedBy } : {}),
          ...(request.review ? { review: { status: request.review.status, ...(request.review.verdict ? { verdict: request.review.verdict } : {}), ...(request.review.reason ? { reason: request.review.reason } : {}),
            ...(request.review.suggestion ? { suggestion: request.review.suggestion } : {}) } } : {}),
          ...(request.run ? { run: { status: request.run.status, ...(request.run.exitCode !== undefined ? { exitCode: request.run.exitCode } : {}), ...(request.run.timedOut ? { timedOut: true } : {}),
            ...(request.run.error ? { error: request.run.error } : {}) } } : {}) })),
    };
  }

  /** An agent asks the owner for a rule. The same pending request is returned again rather than repeated. */
  request(input: { kind: PermissionRuleInput['kind']; value: string; providers?: PermissionProvider[]; scope: PermissionRuleInput['scope']; reason: string }, caller: PermissionCaller) {
    return this.serial(async () => {
      if (caller.controllerId) throw failure('다른 컴퓨터에서 시작한 작업은 이 컴퓨터의 권한을 요청할 수 없습니다.', 403);
      const session = caller.sessionId ? this.options.session(caller.sessionId) : undefined;
      if (!caller.sessionId || !session?.cwd) throw failure('권한 요청은 Tower에서 시작한 대화에서만 보낼 수 있습니다.', 403);
      const provider: PermissionProvider = session.provider === 'codex' ? 'codex' : 'claude';
      if (input.scope === 'conversation' && provider !== 'claude') throw failure('Codex 대화에는 대화 한정 규칙을 줄 수 없습니다. project 범위로 요청하거나 permissions_run으로 한 번 실행을 요청하세요.');
      const rule = await this.checked(clean({ kind: input.kind, value: input.value, providers: input.kind === 'claude' || input.scope === 'conversation' ? ['claude'] : input.providers ?? [provider], scope: input.scope,
        ...(input.scope !== 'global' ? { cwd: session.cwd } : {}), ...(input.scope === 'conversation' ? { sessionId: caller.sessionId, expiresAt: this.expiry() } : {}) }));
      // A rule for every project, for this project or for this conversation already covers what the request asks for.
      const now = Date.parse(this.now());
      const alike = this.state.rules.filter(existing => existing.kind === rule.kind && sameRule({ ...existing, scope: 'global', cwd: undefined, sessionId: undefined }, { ...rule, scope: 'global', cwd: undefined, sessionId: undefined }));
      // Each agent asked for is covered by a rule of its own that reaches this folder: Codex reads a project's rules in
      // that folder only, so a folder inside another is not covered for it.
      // For Claude, only what its turns in this conversation really receive counts.
      const reaching = new Set(this.claudeRules(session.cwd, caller.sessionId).map(item => item.id));
      const covers = (existing: PermissionRule, item: PermissionProvider) => existing.providers.includes(item) && (item !== 'claude' || reaching.has(existing.id)) && (existing.scope === 'global'
        || (existing.scope === 'project' && rule.scope !== 'global' && (item === 'codex' ? existing.cwd === rule.cwd : within(rule.cwd!, existing.cwd!)))
        || (existing.scope === 'conversation' && rule.scope === 'conversation' && existing.sessionId === rule.sessionId && !expired(existing, now)));
      if (rule.providers.every(item => alike.some(existing => covers(existing, item)))) return { request: { status: 'exists' as const }, note: 'This rule is already allowed. Try the action again; a Codex rule applies from the next turn.' };
      // Only this conversation's own request is the same one: another conversation hears its own decision.
      const same = this.state.requests.find(request => request.status === 'pending' && request.sessionId === caller.sessionId && sameRule(request.rule, rule)
        && rule.providers.every(item => request.rule.providers.includes(item)));
      if (same) return { request: { id: same.id, status: same.status }, note: WAIT_NOTE };
      if (this.pending() >= MAX_PENDING) throw failure('기다리는 권한 요청이 너무 많습니다. 소유자가 Tower에서 먼저 정리해야 합니다.', 429);
      const request: PermissionRequest = { id: randomUUID(), status: 'pending', rule, reason: input.reason.trim(), sessionId: caller.sessionId, ...(caller.runId ? { runId: caller.runId } : {}),
        cwd: session.cwd, provider, createdAt: this.now() };
      if (this.autoReview().enabled) {
        const skip = autoReviewBlock(rule, session.cwd) ?? this.options.autoReviewSkip?.(request);
        request.review = skip ? { status: 'skipped', reason: skip, at: this.now() } : { status: 'queued', at: this.now() };
      }
      await this.commit(state => { state.requests.push(request); });
      if (request.review?.status === 'queued') this.options.onReviewQueued?.();
      return { request: { id: request.id, status: request.status }, note: request.review?.status === 'queued' ? REVIEW_NOTE : WAIT_NOTE };
    });
  }

  /**
   * An agent asks Tower to run one exact command once. A retry with the same key (the agent's, or else the same command
   * in the same conversation shortly after) returns the same request and never runs it again.
   */
  requestRun(input: { command: string; reason: string; timeoutSeconds?: number; key?: string }, caller: PermissionCaller) {
    return this.serial(async () => {
      if (caller.controllerId) throw failure('다른 컴퓨터에서 시작한 작업은 이 컴퓨터에서 명령을 실행해 달라고 요청할 수 없습니다.', 403);
      const session = caller.sessionId ? this.options.session(caller.sessionId) : undefined;
      if (!caller.sessionId || !session?.cwd) throw failure('실행 요청은 Tower에서 시작한 대화에서만 보낼 수 있습니다.', 403);
      const provider: PermissionProvider = session.provider === 'codex' ? 'codex' : 'claude';
      const command = input.command.replace(/\r\n/g, '\n');
      const rule = clean({ kind: 'run', value: command, providers: [provider], scope: 'project', cwd: session.cwd });
      const explicit = Boolean(input.key?.trim());
      const key = explicit ? `key:${input.key!.trim()}` : `command:${createHash('sha256').update(command).digest('hex')}`;
      const now = Date.parse(this.now());
      const same = [...this.state.requests].reverse().find(request => request.rule.kind === 'run' && request.sessionId === caller.sessionId && request.key === key
        && ((explicit && request.status !== 'denied' && request.status !== 'withdrawn') || request.status === 'pending' || (request.status === 'approved' && !finishedRun(request.run))
          || (request.status === 'approved' && now - Date.parse(request.run?.finishedAt ?? request.createdAt) < SAME_RUN_MS)));
      if (same) {
        if (same.rule.value !== command) throw failure('같은 key로 다른 명령을 요청했습니다. 다른 명령에는 새 key를 쓰세요.', 409);
        return { request: runView(same), note: same.status === 'approved' ? RUN_SAME_NOTE : RUN_NOTE };
      }
      if (this.pending() >= MAX_PENDING) throw failure('기다리는 권한 요청이 너무 많습니다. 소유자가 Tower에서 먼저 정리해야 합니다.', 429);
      const request: PermissionRequest = { id: randomUUID(), status: 'pending', rule, reason: input.reason.trim(), sessionId: caller.sessionId, ...(caller.runId ? { runId: caller.runId } : {}),
        cwd: session.cwd, provider, createdAt: this.now(), key, ...(explicit ? { keyExplicit: true } : {}), timeoutSeconds: Math.min(input.timeoutSeconds ?? MAX_RUN_SECONDS, MAX_RUN_SECONDS) };
      if (this.autoReview().enabled) {
        const skip = autoReviewBlock(rule, session.cwd) ?? this.options.autoReviewSkip?.(request);
        request.review = skip ? { status: 'skipped', reason: skip, at: this.now() } : { status: 'queued', at: this.now() };
      }
      await this.commit(state => { state.requests.push(request); });
      if (request.review?.status === 'queued') this.options.onReviewQueued?.();
      return { request: runView(request), note: RUN_NOTE };
    });
  }

  /**
   * A run request's state for the conversation that sent it, waiting up to `waitSeconds` for it to finish. A finished
   * result it returns counts as delivered, so no message about it follows.
   */
  async runResult(input: { id: string; waitSeconds?: number }, caller: PermissionCaller) {
    const deadline = Date.now() + Math.min(input.waitSeconds ?? 0, 50) * 1000;
    const find = () => {
      const request = this.state.requests.find(item => item.id === input.id && item.rule.kind === 'run');
      if (!request || request.sessionId !== caller.sessionId) throw failure('이 대화의 실행 요청이 아닙니다.', 404);
      return request;
    };
    let request = find();
    while (!settled(request) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      request = find();
    }
    if (request.run && finishedRun(request.run) && !request.run.delivered) {
      await this.serial(async () => { await this.commit(state => { const item = state.requests.find(entry => entry.id === input.id); if (item?.run) { item.run.delivered = true; item.run.toldAt = this.now(); } }); }).catch(() => {});
    }
    const output = request.run && finishedRun(request.run) ? await this.options.runOutput?.(request.id) : undefined;
    return { request: runView(request), ...(output ? { output } : {}) };
  }

  /** The runner reports a run's progress. */
  updateRun(id: string, run: PermissionRun): Promise<void> {
    return this.serial(async () => {
      const request = this.state.requests.find(item => item.id === id);
      if (!request) return;
      await this.commit(state => { const item = state.requests.find(entry => entry.id === id)!; item.run = { ...run, ...(item.run?.delivered ? { delivered: true } : {}), ...(item.run?.notify ? { notify: true } : {}), ...(item.run?.toldAt ? { toldAt: item.run.toldAt } : {}) }; });
      if (finishedRun(run)) this.options.onRunFinished?.(this.state.requests.find(item => item.id === id)!);
    });
  }

  /** Allowed runs a previous worker never started, and runs it left running (for the runner to recover). */
  unfinishedRuns(): { start: PermissionRequest[]; running: PermissionRequest[] } {
    const runs = this.state.requests.filter(request => request.rule.kind === 'run' && request.status === 'approved' && request.run && !finishedRun(request.run));
    return { start: runs.filter(request => request.run!.status === 'waiting'), running: runs.filter(request => request.run!.status === 'running') };
  }

  /** Finished runs whose conversation asked to hear the result and has not yet (a worker stopped before telling it). */
  untoldRuns(): PermissionRequest[] {
    return this.state.requests.filter(request => request.rule.kind === 'run' && request.run && finishedRun(request.run) && request.run.notify && !request.run.delivered);
  }

  /** The result reached the conversation as a message. */
  markTold(id: string): Promise<void> {
    return this.serial(async () => { await this.commit(state => { const item = state.requests.find(entry => entry.id === id); if (item?.run) { item.run.delivered = true; item.run.toldAt = this.now(); } }); });
  }

  /** Conversation rules whose time is up, or whose conversation is closed or gone, go. */
  expire(closed: ReadonlySet<string>): Promise<void> {
    return this.serial(async () => {
      const now = Date.parse(this.now());
      const gone = (rule: PermissionRule) => rule.scope === 'conversation' && (expired(rule, now) || closed.has(rule.sessionId!) || !this.options.session(rule.sessionId!));
      if (!this.state.rules.some(gone)) return;
      await this.commit(state => { state.rules = state.rules.filter(rule => !gone(rule)); });
    });
  }

  /** The owner closed a conversation: its rules go at once, so reopening it does not bring them back. */
  forgetConversation(sessionId: string, closedAt?: string): Promise<PermissionOverview> {
    return this.serial(async () => {
      const at = this.now();
      // Only what came before the close: a retry arriving after the conversation was reopened leaves its new rules alone.
      const before = (time: string) => !closedAt || time <= closedAt;
      // Its requests still waiting are withdrawn too, so a review that ends later cannot give it a rule again.
      const open = (request: PermissionRequest) => request.sessionId === sessionId && request.status === 'pending' && before(request.createdAt);
      const mine = (rule: PermissionRule) => rule.scope === 'conversation' && rule.sessionId === sessionId && before(rule.updatedAt);
      if (this.state.rules.some(mine) || this.state.requests.some(open)) {
        await this.commit(state => {
          state.rules = state.rules.filter(rule => !mine(rule));
          for (const request of state.requests) if (open(request)) { request.status = 'withdrawn'; request.decidedAt = at; request.decidedBy = 'owner'; }
        });
      }
      return this.overview();
    });
  }

  private expiry(): string { return new Date(Date.parse(this.now()) + CONVERSATION_RULE_HOURS * 60 * 60 * 1000).toISOString(); }

  /** The owner has seen that an earlier record was set aside. */
  acknowledge(): Promise<PermissionOverview> {
    return this.serial(async () => { await this.commit(state => { delete state.lost; }); return this.overview(); });
  }

  /** The owner adds a rule, or changes one. */
  save(input: PermissionRuleInput & { id?: string }): Promise<PermissionOverview> {
    return this.serial(async () => {
      if (input.kind === 'run') throw failure('한 번 실행은 규칙으로 저장할 수 없습니다.');
      const rule = await this.checked(clean(input));
      let replaced: string[] = [];
      await this.commit(state => { const made = upsert(state, rule, input.id, 'owner', undefined, this.now()); if (made.source !== 'auto') replaced = dropOverlappingAuto(state, made); });
      await this.apply();
      return { ...this.overview(), ...(replaced.length ? { replaced } : {}) };
    });
  }

  remove(id: string): Promise<PermissionOverview> {
    return this.serial(async () => {
      if (!this.state.rules.some(rule => rule.id === id)) throw failure('규칙을 찾지 못했습니다.', 404);
      await this.commit(state => { state.rules = state.rules.filter(rule => rule.id !== id); });
      await this.apply();
      return this.overview();
    });
  }

  /**
   * The owner allows a request, as asked or as edited, or refuses it. With `resume`, the decision is sent to the
   * requesting conversation as the owner's next message, so the agent goes on (after the turn under way, if any).
   */
  async decide(id: string, approve: boolean, edited?: PermissionRuleInput, resume = false): Promise<PermissionOverview> {
    let replaced: string[] = [];
    const { request, rule, run } = await this.serial(async (): Promise<{ request: PermissionRequest; rule: PermissionRuleInput | undefined; run?: boolean }> => {
      const request = this.state.requests.find(item => item.id === id);
      if (!request) throw failure('요청을 찾지 못했습니다.', 404);
      if (request.status !== 'pending') throw failure('이미 처리한 요청입니다.', 409);
      const at = this.now();
      if (!approve) {
        await this.commit(state => { const item = state.requests.find(entry => entry.id === id)!; item.status = 'denied'; item.decidedAt = at; item.decidedBy = 'owner'; });
        return { request, rule: undefined };
      }
      if (request.rule.kind === 'run') {
        // The owner allows the exact command: Tower runs it once, now. Its result reaches the conversation when it is done.
        await this.commit(state => { const item = state.requests.find(entry => entry.id === id)!; item.status = 'approved'; item.decidedAt = at; item.decidedBy = 'owner'; item.run = { status: 'waiting', ...(resume ? { notify: true } : {}) }; });
        this.options.startRun?.(this.state.requests.find(entry => entry.id === id)!);
        return { request, rule: undefined, run: true };
      }
      if (edited?.kind === 'run') throw failure('한 번 실행은 규칙으로 바꿔 허용할 수 없습니다.');
      const chosen = edited ?? request.rule;
      // A rule for one conversation lasts from the decision, however long the request waited.
      const rule = await this.checked(clean(chosen.scope === 'conversation' ? { ...chosen, expiresAt: this.expiry() } : chosen));
      await this.commit(state => {
        const made = upsert(state, rule, undefined, 'request', id, at);
        replaced = dropOverlappingAuto(state, made);
        const item = state.requests.find(entry => entry.id === id)!;
        item.status = 'approved'; item.decidedAt = at; item.ruleId = made.id; item.decidedBy = 'owner';
      });
      await this.apply();
      return { request, rule };
    });
    const extra = replaced.length ? { replaced } : {};
    if (!resume || !this.options.resume) return { ...this.overview(), ...extra };
    // The decision stands whether or not the conversation can take a message now.
    // A run's own message comes with its result; a refused run is said now.
    if (run) return { ...this.overview(), ...extra };
    const note = await this.options.resume(request.sessionId, decisionMessage(request.rule, rule)).then(() => undefined, error => error instanceof Error ? error.message : String(error));
    return { ...this.overview(), ...extra, resumed: note ? { error: note } : { sent: true } };
  }

  /** A rule this computer can keep: a Codex rule for a project whose rules file would be the one for every project cannot. */
  private async checked(rule: PermissionRuleInput): Promise<PermissionRuleInput> {
    if (rule.kind === 'command' && rule.scope === 'project' && rule.providers.includes('codex')
      && await realLocation(codexRulesPath('project', rule.cwd, this.options.env)) === await realLocation(codexRulesPath('global', undefined, this.options.env))) {
      throw failure('이 폴더의 Codex 규칙 파일은 모든 프로젝트용 파일과 같습니다. 모든 프로젝트 규칙으로 저장하세요.');
    }
    return rule;
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(failure('권한 규칙을 지금은 바꿀 수 없습니다. 잠시 뒤 다시 시도하세요.', 503));
    const next = this.queue.catch(() => {}).then(work);
    this.queue = next;
    return next;
  }

  /** A change becomes current only once it is saved. */
  private async commit(change: (state: PermissionState) => void): Promise<void> {
    const next = structuredClone(this.state);
    change(next);
    trim(next, this.options.now?.() ?? new Date());
    await writePrivateJson(this.path, JSON.stringify(next, null, 2));
    // A run request that left the record takes its kept output with it.
    const kept = new Set(next.requests.map(request => request.id));
    for (const request of this.state.requests) if (request.rule.kind === 'run' && !kept.has(request.id)) void this.options.forgetRun?.(request.id).catch(() => {});
    this.state = next;
  }

  /** Every Codex rules file Tower writes, with the lines it should hold now. */
  private desired(): Map<string, { scope: PermissionRule['scope']; cwd?: string; lines: string[] }> {
    const files = new Map<string, { scope: PermissionRule['scope']; cwd?: string; lines: string[] }>();
    // The file for every project is always checked, so rules left there by a record that could not be read are removed.
    if (this.options.globalCodex !== false) files.set(codexRulesPath('global', undefined, this.options.env), { scope: 'global', lines: [] });
    for (const rule of this.state.rules) {
      if (rule.kind !== 'command' || !rule.providers.includes('codex') || rule.scope === 'conversation') continue;
      if (rule.scope === 'global' && this.options.globalCodex === false) continue;
      const path = codexRulesPath(rule.scope, rule.cwd, this.options.env);
      const file = files.get(path) ?? { scope: rule.scope, ...(rule.cwd ? { cwd: rule.cwd } : {}), lines: [] };
      for (const line of [codexRule(rule), ...(rule.source === 'auto' ? ruleGuards(rule).codex : [])]) if (!file.lines.includes(line)) file.lines.push(line);
      files.set(path, file);
    }
    return files;
  }

  /** Brings Codex's rules files in line with the rules. A file that cannot be changed keeps an error; the rest go on. */
  private async apply(): Promise<void> {
    const files = this.desired();
    const errors = new Map<string, string>();
    for (const file of this.state.codex) if (!files.has(file.path)) files.set(file.path, { scope: file.scope, ...(file.cwd ? { cwd: file.cwd } : {}), lines: [] });
    for (const [path, file] of files) {
      try {
        await syncCodex(path, file.lines, file.scope === 'project' ? file.cwd : undefined, codexRulesPath('global', undefined, this.options.env));
        const had = this.state.codex.some(item => item.path === path);
        if (had !== file.lines.length > 0) await this.commit(state => {
          state.codex = file.lines.length ? [...state.codex, { path, scope: file.scope, ...(file.cwd ? { cwd: file.cwd } : {}) }] : state.codex.filter(item => item.path !== path);
        });
      } catch (error) { errors.set(path, error instanceof Error ? error.message : String(error)); }
    }
    this.errors = errors;
  }

  private targets(cwd?: string): PermissionTarget[] {
    const files = this.desired();
    for (const file of this.state.codex) if (this.errors.has(file.path) && !files.has(file.path)) files.set(file.path, { scope: file.scope, ...(file.cwd ? { cwd: file.cwd } : {}), lines: [] });
    const shown: PermissionTarget[] = [...files].filter(([, file]) => !cwd || file.scope === 'global' || file.cwd === cwd)
      .map(([path, file]) => ({ provider: 'codex' as const, scope: file.scope, ...(file.cwd ? { cwd: file.cwd } : {}), path, rules: file.lines.length, ...(this.errors.has(path) ? { error: this.errors.get(path) } : {}) }));
    if (this.options.globalCodex === false && this.state.rules.some(rule => rule.scope === 'global' && rule.kind === 'command' && rule.providers.includes('codex'))) {
      shown.push({ provider: 'codex', scope: 'global', path: codexRulesPath('global', undefined, this.options.env), rules: 0, error: GLOBAL_CODEX_ELSEWHERE });
    }
    return shown;
  }
}
const GLOBAL_CODEX_ELSEWHERE = '이 Tower는 기본 상태 폴더를 쓰지 않아 모든 프로젝트용 Codex 규칙 파일을 쓰지 않습니다. 기본 Tower에서 저장하세요.';

/** What the requesting agent is told once the owner decided. */
function decisionMessage(asked: PermissionRuleInput, allowed: PermissionRuleInput | undefined): string {
  const where = (rule: PermissionRuleInput) => rule.scope === 'global' ? 'every project' : rule.scope === 'conversation' ? 'this conversation only (for 24 hours)' : 'this project';
  if (!allowed) return `The owner refused your permission request for \`${asked.value}\` in Tower. Do not look for another way to do it: finish what you can without it and report what remains blocked.`;
  const changed = allowed.value !== asked.value || allowed.scope !== asked.scope || allowed.kind !== asked.kind;
  return `The owner allowed \`${allowed.value}\` for ${allowed.providers.map(provider => provider === 'claude' ? 'Claude Code' : 'Codex').join(' and ')} in ${where(allowed)}`
    + `${changed ? ` (you asked for \`${asked.value}\` in ${where(asked)})` : ''}. It applies from this turn. Continue the task where it waited on this permission.`;
}

/** What the requesting agent is told after Tower's reviewer allowed its request or sent it back. */
function reviewMessage(request: PermissionRequest, allowed?: PermissionRuleInput): string {
  const why = request.review?.reason ? ` Reason: ${request.review.reason}` : '';
  if (allowed) {
    const changed = allowed.value !== request.rule.value || request.rule.scope !== allowed.scope;
    return `Tower's permission reviewer allowed \`${allowed.value}\` for ${allowed.providers.map(provider => provider === 'claude' ? 'Claude Code' : 'Codex').join(' and ')} in ${allowed.scope === 'conversation' ? 'this conversation only (for 24 hours)' : 'this project'}`
      + `${changed ? ` (you asked for \`${request.rule.value}\`${request.rule.scope === 'global' ? ' in every project' : ''})` : ''}.${why} It applies from this turn. Continue the task where it waited on this permission.`;
  }
  const instead = request.review?.suggestion ? ` Ask for this instead: ${request.review.suggestion}` : ' Ask for a narrower rule that covers only what the task needs.';
  return `Tower's permission reviewer did not allow \`${request.rule.value}\` as asked, and withdrew the request.${why}${instead} If the task still needs it, send a new permissions_request; do not look for another way around the refusal.`;
}

const REVIEW_NOTE = 'Tower\'s permission reviewer checks this request against the owner\'s instructions for this task first; the owner can also decide it. Do not look for another way around the refusal. An allowed rule applies from your next turn: say in your reply what waits on this permission and end your turn, or go on with other work first. The decision is sent to this conversation; permissions_list also shows it.';

const RUN_NOTE = 'Tower runs this exact command once, in this conversation\'s folder, only if Tower\'s reviewer or the owner allows it. Call permissions_runResult with this id (waitSeconds up to 50) to wait for the result; if your turn ends first, the result may be sent to this conversation (when whoever allows it asks for that), and permissions_runResult always has it. Do not look for another way to run it, and do not ask again with a new key unless you mean to run it again.';
const RUN_SAME_NOTE = 'This is the same request you sent before (same key, or the same command a moment ago); it is not run again. Its state and result are here and in permissions_runResult. To run the command again on purpose, send it with a new key.';

const WAIT_NOTE = 'The owner decides this in Tower. Do not look for another way around the refusal. An allowed rule applies from your next turn: say in your reply what waits on this permission and end your turn, or go on with other work first. The owner can send the decision to this conversation; permissions_list also shows it.';


/** A kept run request answers a same retry this long after it finished (with an explicit key, for as long as it is kept). */
const SAME_RUN_MS = 10 * 60 * 1000;
const finishedRun = (run: PermissionRun | undefined) => run?.status === 'done' || run?.status === 'failed';
/** Nothing more will happen to it: refused, withdrawn, or its run finished. */
const settled = (request: PermissionRequest) => request.status === 'denied' || request.status === 'withdrawn' || (request.status === 'approved' && finishedRun(request.run));
const expired = (rule: PermissionRule, now: number) => rule.scope === 'conversation' && (!rule.expiresAt || Date.parse(rule.expiresAt) <= now);

/** What an agent sees of a run request. */
function runView(request: PermissionRequest) {
  return { id: request.id, status: request.status, command: request.rule.value, ...(request.decidedBy ? { decidedBy: request.decidedBy } : {}),
    ...(request.review ? { review: { status: request.review.status, ...(request.review.verdict ? { verdict: request.review.verdict } : {}), ...(request.review.reason ? { reason: request.review.reason } : {}),
      ...(request.review.suggestion ? { suggestion: request.review.suggestion } : {}) } } : {}),
    ...(request.run ? { run: { status: request.run.status, ...(request.run.exitCode !== undefined ? { exitCode: request.run.exitCode } : {}), ...(request.run.signal ? { signal: request.run.signal } : {}),
      ...(request.run.timedOut ? { timedOut: true } : {}), ...(request.run.error ? { error: request.run.error } : {}), ...(request.run.startedAt ? { startedAt: request.run.startedAt } : {}),
      ...(request.run.finishedAt ? { finishedAt: request.run.finishedAt } : {}), ...(request.run.stdoutBytes !== undefined ? { stdoutBytes: request.run.stdoutBytes, stderrBytes: request.run.stderrBytes ?? 0 } : {}),
      ...(request.run.truncated ? { truncated: true } : {}) } } : {}) };
}

/** A folder that is the project or inside it. */
const within = (cwd: string, project: string) => cwd === project || cwd.startsWith(project.endsWith('/') ? project : `${project}/`);

function clean(input: PermissionRuleInput): PermissionRuleInput {
  // A command to run is kept exactly as asked; a rule is normalized.
  const value = input.kind === 'command' ? normalizeCommand(input.value) : input.kind === 'run' ? input.value : input.value.trim();
  const providers: PermissionProvider[] = input.kind === 'claude' ? ['claude'] : (['claude', 'codex'] as const).filter(item => input.providers.includes(item));
  const rule: PermissionRuleInput = { kind: input.kind, value, providers, scope: input.scope, ...(input.scope !== 'global' && input.cwd ? { cwd: input.cwd.replace(/\/+$/, '') || '/' } : {}),
    ...(input.scope === 'conversation' && input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.scope === 'conversation' && input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, 500) } : {}) };
  const problem = ruleProblem({ ...rule, value: input.kind === 'command' ? input.value : value });
  if (!problem && rule.scope === 'conversation' && !rule.expiresAt) throw failure('대화 한정 규칙에는 만료 시각이 필요합니다.');
  if (problem) throw failure(problem);
  return rule;
}

/**
 * The owner's own rule where the reviewer allowed an overlapping one (`git push --force-with-lease` beside `git push`):
 * the reviewer's rule would deny what the owner allows, so it goes. Agents ask again, and the owner decides those.
 */
function dropOverlappingAuto(state: PermissionState, rule: PermissionRule): string[] {
  const overlaps = (item: PermissionRule) => item.id !== rule.id && item.source === 'auto' && item.kind === 'command' && rule.kind === 'command' && rulesOverlap(item.value, rule.value)
    // A rule for one conversation replaces only that conversation's own: the rest of the project keeps its rules.
    && (rule.scope === 'conversation' ? item.scope === 'conversation' && item.sessionId === rule.sessionId
      : item.scope !== 'conversation' && (rule.scope === 'global' || item.scope === 'global' || within(item.cwd!, rule.cwd!) || within(rule.cwd!, item.cwd!)));
  const gone = state.rules.filter(overlaps);
  state.rules = state.rules.filter(item => !gone.includes(item));
  return gone.map(item => item.value);
}

/** Saves a rule as a new one, into the one it edits, or into an existing rule meaning the same (providers joined). */
function upsert(state: PermissionState, rule: PermissionRuleInput, id: string | undefined, source: PermissionRule['source'], requestId: string | undefined, at: string): PermissionRule {
  if (id) {
    const index = state.rules.findIndex(item => item.id === id);
    if (index < 0) throw failure('규칙을 찾지 못했습니다.', 404);
    if (state.rules.some(item => item.id !== id && sameRule(item, rule))) throw failure('같은 규칙이 이미 있습니다.', 409);
    state.rules[index] = { ...state.rules[index], ...rule, ...(rule.note ? {} : { note: undefined }), ...(rule.cwd ? {} : { cwd: undefined }), updatedAt: at,
      // A rule the reviewer made becomes the owner's once the owner changes what it allows; a note or its agents alone keep its deny rules.
      ...(state.rules[index]!.source === 'auto' && source !== 'auto' && !sameRule(state.rules[index]!, rule) ? { source } : {}) };
    state.rules[index] = JSON.parse(JSON.stringify(state.rules[index]));
    return state.rules[index];
  }
  const same = state.rules.find(item => sameRule(item, rule));
  if (same) {
    // The owner making or allowing a rule the reviewer made makes it the owner's: it keeps no guards of its own.
    if (same.source === 'auto' && source !== 'auto') { same.source = source; delete same.requestId; if (requestId) same.requestId = requestId; }
    same.providers = (['claude', 'codex'] as const).filter(item => same.providers.includes(item) || rule.providers.includes(item));
    same.updatedAt = at;
    // Allowed again: a rule for one conversation lasts from now.
    if (rule.expiresAt && (!same.expiresAt || same.expiresAt < rule.expiresAt)) same.expiresAt = rule.expiresAt;
    return same;
  }
  if (state.rules.length >= MAX_RULES) throw failure('규칙은 200개까지 저장할 수 있습니다.', 409);
  const made: PermissionRule = { ...rule, id: randomUUID(), source, ...(requestId ? { requestId } : {}), createdAt: at, updatedAt: at };
  state.rules.push(made);
  return made;
}

function trim(state: PermissionState, now: Date): void {
  const cutoff = now.getTime() - DECIDED_DAYS * 24 * 60 * 60 * 1000;
  // A run counts from when it finished, so a result is kept a while after it arrives however long it waited.
  // (and from when the conversation heard of it, so it can still read the result it was told about).
  const at = (request: PermissionRequest) => Date.parse(request.run?.toldAt ?? request.run?.finishedAt ?? request.decidedAt ?? request.createdAt);
  const decided = state.requests.filter(request => request.status !== 'pending' && at(request) >= cutoff).sort((a, b) => at(a) - at(b)).slice(-MAX_DECIDED);
  const keep = new Set(decided);
  // A run still waiting or running, or whose result its conversation has yet to hear, is kept whatever its age.
  state.requests = state.requests.filter(request => request.status === 'pending' || keep.has(request)
    || (request.run && (!finishedRun(request.run) || (request.run.notify && !request.run.delivered))));
}

const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';

function normalize(value: unknown): PermissionState {
  const input = value && typeof value === 'object' ? value as Partial<PermissionState> : {};
  const state = empty();
  const ruleInput = (item: any, runs = false): PermissionRuleInput | undefined => {
    if (!item || (item.kind !== 'command' && item.kind !== 'claude' && !(runs && item.kind === 'run')) || typeof item.value !== 'string') return undefined;
    const providers = (['claude', 'codex'] as const).filter(provider => Array.isArray(item.providers) && item.providers.includes(provider));
    const scope: PermissionRuleInput['scope'] = item.scope === 'project' || item.scope === 'conversation' ? item.scope : 'global';
    // A project or conversation rule that lost its folder (or conversation) is dropped, never widened.
    if (scope !== 'global' && typeof item.cwd !== 'string') return undefined;
    if (scope === 'conversation' && (typeof item.sessionId !== 'string' || typeof item.expiresAt !== 'string')) return undefined;
    const rule: PermissionRuleInput = { kind: item.kind, value: text(item.value, item.kind === 'run' ? MAX_RUN_COMMAND : 400), providers, scope,
      ...(scope !== 'global' ? { cwd: item.cwd } : {}), ...(scope === 'conversation' ? { sessionId: item.sessionId, expiresAt: item.expiresAt } : {}),
      ...(typeof item.note === 'string' ? { note: text(item.note, 500) } : {}) };
    return ruleProblem(rule) ? undefined : rule;
  };
  if (Array.isArray(input.rules)) for (const item of input.rules as any[]) {
    const rule = ruleInput(item);
    if (rule && typeof item.id === 'string') state.rules.push({ ...rule, id: item.id, source: item.source === 'request' || item.source === 'auto' ? item.source : 'owner', ...(typeof item.requestId === 'string' ? { requestId: item.requestId } : {}),
      createdAt: text(item.createdAt, 40), updatedAt: text(item.updatedAt, 40) });
  }
  if (Array.isArray(input.requests)) for (const item of input.requests as any[]) {
    const rule = ruleInput(item?.rule, true);
    if (!rule || typeof item.id !== 'string' || typeof item.sessionId !== 'string' || typeof item.cwd !== 'string') continue;
    state.requests.push({ id: item.id, status: item.status === 'approved' || item.status === 'denied' || item.status === 'withdrawn' ? item.status : 'pending', rule, reason: text(item.reason, 500), sessionId: item.sessionId,
      ...(typeof item.runId === 'string' ? { runId: item.runId } : {}), cwd: item.cwd, ...(item.provider === 'claude' || item.provider === 'codex' ? { provider: item.provider } : {}),
      createdAt: text(item.createdAt, 40), ...(typeof item.decidedAt === 'string' ? { decidedAt: item.decidedAt } : {}), ...(typeof item.ruleId === 'string' ? { ruleId: item.ruleId } : {}),
      ...(item.decidedBy === 'owner' || item.decidedBy === 'auto' ? { decidedBy: item.decidedBy } : {}), ...(reviewOf(item.review, item.status === 'pending' || item.status === undefined) ?? {}),
      ...(rule.kind === 'run' ? runFields(item) : {}) });
  }
  if (typeof input.lost === 'string') state.lost = input.lost;
  const review = input.autoReview as Partial<PermissionAutoReview> | undefined;
  if (review && typeof review === 'object') {
    const provider: PermissionProvider = review.provider === 'codex' ? 'codex' : 'claude';
    state.autoReview = { enabled: review.enabled === true, provider, model: typeof review.model === 'string' && AUTO_REVIEW_MODELS[provider].includes(review.model) ? review.model : AUTO_REVIEW_MODELS[provider][0]!,
      resume: review.resume !== false };
  }
  // A project file that lost its folder could no longer be checked before removal, so it is forgotten instead.
  if (Array.isArray(input.codex)) state.codex = (input.codex as any[]).filter(item => item && typeof item.path === 'string' && (item.scope !== 'project' || typeof item.cwd === 'string'))
    .map(item => item.scope === 'project' ? { path: item.path, scope: 'project' as const, cwd: item.cwd as string } : { path: item.path, scope: 'global' as const });
  return state;
}

/** The fields a run request keeps: its key, time limit and run. */
function runFields(item: any): Partial<PermissionRequest> {
  const run = item.run && typeof item.run === 'object' && ['waiting', 'running', 'done', 'failed'].includes(item.run.status) ? item.run as PermissionRun : undefined;
  return { ...(typeof item.key === 'string' ? { key: text(item.key, 300) } : {}), ...(item.keyExplicit === true ? { keyExplicit: true } : {}),
    ...(Number.isInteger(item.timeoutSeconds) ? { timeoutSeconds: Math.min(Math.max(1, item.timeoutSeconds), MAX_RUN_SECONDS) } : {}),
    ...(run ? { run: { status: run.status, ...(typeof run.startedAt === 'string' ? { startedAt: run.startedAt } : {}), ...(typeof run.finishedAt === 'string' ? { finishedAt: run.finishedAt } : {}),
      ...(Number.isInteger(run.pid) ? { pid: run.pid } : {}), ...(typeof run.started === 'string' ? { started: run.started } : {}), ...(Number.isInteger(run.exitCode) ? { exitCode: run.exitCode } : {}),
      ...(typeof run.signal === 'string' ? { signal: run.signal } : {}), ...(run.timedOut === true ? { timedOut: true } : {}), ...(Number.isInteger(run.stdoutBytes) ? { stdoutBytes: run.stdoutBytes } : {}),
      ...(Number.isInteger(run.stderrBytes) ? { stderrBytes: run.stderrBytes } : {}), ...(run.truncated === true ? { truncated: true } : {}), ...(typeof run.error === 'string' ? { error: text(run.error, 1000) } : {}),
      ...(run.delivered === true ? { delivered: true } : {}), ...(run.notify === true ? { notify: true } : {}), ...(typeof run.toldAt === 'string' ? { toldAt: run.toldAt } : {}),
      ...(run.preview && typeof run.preview === 'object' ? { preview: { stdout: text(run.preview.stdout, 4000), stderr: text(run.preview.stderr, 4000) } } : {}) } } : {}) };
}

/** A saved review; one that was running when the worker stopped is queued again, since its verdict was never applied. */
function reviewOf(value: any, pending: boolean): { review: PermissionReview } | undefined {
  if (!value || typeof value !== 'object' || !['queued', 'running', 'done', 'skipped', 'failed'].includes(value.status)) return undefined;
  const status: PermissionReview['status'] = value.status === 'running' ? (pending ? 'queued' : 'failed') : value.status;
  return { review: { status, ...(['approve', 'narrow', 'owner'].includes(value.verdict) ? { verdict: value.verdict } : {}), ...(typeof value.reason === 'string' ? { reason: text(value.reason, 1000) } : {}),
    ...(typeof value.suggestion === 'string' ? { suggestion: text(value.suggestion, 500) } : {}), ...(typeof value.model === 'string' ? { model: text(value.model, 64) } : {}),
    ...(typeof value.at === 'string' ? { at: text(value.at, 40) } : {}) } };
}
