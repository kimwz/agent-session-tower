import type { RunApproval, RunApprovalResponse } from '../../shared/types.js';

export interface OwnerAnswer { at: string; question: string; answer: string }

/**
 * What the owner answered the agent's questions in a conversation, kept from the moment it is sent: native history
 * may not have it yet when Tower's permission reviewer reads the owner's words. Memory only, the last 50 per
 * conversation; a plain allow or deny is not an answer and is not kept.
 */
export class OwnerAnswers {
  private readonly answers = new Map<string, OwnerAnswer[]>();

  record(sessionId: string, asked: RunApproval, decision: RunApprovalResponse): void {
    if (typeof decision !== 'object') return;
    const question = JSON.stringify(asked.interaction?.type === 'questions' ? asked.interaction.questions : asked.input);
    this.answers.set(sessionId, [...this.answers.get(sessionId) ?? [], { at: new Date().toISOString(), question, answer: JSON.stringify(decision) }].slice(-50));
  }

  list(sessionId: string): OwnerAnswer[] { return [...this.answers.get(sessionId) ?? []]; }
}
