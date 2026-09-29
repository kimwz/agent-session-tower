/**
 * The master agent: a Claude or Codex session Tower keeps in its own folder, with Tower's tools and a guide there, in
 * which the owner asks Tower to do anything its pages can do. Tower adds only what a session cannot do alone: its
 * tools, reports of the work it hands out, the owner's screen and voice. Everything about it lives in `server/master`,
 * `client/src/master` and this file, so it can be removed as a unit.
 */

import type { Provider, SessionStatus } from './types.js';

/** The master's folder under Tower's state directory: the session runs there, with its guide files. */
export const MASTER_FOLDER = 'master-session';

/** ElevenLabs voices the master reads aloud with; the first is the default (fast, natural Korean). */
export const MASTER_TTS_MODELS = ['eleven_v3_conversational', 'eleven_v3', 'eleven_flash_v2_5'] as const;
export type MasterTtsModel = typeof MASTER_TTS_MODELS[number];
/** A premade ElevenLabs voice every account has. */
export const DEFAULT_MASTER_VOICE_ID = 'cgSgspJ2msm6clMCkdW9';
/** Talking to the master: what the owner says is written down and answers are read aloud, both by ElevenLabs. */
export interface MasterVoiceSettings {
  voiceId: string;
  model: MasterTtsModel;
  /** How long a pause ends what the owner is saying, in milliseconds. */
  endSilenceMs: number;
  /** Minutes without a request or a report after which listening turns off. */
  listenMinutes: number;
  /** Read news of finished work aloud while voice is on in a tab, with the master's conversation open or closed. */
  readReports: boolean;
  /** Dollars of voice a day; 0 means no limit. */
  dailyDollars: number;
}
export const DEFAULT_MASTER_VOICE: MasterVoiceSettings = { voiceId: DEFAULT_MASTER_VOICE_ID, model: 'eleven_v3_conversational', endSilenceMs: 1000, listenMinutes: 5, readReports: true, dailyDollars: 0 };

/** The session the master talks through, and the ones it replaced (kept as ordinary sessions). */
export interface MasterBinding { sessionId: string; provider: Provider; startedAt: string }
export interface MasterSettings {
  voice: MasterVoiceSettings;
  /** The master session; none until the owner starts one. */
  session?: MasterBinding;
}
export const DEFAULT_MASTER_SETTINGS: MasterSettings = { voice: DEFAULT_MASTER_VOICE };

export interface MasterOverview {
  available: true;
  version: string;
  settings: MasterSettings;
  /** The master session: its state, as the session list shows it. */
  session?: { id: string; provider: Provider; status?: SessionStatus; title?: string };
  /** An ElevenLabs key is saved, so voice can be turned on. */
  voiceConfigured: boolean;
  voiceKeyHint?: string;
  /** Work the master handed out that has not been reported yet. */
  activeTasks: number;
  /** Reports of finished work Tower could not give the master session, after trying for a while. */
  failedReports?: number;
  voice?: MasterVoiceStatus;
}

/**
 * Voice as pages see it. The session is the tab where voice is on; pages know their own by its digest, and nothing a
 * page sent is shown back as it came.
 */
export interface MasterVoiceStatus {
  /** Digest of the voice session in use, if voice is on somewhere. */
  session?: string;
  listening: boolean;
  /** Voice used today on this computer (estimated): seconds written down, characters read aloud, and dollars. */
  today: { sttSeconds: number; ttsChars: number; dollars: number };
  limitDollars: number;
  /** Today's limit is reached: nothing more is written down or read aloud today. */
  limited: boolean;
}
/**
 * How an answer or a report is getting read aloud. `sent`, `delivered` and `undelivered` are left from GPT-Live calls
 * (1.52–1.55) in conversations kept since.
 */
export interface MasterSpeak {
  state: 'pending' | 'playing' | 'played' | 'unspoken' | 'sent' | 'delivered' | 'undelivered';
  tries?: number;
  /** Digest of the voice session a spoken request came from, when this answers one. */
  session?: string;
}
/** Something the page of the voice session plays: a short reply, an answer, a report, or a notice before a change. */
export interface MasterSay {
  id: string;
  session: string;
  kind: 'ack' | 'working' | 'answer' | 'report' | 'notice';
  text: string;
  /** Where the page fetches the audio (same origin). */
  audio: string;
  expiresAt: number;
  /** The spoken request it belongs to (its key), for the first response and the answer to keep their order. */
  request?: string;
  /** Read while the master is still writing it: its audio grows until the words end, so it may play long. */
  streaming?: true;
}

export type MasterCallState = 'sending' | 'succeeded' | 'failed' | 'uncertain' | 'not-admitted';
export type MasterTaskState = 'running' | 'completed' | 'error' | 'cancelled' | 'unknown';

/**
 * The voice's record of what it hears and reads aloud. The conversation itself is the master session's; this keeps only
 * spoken requests, and the answers and reports to read aloud with how their reading went.
 */
export type MasterEntryData =
  | { kind: 'owner'; text: string; voice?: true }
  | { kind: 'master'; text: string; turnId: string; final: boolean; speak?: MasterSpeak; request?: string }
  | { kind: 'event'; text: string; speak?: MasterSpeak }
  | { kind: 'error'; text: string; speak?: MasterSpeak };

export interface MasterEntry {
  id: string;
  order: number;
  at: string;
  revision: number;
  data: MasterEntryData;
}

/** Where a page's live stream of the master starts. */
export interface MasterCheckpoint { epoch: string; seq: number; overview: MasterOverview }
export interface MasterDraft { turnId: string; text: string }
/** Panels the master may open on the owner's screen, each the page's own. */
export const MASTER_PANELS = ['sessions', 'help', 'newSession', 'autoPrompt', 'triggers', 'remote', 'decisions', 'notifications', 'account', 'skills'] as const;
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
export type MasterStreamEvent =
  | { type: 'entry'; seq: number; entry: MasterEntry }
  | { type: 'draft'; seq: number; draft: MasterDraft | null }
  | { type: 'overview'; seq: number; overview: MasterOverview }
  | { type: 'directive'; seq: number; directive: MasterDirective }
  | { type: 'voice'; seq: number; voice: MasterVoiceStatus }
  | { type: 'say'; seq: number; say: MasterSay };

/** Where the owner is looking when they send a message, so "this session" means something. */
export interface MasterViewContext { tabId?: string; sessionId?: string; node?: string; cwd?: string }
