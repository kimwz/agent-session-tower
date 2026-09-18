import type { CodexApprovalsReviewer, Provider } from '../../../shared/types';

/** 'default' sends nothing, so Codex keeps whichever reviewer it is configured to use. */
export type CodexApprovalsChoice = 'default' | CodexApprovalsReviewer;
// Storage keys keep the project's first name so saved user state survives the rename (shared/app-identity.ts LEGACY_APP_NAME).
export const codexApprovalsKey = 'agent-monitor.codex-approvals-reviewer.v1';

export function parseCodexApprovalsChoice(value: string | null): CodexApprovalsChoice {
  return value === 'user' || value === 'auto_review' ? value : 'default';
}

export function codexApprovalsRequest(provider: Provider, choice: CodexApprovalsChoice): { codexApprovalsReviewer?: CodexApprovalsReviewer } {
  return provider === 'codex' && choice !== 'default' ? { codexApprovalsReviewer: choice } : {};
}

export function readCodexApprovalsChoice(): CodexApprovalsChoice {
  try { return parseCodexApprovalsChoice(window.localStorage.getItem(codexApprovalsKey)); }
  catch { return 'default'; } // Private browsing can disable storage.
}

export function storeCodexApprovalsChoice(choice: CodexApprovalsChoice): void {
  try { window.localStorage.setItem(codexApprovalsKey, choice); } catch { /* Keep the current choice when storage is unavailable. */ }
}
