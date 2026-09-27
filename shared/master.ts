/**
 * The master agent: one conversation in which the owner asks Tower to do anything its pages can do.
 * Everything about it lives in `server/master`, `client/src/master` and this file, so it can be removed as a unit.
 */

import type { SessionStatus } from './types.js';

export const MASTER_MODELS = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'] as const;
export const MASTER_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
export type MasterEffort = typeof MASTER_EFFORTS[number];

/**
 * Optional limits. By default the master does everything the owner asks; the two protections that stay on keep
 * key values out of the model's context and keep this computer's local-only pages local.
 */
export interface MasterGuards {
  /** Keys and tokens the owner pastes, or a page returns, reach the model only as references. */
  hideSecrets: boolean;
  /** Account management and Tower updates only for requests typed on this computer itself, as on Tower's own pages. */
  localOnlyPages: boolean;
  /** Turns started by finished work (not by the owner) may only read and report. */
  eventTurnsReadOnly: boolean;
  /** Joined computers the master may only read from. */
  readOnlyNodes: string[];
  /** Irreversible calls one turn may make; 0 means no limit. */
  maxIrreversiblePerTurn: number;
}
export const DEFAULT_MASTER_GUARDS: MasterGuards = { hideSecrets: true, localOnlyPages: true, eventTurnsReadOnly: false, readOnlyNodes: [], maxIrreversiblePerTurn: 0 };

export interface MasterSettings {
  enabled: boolean;
  model: string;
  effort: MasterEffort;
  /** Let the master open what it found in the tab the owner is talking from. */
  showResults: boolean;
  guards: MasterGuards;
}
export const DEFAULT_MASTER_SETTINGS: MasterSettings = { enabled: true, model: 'gpt-6-luna', effort: 'low', showResults: true, guards: DEFAULT_MASTER_GUARDS };

export type MasterState = 'idle' | 'thinking' | 'unconfigured' | 'disabled';

export interface MasterOverview {
  available: true;
  version: string;
  settings: MasterSettings;
  configured: boolean;
  keyHint?: string;
  state: MasterState;
  activeTasks: number;
  lastOrder: number;
  error?: string;
}

export type MasterCallState = 'sending' | 'succeeded' | 'failed' | 'uncertain' | 'not-admitted';
export type MasterTaskState = 'running' | 'completed' | 'error' | 'cancelled' | 'unknown';

export type MasterEntryData =
  | { kind: 'owner'; text: string; clientId?: string }
  | { kind: 'master'; text: string; turnId: string; final: boolean }
  | { kind: 'action'; turnId: string; method: string; path: string; node?: string; state: MasterCallState; summary?: string; write: boolean }
  | { kind: 'task'; sessionId?: string; runId?: string; jobId?: string; node?: string; title: string; state: MasterTaskState; answer?: string }
  | { kind: 'event'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'card'; card: MasterCard };

export interface MasterEntry {
  id: string;
  /** Creation order; pages and the display follow it. */
  order: number;
  at: string;
  revision: number;
  data: MasterEntryData;
}

/** What the page shows from the start: the recent conversation and where its live stream continues. */
export interface MasterCheckpoint { epoch: string; seq: number; entries: MasterEntry[]; hasMore: boolean; draft?: MasterDraft; overview: MasterOverview }
export interface MasterDraft { turnId: string; text: string }
/** Panels the master may open on the owner's screen, each the page's own. */
export const MASTER_PANELS = ['sessions', 'help', 'newSession', 'autoPrompt', 'triggers', 'remote', 'decisions', 'notifications', 'account'] as const;
export type MasterPanel = typeof MASTER_PANELS[number];
/** The sidebar's filters and the canvas's "show hidden", as the owner sets them by hand. */
export interface MasterFilter {
  reset?: boolean;
  query?: string;
  provider?: 'all' | 'claude' | 'codex';
  status?: 'all' | SessionStatus;
  period?: '1' | '7' | '30' | 'all';
  /** A folder (cwd), on `computer` when that is a joined computer. */
  project?: string;
  /** 'all', 'local', or a joined computer's id. */
  computer?: string;
  closed?: boolean;
  showHidden?: boolean;
}
/** Something the master does on the owner's screen, through the page's own controls. */
export type MasterScreenCommand =
  | { kind: 'openSession'; sessionId: string; node?: string }
  | { kind: 'close' }
  | { kind: 'openPanel'; panel: MasterPanel; cwd?: string; node?: string; title?: string; prompt?: string }
  | { kind: 'filter'; filter: MasterFilter }
  | { kind: 'preference'; language?: 'ko' | 'en'; chatFontSize?: number };
/** A screen command for one tab, which says back whether it could do it. */
export type MasterDirective = MasterScreenCommand & { id: string; tabId?: string; expiresAt: number };
export type MasterDirectiveResult = 'done' | 'unavailable' | 'failed';
/**
 * Cards in the conversation for what only the owner's own browser can do: open a result when showing results is
 * off, turn on notifications on a device, or enter a secret the model must never read.
 */
export type MasterCard =
  | { type: 'open'; label: string; command: MasterScreenCommand }
  | { type: 'push'; state: 'waiting' | 'subscribed' | 'failed'; note?: string }
  | { type: 'secret'; purpose: string; state: 'waiting' | 'provided' | 'dismissed' };

export type MasterStreamEvent =
  | { type: 'entry'; seq: number; entry: MasterEntry }
  | { type: 'draft'; seq: number; draft: MasterDraft | null }
  | { type: 'overview'; seq: number; overview: MasterOverview }
  | { type: 'directive'; seq: number; directive: MasterDirective };

/** Where the owner is looking when they send a message, so "this session" means something. */
export interface MasterViewContext { tabId?: string; sessionId?: string; node?: string; cwd?: string }
