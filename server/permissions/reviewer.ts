import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AutoPromptModelRequest, ReadTools } from '../auto-prompt/native.js';
import { autoReviewBlock, MAX_REVIEWED_FILES, type PermissionRequest, type ReviewedFile } from '../../shared/permissions.js';
import { writePrivateJson } from '../stores/private-json.js';
import { REVIEW_SCHEMA, REVIEW_SYSTEM, ReviewSkip, reviewInput, type ReviewSources } from './context.js';
import { changedFiles, deniedPaths, folderBinding, readLog, reviewedFiles, REVIEW_TOOL_NAMES, REVIEW_TOOLS_SERVER, reviewScope, type ReadEntry } from './inspect.js';
import type { PermissionReviewResult, PermissionService } from './service.js';

/** Long enough to read the scripts a command runs, and the ones they start, before deciding. */
const REVIEW_TIMEOUT_MS = 6 * 60 * 1000;
/** After Tower could not record a review (a full disk, say), it waits this long before trying again. */
const RETRY_MS = 60 * 1000;
/** Reviews started again because the owner's material changed meanwhile, before the owner decides instead. */
const MAX_REQUEUE = 3;

export interface PermissionReviewerOptions {
  service: PermissionService;
  sources: ReviewSources;
  model(request: AutoPromptModelRequest, options: { timeoutMs: number }): Promise<unknown>;
  /** Tells the requesting conversation what the reviewer decided, as the work it already was (never as the owner). */
  notify(request: PermissionRequest, message: string): Promise<void>;
  /** Whether a message can reach the requesting conversation; a request sent back to an agent nobody can tell waits for the owner. */
  reachable(request: PermissionRequest): boolean;
  /** The reviewer's read-only file tools: where their scratch files go, and how to start this build's tool server. */
  files?: { stateDir: string; server(scopePath: string): { command: string; args: string[] } };
  timeoutMs?: number;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Tower's permission reviewer: takes the requests waiting for it one at a time, asks the owner's chosen model with the
 * owner's instructions for that work, and hands the verdict to the permission service, which enforces the hard limits.
 * A worker handover never cuts a review short: new reviews stop starting, and the one under way finishes first.
 */
export class PermissionReviewer {
  private running?: Promise<void>;
  private held = false;
  private closed = false;
  private controller?: AbortController;
  private aborted = false;
  private retry?: ReturnType<typeof setTimeout>;
  private readonly requeued = new Map<string, number>();

  constructor(private readonly options: PermissionReviewerOptions) {}

  /** Starts the next waiting review unless one is under way or reviews are on hold. */
  wake(): void {
    if (this.running || this.held || this.closed || this.retry) return;
    const next = this.options.service.nextReview();
    if (!next) return;
    let failed = false;
    this.running = this.review(next).catch(error => { failed = true; console.error(`Permission review failed: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => {
        this.running = undefined;
        // A review Tower could not record stays queued: try again later, never in a tight loop.
        if (failed) { this.retry = setTimeout(() => { this.retry = undefined; this.wake(); }, RETRY_MS); this.retry.unref?.(); }
        else this.wake();
      });
  }

  inFlight(): boolean { return Boolean(this.running); }
  hold(): void { this.held = true; }
  release(): void { this.held = false; this.wake(); }
  /** Waits for the review under way. */
  async flush(): Promise<void> { await this.running; }
  /** Nothing new starts; a review still running is left to finish (the worker only closes when nothing is in flight). */
  close(): void { this.closed = true; this.held = true; if (this.retry) clearTimeout(this.retry); this.retry = undefined; }
  /** Owner turned reviews off: stop the model run under way; its request waits for the owner. */
  abort(): void { this.aborted = true; this.controller?.abort(); }

  private async review(request: PermissionRequest): Promise<void> {
    const { service } = this.options;
    if (!await service.startReview(request.id)) return;
    const settings = service.autoReview();
    const controller = new AbortController();
    this.controller = controller;
    this.aborted = false;
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? REVIEW_TIMEOUT_MS);
    let result: PermissionReviewResult;
    let scratch: string | undefined;
    try {
      // Credential stores and Tower's state stay out of the input as they stay out of the reviewer's reach.
      const denied = await deniedPaths(this.options.files?.stateDir);
      const prompt = await reviewInput(request, this.options.sources, denied);
      // What Tower read ahead for the reviewer: bound with its folders below, before the model reads anything.
      const given = (JSON.parse(prompt).context.commandEvidence?.files ?? []) as { path: string; status: string; real?: string; sha256?: string; text?: string }[];
      const pre = given.filter(file => file.status === 'read' && file.real && file.sha256);
      // Folders bound by their entries (under the name they were reached by), by their absence, or failed (unbound).
      const bindFolders = async (folders: { path: string; real: string | null }[]) => {
        const bound = await Promise.all(folders.map(async folder => ({ folder, file: folder.real === null ? { path: folder.path, real: null, sha256: null } as ReviewedFile
          : await folderBinding(folder.real, denied).then(file => file && file !== 'shared' ? { ...file, path: folder.path } : file) })));
        return { files: bound.flatMap(item => item.file && item.file !== 'shared' ? [item.file] : []), failed: bound.flatMap(item => item.file ? [] : [item.folder.path]) };
      };
      const ownFolders = [...new Set(pre.map(file => dirname(file.real!)))].map(folder => ({ path: folder, real: folder }));
      let watch: { path: string; real: string | null }[] = [];
      const material = (input: string) => { const value = JSON.parse(input); return JSON.stringify([value.authority, value.context.commandEvidence]); };
      const before = material(prompt);
      const model = await service.reviewModel();
      let readTools: ReadTools | undefined;
      let log: string | undefined;
      let places: ReviewedFile[] = [];
      if (this.options.files) {
        const tmp = join(this.options.files.stateDir, 'tmp');
        await mkdir(tmp, { recursive: true, mode: 0o700 });
        scratch = await mkdtemp(join(tmp, 'permission-review-'));
        log = join(scratch, 'reads.jsonl');
        const scope = join(scratch, 'scope.json');
        const evidence = pre.flatMap(file => file.text !== undefined ? [{ path: file.real!, text: file.text }] : []);
        const spec = await reviewScope({ cwd: request.cwd, ...(request.rule.kind === 'claude' ? {} : { command: request.rule.value }), stateDir: this.options.files.stateDir, log, evidence });
        watch = spec.watch ?? [];
        await writePrivateJson(scope, JSON.stringify(spec));
        // The folders the command runs in lead where they led during the review (a `current` link moved meanwhile is a change).
        places = (spec.places ?? []).map(place => ({ path: place.path, real: place.real, sha256: null }));
        readTools = { server: REVIEW_TOOLS_SERVER, tools: REVIEW_TOOL_NAMES, ...this.options.files.server(scope) };
      }
      // The folders of the scripts Tower read ahead and of the module names they use, as they are before the model reads.
      const preFolders = await bindFolders([...ownFolders, ...watch]);
      const answer = await this.options.model({ ...model, systemPrompt: REVIEW_SYSTEM, prompt, ...(readTools ? { readTools } : {}),
        schema: REVIEW_SCHEMA as unknown as Record<string, unknown>, signal: controller.signal }, { timeoutMs: this.options.timeoutMs ?? REVIEW_TIMEOUT_MS });
      result = parse(answer, request, model.model ?? model.provider);
      // What the decision rests on: the files Tower gave and the files the reviewer read, as they were then.
      const reads = log ? await readLog(log) : [];
      // Tower's own reads, with their folders as the reviewer's reads have.
      const seen: ReviewedFile[] = [...places, ...pre.map(file => ({ path: file.path, real: file.real!, sha256: file.sha256! })), ...preFolders.files, ...reviewedFiles(reads)];
      const unbound = [...new Set([...preFolders.failed, ...reads.filter(entry => entry.status === 'unbound').map(entry => entry.path)])];
      // The owner said more, or confirmed or changed something, or a file changed, while the model answered: review again with that.
      // Files bind only a run's approval; a rule is kept for good and checked against what it allows, not those files.
      const changed = request.rule.kind === 'run' ? await changedFiles(seen, denied) : [];
      if (material(await reviewInput(request, this.options.sources, denied)) !== before || changed.length) {
        const again = (this.requeued.get(request.id) ?? 0) + 1;
        this.requeued.set(request.id, again);
        // Decided by the owner meanwhile: nothing to review again; the verdict is only recorded below.
        if (again <= MAX_REQUEUE && await service.requeueReview(request.id)) return;
        if (again > MAX_REQUEUE) throw new ReviewSkip(`검토하는 동안 지시 또는 참조 파일이 계속 바뀌어 소유자에게 넘깁니다${changed.length ? `: ${changed.slice(0, 5).join(', ')}` : ''}.`);
      }
      const files = [...new Map(seen.map(file => [`${file.path}\0${file.sha256 === null && file.real !== null ? 'place' : file.depth ?? 0}`, file])).values()];
      if (result.verdict === 'owner') result = { ...result, reason: ownerReason(result.reason, result.missing ?? [], reads) };
      else if (result.verdict === 'approve' && request.rule.kind === 'run') {
        // The run starts only while these are still what was reviewed (checked again right before it starts).
        if (files.length > MAX_REVIEWED_FILES) result = { ...result, verdict: 'owner', reason: `${result.reason} (검토한 파일이 너무 많아 실행 직전에 같은 내용인지 확인할 수 없어 소유자에게 넘깁니다)` };
        else if (unbound.length) result = { ...result, verdict: 'owner', reason: `${result.reason} (검토한 코드가 있는 폴더의 목록을 확인할 수 없어 실행 직전에 같은 코드인지 확인할 수 없습니다: ${unbound.slice(0, 5).join(', ')})` };
        else result = { ...result, files };
      }
      if (result.verdict === 'approve' && request.rule.kind === 'command') {
        const limit = autoReviewBlock({ kind: 'command', value: result.rule?.value ?? request.rule.value }, request.cwd);
        const unsupported = result.scope === 'conversation' && (request.provider === 'codex' || request.rule.providers.includes('codex'));
        if (limit || unsupported) result = { ...result, verdict: 'narrow',
          reason: `${result.reason} (${limit ?? 'Codex는 대화 한정 규칙을 지원하지 않습니다.'})`,
          suggestion: `Ask permissions_run for the exact command needed for this task, with every argument; no lasting rule is required.` };
      }
      // Sending the agent back only works when it hears about it; otherwise the owner decides.
      if (result.verdict === 'narrow' && (!settings.resume || !this.options.reachable(request))) {
        result = { ...result, verdict: 'owner', reason: `${result.reason} (더 좁게 요청하라고 전할 수 없어 소유자에게 넘깁니다${result.suggestion ? `. 제안: ${result.suggestion}` : ''})` };
      }
    } catch (error) {
      this.requeued.delete(request.id);
      if (error instanceof ReviewSkip) { await service.failReview(request.id, error.message, 'skipped'); return; }
      await service.failReview(request.id, this.aborted ? '자동 검토가 꺼졌습니다.' : controller.signal.aborted ? '자동 검토가 시간 안에 끝나지 않았습니다.' : (error instanceof Error ? error.message : String(error)).replace(/^Auto Prompt: /, ''));
      return;
    } finally {
      clearTimeout(timer); this.controller = undefined;
      // best-effort: a leftover scratch folder under <state>/tmp holds only this review's scope and read log
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
    const outcome = await service.applyReview(request.id, result);
    this.requeued.delete(request.id);
    // The owner may have turned the notice off meanwhile: a request sent back that nobody tells returns to the owner.
    if (outcome?.request.status === 'withdrawn' && !service.autoReview().resume) { await service.reopenForOwner(outcome.request.id, '에이전트에게 전하지 않도록 설정돼 소유자에게 넘깁니다'); return; }
    if (outcome?.message && service.autoReview().resume) await service.deliverNotification(outcome.request.id, this.options.notify).catch(async error => {
      console.error(`Permission review could not reach its conversation: ${error instanceof Error ? error.message : String(error)}`);
      // An agent never told to ask again would wait for good: the owner decides instead.
      if (outcome.request.status === 'withdrawn') await service.reopenForOwner(outcome.request.id, '에이전트에게 전하지 못해 소유자에게 넘깁니다');
    });
  }
}

/** An owner verdict says what could not be confirmed: the reviewer's own list and the reads Tower refused or could not do. */
function ownerReason(reason: string, missing: string[], reads: ReadEntry[]): string {
  const refused = [...new Set(reads.filter(entry => !['read', 'listed', 'searched', 'place', 'folder', 'absent', 'unbound'].includes(entry.status)).map(entry => `${entry.path} (${READ_STATUS[entry.status] ?? entry.status})`))];
  return [reason.trim(), missing.length ? `확인하지 못한 근거: ${missing.join('; ')}` : '', refused.length ? `읽지 못한 파일: ${refused.slice(0, 10).join(', ')}${refused.length > 10 ? ` 외 ${refused.length - 10}개` : ''}` : '']
    .filter(Boolean).join(' / ');
}

const READ_STATUS: Record<string, string> = { outside: '검토 범위 밖', denied: '비밀·Tower 상태라 읽지 않음', missing: '없음', unreadable: '열 수 없음(권한)', 'too-large': '너무 큼', 'not-text': '텍스트 아님', budget: '읽기 한도 초과', invalid: '잘못된 경로' };

function parse(answer: unknown, request: PermissionRequest, model: string): PermissionReviewResult {
  if (!record(answer) || !['approve', 'narrow', 'owner'].includes(String(answer.verdict)) || typeof answer.reason !== 'string') throw new Error('검토 모델이 올바른 판단을 돌려주지 않았습니다.');
  const verdict = answer.verdict as PermissionReviewResult['verdict'];
  // A run is judged as asked: it is never rewritten.
  const value = request.rule.kind !== 'run' && typeof answer.rule === 'string' && answer.rule.trim() ? answer.rule.trim() : undefined;
  const scope = request.rule.kind !== 'run' && (answer.scope === 'conversation' || answer.scope === 'project') ? answer.scope : undefined;
  const missing = Array.isArray(answer.missing) ? answer.missing.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim().slice(0, 300)).slice(0, 10) : [];
  return { verdict, reason: answer.reason, model, ...(value ? { rule: { kind: request.rule.kind, value } } : {}), ...(scope ? { scope } : {}), ...(missing.length ? { missing } : {}),
    ...(typeof answer.suggestion === 'string' && answer.suggestion.trim() ? { suggestion: answer.suggestion.trim() } : {}) };
}
