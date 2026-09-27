/**
 * How each finished conversation's last turn left things for the owner, as a fast judgment reads it: done, waiting
 * for the owner, broken off, or carrying on by itself. The canvas shows it on the conversation's card.
 *
 * Every turn is judged once. A judgment belongs to the last message it read, so a conversation that moves on shows
 * nothing until its new last turn has been judged; one that is working shows nothing at all.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ChatMessage, Session, SessionOutcome } from '../../shared/types.js';
import type { DecisionRecord } from '../../shared/decisions.js';
import type { DecisionEngine } from '../decisions/engine.js';
import { judgeTurn } from '../notifications/attention.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

const FILE = 'session-outcomes.json';
/** Only conversations that ended this recently are judged, newest first and at most this many at a time. */
const RECENT_MS = 3 * 86_400_000;
const MOST = 40;
/** A turn is judged once its conversation has stayed the same this long, so its history has caught up. */
const SETTLE_MS = 4_000;
const JUDGMENT_MS = 15_000;
/** After a failed judgment the conversation waits this long before it is tried again. */
const RETRY_MS = 5 * 60_000;
const KEPT = 500;
const HISTORY = 60;

interface Judged { mark: string; outcome: SessionOutcome }

export interface SessionOutcomeDependencies {
  stateDir: string;
  /** The engine for this feature, or nothing when it is off. */
  engine(): DecisionEngine | undefined;
  sessions(): readonly Session[];
  /** The conversation's latest messages, oldest first. */
  history(session: Session): Promise<readonly ChatMessage[] | undefined>;
  project(session: Session): string;
  title(session: Session): string;
  record(entry: Omit<DecisionRecord, 'at'>): void;
  onChange(): void;
  settleMs?: number;
}

/** What marks a conversation's last turn: when anything is added to it, the old judgment no longer applies. */
export function outcomeMark(session: Pick<Session, 'messageCount' | 'lastMessage'>): string {
  return createHash('sha256').update(`${session.messageCount}\n${session.lastMessage}`).digest('hex').slice(0, 16);
}

const activity = (session: Session) => Date.parse(session.lastCompletedAt ?? session.updatedAt) || 0;

/** A conversation the canvas shows as its own card and whose last turn has ended. */
export function judgeable(session: Session, now = Date.now()): boolean {
  return session.status !== 'working' && !session.closed && !session.creationPending && !session.isSubagent && !session.launchedByAgent
    && !session.launchedBy && !session.scheduledAt && now - activity(session) <= RECENT_MS;
}

/** The last request in the history and what the agent wrote after it, in the form turn judgments read. */
export function lastTurn(messages: readonly ChatMessage[]): { request: string; output: string } {
  let start = messages.length;
  while (start > 0 && !(messages[start - 1].role === 'user' && messages[start - 1].text.trim())) start--;
  const request = start > 0 ? messages[start - 1].text : '';
  const output = messages.slice(start).map(message => message.role === 'assistant' ? message.text : message.role === 'tool' ? `[${message.toolName || 'Tool'}]\n` : '').filter(Boolean).join('\n');
  return { request, output };
}

export class SessionOutcomes {
  private readonly path: string;
  private judged = new Map<string, Judged>();
  private failed = new Map<string, { mark: string; at: number }>();
  /** When each conversation's current last message was first seen, so a turn is judged only once it has settled. */
  private seen = new Map<string, { mark: string; at: number }>();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;
  private closed = false;
  private readonly abort = new AbortController();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: SessionOutcomeDependencies) {
    this.path = join(dependencies.stateDir, FILE);
  }

  async start(): Promise<void> {
    try {
      const saved = await readPrivateJson(this.path) as Record<string, Judged> | undefined;
      if (saved && typeof saved === 'object') for (const [id, item] of Object.entries(saved)) {
        if (item && typeof item.mark === 'string' && ['done', 'needsOwner', 'blocked', 'progress'].includes(item.outcome)) this.judged.set(id, { mark: item.mark, outcome: item.outcome });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Session outcomes were not loaded: ${error instanceof Error ? error.message : String(error)}`); }
    this.changed();
  }

  /** The session with its outcome, when the feature is on and its current last turn has been judged. */
  apply(session: Session): Session {
    if (session.status === 'working' || session.scheduledAt || !this.dependencies.engine()) return session;
    const judged = this.judged.get(session.id);
    return judged && judged.mark === outcomeMark(session) ? { ...session, outcome: judged.outcome } : session;
  }

  /** Sessions changed: judge what has settled, once it has. Constant changes elsewhere never hold a pass back. */
  changed(): void {
    if (this.closed || this.timer || !this.dependencies.engine()) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.run(); }, this.dependencies.settleMs ?? SETTLE_MS);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
    await this.running?.catch(() => {});
    await this.writes;
  }

  /** Runs one pass at a time; a change during a pass starts another after it. */
  private run(): void {
    if (this.running) { this.again = true; return; }
    this.running = this.pass().catch(error => console.error(`Session outcomes were not judged: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.running = undefined; if (this.again && !this.closed) { this.again = false; this.run(); } });
  }

  private async pass(): Promise<void> {
    const now = Date.now();
    const settle = this.dependencies.settleMs ?? SETTLE_MS;
    let unsettled = false;
    const due = this.dependencies.sessions().filter(session => judgeable(session, now))
      .sort((a, b) => activity(b) - activity(a)).slice(0, MOST)
      .filter(session => {
        const mark = outcomeMark(session);
        const failed = this.failed.get(session.id);
        if (this.judged.get(session.id)?.mark === mark || (failed?.mark === mark && now - failed.at < RETRY_MS)) return false;
        const seen = this.seen.get(session.id);
        if (seen?.mark !== mark) this.seen.set(session.id, { mark, at: now });
        if (seen?.mark === mark && now - seen.at >= settle) return true;
        unsettled = true;
        return false;
      });
    if (unsettled) this.changed();
    if (this.seen.size > KEPT) for (const id of [...this.seen.keys()].slice(0, this.seen.size - KEPT)) this.seen.delete(id);
    let changed = false;
    for (const session of due) {
      if (this.closed) break;
      const engine = this.dependencies.engine();
      if (!engine) break;
      const outcome = await this.judge(engine, session);
      if (!outcome) continue;
      this.judged.delete(session.id);
      this.judged.set(session.id, { mark: outcomeMark(session), outcome });
      changed = true;
      this.dependencies.onChange();
    }
    if (!changed) return;
    while (this.judged.size > KEPT) this.judged.delete(this.judged.keys().next().value!);
    const data = `${JSON.stringify(Object.fromEntries(this.judged))}\n`;
    const write = this.writes.then(() => writePrivateJson(this.path, data));
    this.writes = write.catch(error => console.error(`Session outcomes were not saved: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** A conversation that broke off is known without asking; any other is judged from its last turn. */
  private async judge(engine: DecisionEngine, session: Session): Promise<SessionOutcome | undefined> {
    if (session.status === 'error') return 'blocked';
    const subject = this.dependencies.title(session);
    const started = performance.now();
    try {
      const messages = await this.dependencies.history(session);
      if (!messages?.length) return undefined;
      const turn = lastTurn(messages);
      // The owner's message got no answer: the turn stopped before the agent wrote anything.
      if (turn.request && !turn.output.trim()) return 'blocked';
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(JUDGMENT_MS)]);
      const judged = await judgeTurn(engine, { request: turn.request, output: turn.output, conversation: subject, project: this.dependencies.project(session) }, signal);
      this.dependencies.record({ feature: 'sessionOutcomes', subject, result: 'labeled', probabilities: judged.probabilities, ms: performance.now() - started });
      return judged.outcome;
    } catch (error) {
      if (this.closed) return undefined;
      this.failed.set(session.id, { mark: outcomeMark(session), at: Date.now() });
      this.dependencies.record({ feature: 'sessionOutcomes', subject, result: 'failed', probabilities: {}, detail: error instanceof Error ? error.message : String(error), ms: performance.now() - started });
      return undefined;
    }
  }
}
