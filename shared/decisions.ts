/** The services that can answer Tower's fast multiple-choice judgments. Add an id here with its adapter. */
export const DECISION_PROVIDER_IDS = ['jev'] as const;
export type DecisionProviderId = typeof DECISION_PROVIDER_IDS[number];

/** Tower features that use fast judgments; each can be turned off on its own. */
export interface DecisionFeatures {
  /** Suggest the project and conversation for an Auto Prompt while it is being written. */
  autoPromptSuggestions: boolean;
  /** Skip push notifications for turns that are only an intermediate step. */
  attentionNotifications: boolean;
  /** Insert a message sent while a turn runs into that turn when it belongs to the work in progress. */
  steerTiming: boolean;
  /** Show on the canvas how each finished conversation's last turn ended. */
  sessionOutcomes: boolean;
  /** A new conversation's first turn is told which earlier sessions may be about the same work. */
  relatedSessions: boolean;
  /** A later message in a Slack thread Tower already handled continues that conversation when it asks something of the owner. */
  slackFollowUps: boolean;
}
export const DEFAULT_DECISION_FEATURES: DecisionFeatures = { autoPromptSuggestions: true, attentionNotifications: true, steerTiming: true, sessionOutcomes: true, relatedSessions: true, slackFollowUps: true };

/** One judgment a feature made, kept in memory so the owner can see what the service answered and what Tower did. */
export interface DecisionRecord {
  at: string;
  feature: keyof DecisionFeatures;
  /** What it was about: a conversation title or the start of a draft. */
  subject: string;
  /** What Tower did with the answer, in the page's words (a key of DECISION_RESULTS). */
  result: DecisionResult;
  /** Each option's probability, rounded, as the service gave it. */
  probabilities: Record<string, number>;
  /** A detail worth knowing, such as the suggested place or why a judgment failed. */
  detail?: string;
  ms: number;
}
/**
 * For notifications, the judgment itself: `notify` is a turn judged worth a push, which the owner's next message or
 * the device settings can still stop; `quiet` is a turn judged an intermediate step, which is not pushed.
 */
export type DecisionResult = 'notify' | 'quiet' | 'suggested' | 'noSuggestion' | 'inserted' | 'waiting' | 'labeled' | 'failed';
/** How many recent judgments the settings page can show. */
export const DECISION_RECORDS_KEPT = 40;

/** What the settings page sees. The API key itself never leaves the server; only its last characters do. */
export interface DecisionOverview {
  provider: DecisionProviderId;
  label: string;
  configured: boolean;
  keyHint?: string;
  features: DecisionFeatures;
  providers: Array<{ id: DecisionProviderId; label: string }>;
  /** Newest first. Absent from servers that predate it. */
  recent?: DecisionRecord[];
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
