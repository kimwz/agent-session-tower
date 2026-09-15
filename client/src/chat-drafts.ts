import type { DraftAttachment } from './chat-attachments';

export interface ChatDraft { prompt: string; attachments: DraftAttachment[] }
interface ComposerState { draft: ChatDraft; stage?: 'preparing' | 'sending'; error: string }
const emptyDraft = (): ChatDraft => ({ prompt: '', attachments: [] });
const emptyState: ComposerState = { draft: emptyDraft(), error: '' };
const states = new Map<string, ComposerState>();
const listeners = new Map<string, Set<() => void>>();

export function getComposerState(id: string): ComposerState { return states.get(id) || emptyState; }
function update(id: string, state: ComposerState) {
  states.set(id, state);
  listeners.get(id)?.forEach(listener => listener());
}
export function subscribeComposer(id: string, listener: () => void) {
  const subscribers = listeners.get(id) || new Set<() => void>();
  subscribers.add(listener); listeners.set(id, subscribers);
  return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(id); };
}
export function setComposerDraft(id: string, draft: ChatDraft) { update(id, { ...getComposerState(id), draft }); }
export function setComposerError(id: string, error: string) { update(id, { ...getComposerState(id), error }); }

export function startComposerSend(id: string): ChatDraft | undefined {
  const current = getComposerState(id);
  if (current.stage) return;
  update(id, { ...current, stage: current.draft.attachments.some(attachment => attachment.file) ? 'preparing' : 'sending', error: '' });
  return current.draft;
}
export function markComposerSending(id: string) { update(id, { ...getComposerState(id), stage: 'sending' }); }
export function finishComposerSend(id: string, submitted: ChatDraft, error = '') {
  const current = getComposerState(id);
  update(id, { draft: !error && current.draft === submitted ? emptyDraft() : current.draft, error });
}
