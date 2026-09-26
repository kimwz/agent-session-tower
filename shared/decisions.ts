/** The services that can answer Tower's fast multiple-choice judgments. Add an id here with its adapter. */
export const DECISION_PROVIDER_IDS = ['jev'] as const;
export type DecisionProviderId = typeof DECISION_PROVIDER_IDS[number];

/** Tower features that use fast judgments; each can be turned off on its own. */
export interface DecisionFeatures {
  /** Suggest the project and conversation for an Auto Prompt while it is being written. */
  autoPromptSuggestions: boolean;
  /** Skip push notifications for turns that are only an intermediate step. */
  attentionNotifications: boolean;
}
export const DEFAULT_DECISION_FEATURES: DecisionFeatures = { autoPromptSuggestions: true, attentionNotifications: true };

/** What the settings page sees. The API key itself never leaves the server; only its last characters do. */
export interface DecisionOverview {
  provider: DecisionProviderId;
  label: string;
  configured: boolean;
  keyHint?: string;
  features: DecisionFeatures;
  providers: Array<{ id: DecisionProviderId; label: string }>;
}

/** An Auto Prompt draft gets suggestions once it is this long. */
export const AUTO_PROMPT_SUGGESTION_MIN_CHARS = 30;
/** At most one suggestion request per this interval while the draft changes. */
export const AUTO_PROMPT_SUGGESTION_INTERVAL_MS = 5_000;

export interface AutoPromptSuggestionRequest {
  prompt: string;
  provider: 'claude' | 'codex';
  /** A folder the owner already chose; only the conversation is suggested then. */
  cwd?: string;
  /** A joined computer, as its node id. */
  node?: string;
}
export interface AutoPromptSuggestion {
  cwd: string;
  project: string;
  /** An existing conversation to continue, or null for a new conversation in `cwd`. */
  sessionId: string | null;
  sessionTitle?: string;
  projectConfidence: number;
  sessionConfidence: number;
}
/** Why a suggestion could not be made; the page words it. */
export type DecisionFailure = 'unauthorized' | 'rate-limited' | 'unavailable';
export type AutoPromptSuggestionResponse =
  | { available: false }
  | { available: true; label: string; suggestion: AutoPromptSuggestion | null; error?: DecisionFailure };
