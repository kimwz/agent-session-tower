import { randomUUID } from 'node:crypto';
import type { RunApproval } from '../shared/types.js';
import { SteeringError } from './steering.js';

type Message = Record<string, unknown>;
type Pending = { requestId: string; approval: RunApproval; serializedInput: string; toolUseId?: string };
const record = (value: unknown): value is Message => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const failed = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

interface ClaudeControlOptions {
  write(message: Message): Promise<void>;
  onApproval(approval: RunApproval): void;
  onCancelled(id: string): void;
  onError(error: Error): void;
  initializeTimeoutMs?: number;
  steerTimeoutMs?: number;
}

/** Native stream-json control protocol, with one explicit decision per request. */
export class ClaudeControl {
  private readonly initializeId = `tower-init-${randomUUID()}`;
  private readonly pending = new Map<string, Pending>();
  private readonly settled = new Set<string>();
  private input?: Message;
  private closed = false;
  private initialized = false;
  private timer?: ReturnType<typeof setTimeout>;
  private sessionId?: string;
  private readonly steers = new Map<string, { sessionId: string; resolve(): void; reject(error: SteeringError): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly submittedSteers = new Set<string>();

  constructor(private readonly options: ClaudeControlOptions) {}

  start(input: Message): void {
    this.input = input;
    this.sessionId = typeof input.session_id === 'string' ? input.session_id : undefined;
    this.timer = setTimeout(() => this.fail(new Error('Claude Code did not initialize its permission connection. No instruction was submitted.')), this.options.initializeTimeoutMs ?? 15_000);
    this.timer.unref();
    void this.send({ type: 'control_request', request_id: this.initializeId, request: { subtype: 'initialize' } });
  }

  handle(event: Message): boolean {
    if (event.type === 'user' && event.isReplay === true && typeof event.uuid === 'string') {
      const pending = this.steers.get(event.uuid);
      if (pending && event.session_id === pending.sessionId && event.parent_tool_use_id == null) {
        clearTimeout(pending.timer); this.steers.delete(event.uuid); pending.resolve(); return true;
      }
    }
    if (event.type !== 'control_response' && event.type !== 'control_request' && event.type !== 'control_cancel_request') return false;
    if (this.closed) return true;
    if (event.type === 'control_response') {
      const response = event.response;
      if (!record(response) || response.request_id !== this.initializeId) return true;
      if (this.initialized) return true;
      if (response.subtype !== 'success') { this.fail(new Error('Claude Code could not initialize its permission connection. No instruction was submitted.')); return true; }
      this.initialized = true;
      if (this.timer) clearTimeout(this.timer);
      const input = this.input; this.input = undefined;
      if (input) void this.send(input);
      return true;
    }
    if (event.type === 'control_cancel_request') {
      if (typeof event.request_id === 'string') {
        const pending = this.pending.get(event.request_id);
        if (pending) this.remove(pending);
      }
      return true;
    }
    const requestId = event.request_id;
    const request = event.request;
    if (!validId(requestId) || !record(request)) { this.fail(new Error('Claude Code sent an invalid permission request.')); return true; }
    if (request.subtype !== 'can_use_tool') {
      // No SDK hooks or user-dialog handlers were registered by initialize.
      // A cancelled dialog is an explicit non-answer; an error-shaped response
      // can leave newer Claude versions waiting forever for a human answer.
      if (request.subtype === 'request_user_dialog') void this.send({ type: 'control_response', response: {
        subtype: 'success', request_id: requestId, response: { behavior: 'cancelled' },
      } });
      else void this.send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'This host does not support this control request.' } });
      return true;
    }
    if (!this.initialized || !validId(request.tool_name) || !record(request.input)) {
      this.fail(new Error('Claude Code sent an invalid tool permission request.')); return true;
    }
    const input = JSON.stringify(request.input);
    const existing = this.pending.get(requestId);
    if (existing) {
      if (existing.approval.toolName !== request.tool_name || existing.serializedInput !== input) this.fail(new Error('Claude Code changed a pending permission request. Nothing was approved.'));
      return true;
    }
    if (this.settled.has(requestId)) { this.fail(new Error('Claude Code repeated a permission request that was already settled. Nothing was approved again.')); return true; }
    const total = [...this.pending.values()].reduce((sum, item) => sum + Buffer.byteLength(item.serializedInput), 0);
    if (Buffer.byteLength(input) > 64_000 || total + Buffer.byteLength(input) > 256_000 || this.pending.size >= 8) {
      this.fail(new Error('Claude Code sent too many or oversized permission requests. Nothing was approved.')); return true;
    }
    const approval: RunApproval = { id: requestId, toolName: request.tool_name, input: JSON.parse(input),
      ...(typeof request.description === 'string' ? { description: request.description.slice(0, 2000) } : {}) };
    this.pending.set(requestId, { requestId, approval, serializedInput: input,
      ...(validId(request.tool_use_id) ? { toolUseId: request.tool_use_id } : {}) });
    this.options.onApproval(structuredClone(approval));
    return true;
  }

  async respond(id: string, decision: 'allow' | 'deny'): Promise<void> {
    if (decision !== 'allow' && decision !== 'deny') throw failed('Choose allow or deny for this permission request.');
    const pending = this.pending.get(id);
    if (this.closed || !pending) throw failed('This permission request is no longer pending. Refresh the conversation.');
    // Claim synchronously before writing so repeated clicks cannot answer twice.
    this.remove(pending);
    const response = decision === 'allow'
      ? { behavior: 'allow', updatedInput: JSON.parse(pending.serializedInput), ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}) }
      : { behavior: 'deny', message: 'The user denied this tool request in Agent Session Tower.', ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}) };
    try {
      await this.options.write({ type: 'control_response', response: { subtype: 'success', request_id: pending.requestId, response } });
    } catch {
      const error = failed('Claude Code disconnected while the permission response was being sent. It was not sent again.');
      this.fail(error); throw error;
    }
  }

  canSteer(): boolean { return this.initialized && !this.closed; }

  hasPendingSteers(): boolean { return this.steers.size > 0; }

  steer(input: Message): Promise<void> {
    const id = input.uuid;
    if (!this.canSteer() || !validId(id) || !validId(this.sessionId) || input.session_id !== this.sessionId
      || input.type !== 'user' || input.parent_tool_use_id != null || !record(input.message) || input.message.role !== 'user') {
      return Promise.reject(new SteeringError('Claude Code is not ready to receive this instruction in the running conversation.', 'rejected'));
    }
    if (this.submittedSteers.has(id)) return Promise.reject(new SteeringError('This instruction was already submitted and will not be sent again.', 'uncertain'));
    this.submittedSteers.add(id);
    // Register before write: a replay can arrive before the write callback.
    return new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        const pending = this.steers.get(id);
        if (!pending) return;
        clearTimeout(pending.timer); this.steers.delete(id);
        reject(new SteeringError(message, 'uncertain'));
      };
      const timer = setTimeout(() => fail('Claude Code has not acknowledged this instruction. Delivery is uncertain; it will not be sent again automatically.'), this.options.steerTimeoutMs ?? 15_000);
      timer.unref();
      this.steers.set(id, { sessionId: this.sessionId!, resolve, reject, timer });
      // "now" interrupts the native turn; "next" folds into its next processing checkpoint.
      try {
        void this.options.write({ ...input, priority: 'next' }).catch(() => fail('Claude Code disconnected while the instruction was being sent. Delivery is uncertain.'));
      } catch { fail('Claude Code disconnected while the instruction was being sent. Delivery is uncertain.'); }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.input = undefined;
    for (const pending of this.steers.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SteeringError('Claude Code closed before acknowledging the instruction. Delivery is uncertain.', 'uncertain'));
    }
    this.steers.clear();
    if (this.timer) clearTimeout(this.timer);
    for (const pending of this.pending.values()) this.options.onCancelled(pending.approval.id);
    this.pending.clear(); this.settled.clear();
  }

  private remove(pending: Pending): void {
    this.pending.delete(pending.requestId);
    this.settled.add(pending.requestId);
    if (this.settled.size > 1000) this.settled.delete(this.settled.values().next().value!);
    this.options.onCancelled(pending.approval.id);
  }
  private async send(message: Message): Promise<void> {
    if (this.closed) return;
    try { await this.options.write(message); }
    catch { this.fail(new Error('Claude Code disconnected from its permission input channel.')); }
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.close(); this.options.onError(error);
  }
}
