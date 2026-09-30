import { randomUUID } from 'node:crypto';
import { resolveModel } from '../models/settings.js';
import type { ResolvedModel } from '../../shared/models.js';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_AUTO_REVIEW, autoReviewBlock, waitingForOwner, claudeRule, codexRule, normalizeCommand, ruleGuards, ruleIsNarrower, rulesOverlap, ruleProblem, sameRule,
  type PermissionAutoReview, type PermissionOverview, type PermissionProvider, type PermissionRequest, type PermissionReview, type PermissionReviewVerdict,
  type PermissionRule, type PermissionRuleInput, type PermissionTarget,
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
  claudeSettings(cwd: string): string | undefined {
    const rules = this.state.rules.filter(rule => rule.providers.includes('claude') && (rule.scope === 'global' || within(cwd, rule.cwd!)));
    const allow = [...new Set(rules.map(claudeRule))];
    // A rule the reviewer allowed never covers its family's destructive variants: deny comes before allow.
    const deny = [...new Set(rules.filter(rule => rule.source === 'auto').flatMap(rule => ruleGuards(rule).claude))];
    return allow.length ? JSON.stringify({ permissions: { allow, ...(deny.length ? { deny } : {}) } }) : undefined;
  }

  autoReview(): PermissionAutoReview { return { ...(this.state.autoReview ?? DEFAULT_AUTO_REVIEW) }; }
  /** The reviewer's provider and model come from the `permissions.reviewer` role (Settings › Models). */
  reviewModel(): Promise<ResolvedModel> { return resolveModel(this.options.stateDir, 'permissions.reviewer'); }

  /** The owner turns the reviewer on or off (its model is chosen in Settings › Models). Turning it off leaves waiting requests to the owner. */
  saveAutoReview(input: PermissionAutoReview): Promise<PermissionOverview> {
    return this.serial(async () => {
      const { provider, model } = this.autoReview();
      const settings: PermissionAutoReview = { enabled: input.enabled, resume: input.resume, ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
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
      const model = await this.reviewModel().then(resolved => resolved.model ?? resolved.provider, () => undefined);
      await this.setReview(id, { status: 'running', ...(model ? { model } : {}), at: this.now() });
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
      if (result.verdict === 'approve') {
        const asked = request.rule;
        let given: PermissionRuleInput;
        try {
          given = clean({ kind: result.rule?.kind ?? asked.kind, value: result.rule?.value ?? asked.value, providers: result.rule?.providers?.length ? result.rule.providers : asked.providers,
            scope: 'project', cwd: request.cwd, note: `자동 승인: ${reason}`.slice(0, 500) });
          given = await this.checked(given);
        } catch (error) { return owner(error instanceof Error ? error.message : String(error)); }
        const block = autoReviewBlock(given, request.cwd);
        if (block) return owner(block);
        // Where the owner has a rule of their own that overlaps (`git push --force-with-lease` beside `git push`), the
        // deny rules of an allowed one would override theirs, and theirs could widen it: the owner decides.
        if (this.state.rules.some(item => item.source !== 'auto' && item.kind === given.kind
          && (item.scope === 'global' || within(request.cwd, item.cwd!) || within(item.cwd!, request.cwd))
          && (given.kind === 'command' ? rulesOverlap(item.value, given.value) : sameRule({ ...item, scope: 'global' }, { ...given, scope: 'global' })))) {
          return owner('겹치는 소유자 규칙이 이미 있습니다');
        }
        if (!ruleIsNarrower({ ...asked, ...(asked.scope === 'global' ? { scope: 'project', cwd: request.cwd } : {}) }, given)) return owner('검토기가 요청보다 넓은 규칙을 냈습니다');
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
      rules: this.state.rules.filter(rule => rule.scope === 'global' || rule.cwd === folder).map(rule => ({ id: rule.id, kind: rule.kind, value: rule.value, providers: rule.providers, scope: rule.scope, ...(rule.cwd ? { cwd: rule.cwd } : {}) })),
      requests: this.state.requests.filter(request => caller.sessionId && request.sessionId === caller.sessionId).slice(-20).reverse()
        .map(request => ({ id: request.id, status: request.status, rule: request.rule, createdAt: request.createdAt, ...(request.decidedAt ? { decidedAt: request.decidedAt } : {}),
          ...(request.decidedBy ? { decidedBy: request.decidedBy } : {}),
          ...(request.review ? { review: { status: request.review.status, ...(request.review.verdict ? { verdict: request.review.verdict } : {}), ...(request.review.reason ? { reason: request.review.reason } : {}),
            ...(request.review.suggestion ? { suggestion: request.review.suggestion } : {}) } } : {}) })),
    };
  }

  /** An agent asks the owner for a rule. The same pending request is returned again rather than repeated. */
  request(input: { kind: PermissionRuleInput['kind']; value: string; providers?: PermissionProvider[]; scope: PermissionRuleInput['scope']; reason: string }, caller: PermissionCaller) {
    return this.serial(async () => {
      if (caller.controllerId) throw failure('다른 컴퓨터에서 시작한 작업은 이 컴퓨터의 권한을 요청할 수 없습니다.', 403);
      const session = caller.sessionId ? this.options.session(caller.sessionId) : undefined;
      if (!caller.sessionId || !session?.cwd) throw failure('권한 요청은 Tower에서 시작한 대화에서만 보낼 수 있습니다.', 403);
      const provider: PermissionProvider = session.provider === 'codex' ? 'codex' : 'claude';
      const rule = await this.checked(clean({ kind: input.kind, value: input.value, providers: input.kind === 'claude' ? ['claude'] : input.providers ?? [provider], scope: input.scope,
        ...(input.scope === 'project' ? { cwd: session.cwd } : {}) }));
      // A rule for every project, or for this project, already covers what a project request asks for.
      const covering = this.state.rules.filter(existing => sameRule({ ...existing, scope: rule.scope, cwd: rule.cwd }, rule) && (existing.scope === 'global' || (rule.scope === 'project' && existing.cwd === rule.cwd)));
      if (rule.providers.every(item => covering.some(existing => existing.providers.includes(item)))) return { request: { status: 'exists' as const }, note: 'This rule is already allowed. Try the action again; a Codex rule applies from the next turn.' };
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

  /** The owner has seen that an earlier record was set aside. */
  acknowledge(): Promise<PermissionOverview> {
    return this.serial(async () => { await this.commit(state => { delete state.lost; }); return this.overview(); });
  }

  /** The owner adds a rule, or changes one. */
  save(input: PermissionRuleInput & { id?: string }): Promise<PermissionOverview> {
    return this.serial(async () => {
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
    const { request, rule } = await this.serial(async () => {
      const request = this.state.requests.find(item => item.id === id);
      if (!request) throw failure('요청을 찾지 못했습니다.', 404);
      if (request.status !== 'pending') throw failure('이미 처리한 요청입니다.', 409);
      const at = this.now();
      if (!approve) {
        await this.commit(state => { const item = state.requests.find(entry => entry.id === id)!; item.status = 'denied'; item.decidedAt = at; item.decidedBy = 'owner'; });
        return { request, rule: undefined };
      }
      const rule = await this.checked(clean(edited ?? request.rule));
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
    this.state = next;
  }

  /** Every Codex rules file Tower writes, with the lines it should hold now. */
  private desired(): Map<string, { scope: PermissionRule['scope']; cwd?: string; lines: string[] }> {
    const files = new Map<string, { scope: PermissionRule['scope']; cwd?: string; lines: string[] }>();
    // The file for every project is always checked, so rules left there by a record that could not be read are removed.
    if (this.options.globalCodex !== false) files.set(codexRulesPath('global', undefined, this.options.env), { scope: 'global', lines: [] });
    for (const rule of this.state.rules) {
      if (rule.kind !== 'command' || !rule.providers.includes('codex')) continue;
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
  const where = (rule: PermissionRuleInput) => rule.scope === 'global' ? 'every project' : 'this project';
  if (!allowed) return `The owner refused your permission request for \`${asked.value}\` in Tower. Do not look for another way to do it: finish what you can without it and report what remains blocked.`;
  const changed = allowed.value !== asked.value || allowed.scope !== asked.scope || allowed.kind !== asked.kind;
  return `The owner allowed \`${allowed.value}\` for ${allowed.providers.map(provider => provider === 'claude' ? 'Claude Code' : 'Codex').join(' and ')} in ${where(allowed)}`
    + `${changed ? ` (you asked for \`${asked.value}\` in ${where(asked)})` : ''}. It applies from this turn. Continue the task where it waited on this permission.`;
}

/** What the requesting agent is told after Tower's reviewer allowed its request or sent it back. */
function reviewMessage(request: PermissionRequest, allowed?: PermissionRuleInput): string {
  const why = request.review?.reason ? ` Reason: ${request.review.reason}` : '';
  if (allowed) {
    const changed = allowed.value !== request.rule.value || request.rule.scope !== 'project';
    return `Tower's permission reviewer allowed \`${allowed.value}\` for ${allowed.providers.map(provider => provider === 'claude' ? 'Claude Code' : 'Codex').join(' and ')} in this project`
      + `${changed ? ` (you asked for \`${request.rule.value}\`${request.rule.scope === 'global' ? ' in every project' : ''})` : ''}.${why} It applies from this turn. Continue the task where it waited on this permission.`;
  }
  const instead = request.review?.suggestion ? ` Ask for this instead: ${request.review.suggestion}` : ' Ask for a narrower rule that covers only what the task needs.';
  return `Tower's permission reviewer did not allow \`${request.rule.value}\` as asked, and withdrew the request.${why}${instead} If the task still needs it, send a new permissions_request; do not look for another way around the refusal.`;
}

const REVIEW_NOTE = 'Tower\'s permission reviewer checks this request against the owner\'s instructions for this task first; the owner can also decide it. Do not look for another way around the refusal. An allowed rule applies from your next turn: say in your reply what waits on this permission and end your turn, or go on with other work first. The decision is sent to this conversation; permissions_list also shows it.';

const WAIT_NOTE = 'The owner decides this in Tower. Do not look for another way around the refusal. An allowed rule applies from your next turn: say in your reply what waits on this permission and end your turn, or go on with other work first. The owner can send the decision to this conversation; permissions_list also shows it.';


/** A folder that is the project or inside it. */
const within = (cwd: string, project: string) => cwd === project || cwd.startsWith(project.endsWith('/') ? project : `${project}/`);

function clean(input: PermissionRuleInput): PermissionRuleInput {
  const value = input.kind === 'command' ? normalizeCommand(input.value) : input.value.trim();
  const providers: PermissionProvider[] = input.kind === 'claude' ? ['claude'] : (['claude', 'codex'] as const).filter(item => input.providers.includes(item));
  const rule: PermissionRuleInput = { kind: input.kind, value, providers, scope: input.scope, ...(input.scope === 'project' && input.cwd ? { cwd: input.cwd.replace(/\/+$/, '') || '/' } : {}),
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, 500) } : {}) };
  const problem = ruleProblem({ ...rule, value: input.kind === 'command' ? input.value : value });
  if (problem) throw failure(problem);
  return rule;
}

/**
 * The owner's own rule where the reviewer allowed an overlapping one (`git push --force-with-lease` beside `git push`):
 * the reviewer's rule would deny what the owner allows, so it goes. Agents ask again, and the owner decides those.
 */
function dropOverlappingAuto(state: PermissionState, rule: PermissionRule): string[] {
  const overlaps = (item: PermissionRule) => item.id !== rule.id && item.source === 'auto' && item.kind === 'command' && rule.kind === 'command' && rulesOverlap(item.value, rule.value)
    && (rule.scope === 'global' || item.scope === 'global' || within(item.cwd!, rule.cwd!) || within(rule.cwd!, item.cwd!));
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
    return same;
  }
  if (state.rules.length >= MAX_RULES) throw failure('규칙은 200개까지 저장할 수 있습니다.', 409);
  const made: PermissionRule = { ...rule, id: randomUUID(), source, ...(requestId ? { requestId } : {}), createdAt: at, updatedAt: at };
  state.rules.push(made);
  return made;
}

function trim(state: PermissionState, now: Date): void {
  const cutoff = now.getTime() - DECIDED_DAYS * 24 * 60 * 60 * 1000;
  const decided = state.requests.filter(request => request.status !== 'pending' && Date.parse(request.decidedAt ?? request.createdAt) >= cutoff).slice(-MAX_DECIDED);
  const keep = new Set(decided);
  state.requests = state.requests.filter(request => request.status === 'pending' || keep.has(request));
}

const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';

function normalize(value: unknown): PermissionState {
  const input = value && typeof value === 'object' ? value as Partial<PermissionState> : {};
  const state = empty();
  const ruleInput = (item: any): PermissionRuleInput | undefined => {
    if (!item || (item.kind !== 'command' && item.kind !== 'claude') || typeof item.value !== 'string') return undefined;
    const providers = (['claude', 'codex'] as const).filter(provider => Array.isArray(item.providers) && item.providers.includes(provider));
    // A project rule that lost its folder is dropped, never widened to every project.
    if (item.scope === 'project' && typeof item.cwd !== 'string') return undefined;
    const rule: PermissionRuleInput = { kind: item.kind, value: text(item.value, 400), providers, scope: item.scope === 'project' ? 'project' : 'global',
      ...(item.scope === 'project' && typeof item.cwd === 'string' ? { cwd: item.cwd } : {}), ...(typeof item.note === 'string' ? { note: text(item.note, 500) } : {}) };
    return ruleProblem(rule) ? undefined : rule;
  };
  if (Array.isArray(input.rules)) for (const item of input.rules as any[]) {
    const rule = ruleInput(item);
    if (rule && typeof item.id === 'string') state.rules.push({ ...rule, id: item.id, source: item.source === 'request' || item.source === 'auto' ? item.source : 'owner', ...(typeof item.requestId === 'string' ? { requestId: item.requestId } : {}),
      createdAt: text(item.createdAt, 40), updatedAt: text(item.updatedAt, 40) });
  }
  if (Array.isArray(input.requests)) for (const item of input.requests as any[]) {
    const rule = ruleInput(item?.rule);
    if (!rule || typeof item.id !== 'string' || typeof item.sessionId !== 'string' || typeof item.cwd !== 'string') continue;
    state.requests.push({ id: item.id, status: item.status === 'approved' || item.status === 'denied' || item.status === 'withdrawn' ? item.status : 'pending', rule, reason: text(item.reason, 500), sessionId: item.sessionId,
      ...(typeof item.runId === 'string' ? { runId: item.runId } : {}), cwd: item.cwd, ...(item.provider === 'claude' || item.provider === 'codex' ? { provider: item.provider } : {}),
      createdAt: text(item.createdAt, 40), ...(typeof item.decidedAt === 'string' ? { decidedAt: item.decidedAt } : {}), ...(typeof item.ruleId === 'string' ? { ruleId: item.ruleId } : {}),
      ...(item.decidedBy === 'owner' || item.decidedBy === 'auto' ? { decidedBy: item.decidedBy } : {}), ...(reviewOf(item.review, item.status === 'pending' || item.status === undefined) ?? {}) });
  }
  if (typeof input.lost === 'string') state.lost = input.lost;
  const review = input.autoReview as Partial<PermissionAutoReview> | undefined;
  if (review && typeof review === 'object') {
    state.autoReview = { enabled: review.enabled === true, resume: review.resume !== false,
      ...(review.provider === 'claude' || review.provider === 'codex' ? { provider: review.provider } : {}),
      ...(typeof review.model === 'string' && review.model.length <= 64 ? { model: review.model } : {}) };
  }
  // A project file that lost its folder could no longer be checked before removal, so it is forgotten instead.
  if (Array.isArray(input.codex)) state.codex = (input.codex as any[]).filter(item => item && typeof item.path === 'string' && (item.scope !== 'project' || typeof item.cwd === 'string'))
    .map(item => item.scope === 'project' ? { path: item.path, scope: 'project' as const, cwd: item.cwd as string } : { path: item.path, scope: 'global' as const });
  return state;
}

/** A saved review; one that was running when the worker stopped is queued again, since its verdict was never applied. */
function reviewOf(value: any, pending: boolean): { review: PermissionReview } | undefined {
  if (!value || typeof value !== 'object' || !['queued', 'running', 'done', 'skipped', 'failed'].includes(value.status)) return undefined;
  const status: PermissionReview['status'] = value.status === 'running' ? (pending ? 'queued' : 'failed') : value.status;
  return { review: { status, ...(['approve', 'narrow', 'owner'].includes(value.verdict) ? { verdict: value.verdict } : {}), ...(typeof value.reason === 'string' ? { reason: text(value.reason, 1000) } : {}),
    ...(typeof value.suggestion === 'string' ? { suggestion: text(value.suggestion, 500) } : {}), ...(typeof value.model === 'string' ? { model: text(value.model, 64) } : {}),
    ...(typeof value.at === 'string' ? { at: text(value.at, 40) } : {}) } };
}
