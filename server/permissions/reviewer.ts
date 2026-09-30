import type { AutoPromptModelRequest } from '../auto-prompt/native.js';
import type { PermissionRequest } from '../../shared/permissions.js';
import { REVIEW_SCHEMA, REVIEW_SYSTEM, reviewInput, type ReviewSources } from './context.js';
import type { PermissionReviewResult, PermissionService } from './service.js';

export const REVIEW_TIMEOUT_MS = 3 * 60 * 1000;
/** After Tower could not record a review (a full disk, say), it waits this long before trying again. */
const RETRY_MS = 60 * 1000;

export interface PermissionReviewerOptions {
  service: PermissionService;
  sources: ReviewSources;
  model(request: AutoPromptModelRequest, options: { timeoutMs: number }): Promise<unknown>;
  /** Tells the requesting conversation what the reviewer decided, as the work it already was (never as the owner). */
  notify(request: PermissionRequest, message: string): Promise<void>;
  /** Whether a message can reach the requesting conversation; a request sent back to an agent nobody can tell waits for the owner. */
  reachable(request: PermissionRequest): boolean;
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
    try {
      const prompt = await reviewInput(request, this.options.sources);
      const answer = await this.options.model({ provider: settings.provider, model: settings.model, systemPrompt: REVIEW_SYSTEM, prompt,
        schema: REVIEW_SCHEMA as unknown as Record<string, unknown>, signal: controller.signal }, { timeoutMs: this.options.timeoutMs ?? REVIEW_TIMEOUT_MS });
      result = parse(answer, request, settings.model);
      // Sending the agent back only works when it hears about it; otherwise the owner decides.
      if (result.verdict === 'narrow' && (!settings.resume || !this.options.reachable(request))) {
        result = { ...result, verdict: 'owner', reason: `${result.reason} (더 좁게 요청하라고 전할 수 없어 소유자에게 넘깁니다${result.suggestion ? `. 제안: ${result.suggestion}` : ''})` };
      }
    } catch (error) {
      await service.failReview(request.id, this.aborted ? '자동 검토가 꺼졌습니다.' : controller.signal.aborted ? '자동 검토가 시간 안에 끝나지 않았습니다.' : (error instanceof Error ? error.message : String(error)).replace(/^Auto Prompt: /, ''));
      return;
    } finally { clearTimeout(timer); this.controller = undefined; }
    const outcome = await service.applyReview(request.id, result);
    if (outcome?.message && settings.resume) await this.options.notify(outcome.request, outcome.message).catch(error => {
      console.error(`Permission review could not reach its conversation: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

function parse(answer: unknown, request: PermissionRequest, model: string): PermissionReviewResult {
  if (!record(answer) || !['approve', 'narrow', 'owner'].includes(String(answer.verdict)) || typeof answer.reason !== 'string') throw new Error('검토 모델이 올바른 판단을 돌려주지 않았습니다.');
  const verdict = answer.verdict as PermissionReviewResult['verdict'];
  const value = typeof answer.rule === 'string' && answer.rule.trim() ? answer.rule.trim() : undefined;
  return { verdict, reason: answer.reason, model, ...(value ? { rule: { kind: request.rule.kind, value } } : {}),
    ...(typeof answer.suggestion === 'string' && answer.suggestion.trim() ? { suggestion: answer.suggestion.trim() } : {}) };
}
