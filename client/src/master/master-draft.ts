import { useSyncExternalStore } from 'react';
import type { MasterEffort } from '../../../shared/master';
import type { DraftAttachment } from '../chat/chat-attachments';

/**
 * What the owner is writing to the master: its text, files and the model or reasoning chosen for it. It outlives the
 * panel, so closing and opening it again keeps the draft; text and choices also outlive a reload of the tab.
 */
export interface MasterComposerDraft { text: string; files: DraftAttachment[]; model?: string; effort?: MasterEffort }

const KEY = 'tower.master.draft';
const listeners = new Set<() => void>();
let draft: MasterComposerDraft = { ...saved(), files: [] };

function saved(): Omit<MasterComposerDraft, 'files'> {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Partial<MasterComposerDraft>;
    return { text: typeof value.text === 'string' ? value.text : '', ...(typeof value.model === 'string' ? { model: value.model } : {}), ...(typeof value.effort === 'string' ? { effort: value.effort } : {}) };
  } catch { return { text: '' }; }
}

export function currentDraft(): MasterComposerDraft { return draft; }

export function updateDraft(change: Partial<MasterComposerDraft> | ((current: MasterComposerDraft) => Partial<MasterComposerDraft>)): void {
  const patch = typeof change === 'function' ? change(draft) : change;
  draft = { ...draft, ...patch };
  for (const key of ['model', 'effort'] as const) if (key in patch && !patch[key]) delete draft[key];
  try {
    const { text, model, effort } = draft;
    if (!text && !model && !effort) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify({ text, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }));
  } catch { /* storage unavailable: kept for this page only */ }
  for (const listener of listeners) listener();
}

export function useMasterDraft(): MasterComposerDraft {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, currentDraft, currentDraft);
}
