import type { DecisionEngine, DecisionQuestion } from '../decisions/engine.js';
import type { Run, Session } from '../../shared/types.js';

const CANDIDATES = 40;
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const PICKED = 3;
const LIKELY = 0.6;
/** What the whole judgment may show; Jev takes about 110,000 characters of state with one question. */
const STATE_CHARS = 100_000;
const REQUEST_CHARS = 4000;

const clip = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max)}…` : flat; };

/**
 * Earlier sessions a new conversation's first request may continue, for the agent to look at before it starts. A fast
 * judgment picks them from the most recent sessions (the same folder first) by their titles and their latest user
 * requests, which say what each is about better than the agent's answers; newest first, as many as fit each session's
 * share. The agent gets their ids, not their contents, and decides itself whether to read them. Nothing is sent without
 * an engine.
 */
export async function relatedSessionNotes(engine: DecisionEngine | undefined, run: Run, session: Session, all: Session[], requests: (id: string) => string[], now = Date.now()): Promise<string | undefined> {
  if (!engine || !run.prompt.trim()) return undefined;
  const candidates = all.filter(item => item.id !== session.id && !item.isSubagent && !item.launchedByAgent && !item.creationPending
      && now - Date.parse(item.updatedAt) < RECENT_MS)
    .sort((a, b) => Number(b.cwd === session.cwd) - Number(a.cwd === session.cwd) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, CANDIDATES);
  if (!candidates.length) return undefined;
  // Everything but the requests first; what is left, measured as the JSON that is sent, is shared among the sessions.
  const earlierSessions = Object.fromEntries(candidates.map((item, index) => [`s${index}`, { title: clip(item.customTitle || item.title, 300),
    folder: clip(item.cwd, 300), lastActive: item.updatedAt.slice(0, 16), latestUserRequests: [] as string[] }]));
  const state = { newRequest: { folder: clip(session.cwd, 300), text: clip(run.prompt, REQUEST_CHARS) }, earlierSessions };
  const share = Math.floor((STATE_CHARS - JSON.stringify(state).length) / candidates.length);
  candidates.forEach((item, index) => {
    let used = 0;
    for (const request of requests(item.id)) {
      // A comma between requests, and the request as JSON writes it.
      const size = JSON.stringify(request).length + 1;
      if (used + size > share) break;
      earlierSessions[`s${index}`]!.latestUserRequests.push(request); used += size;
    }
  });
  const questions: Record<string, DecisionQuestion> = Object.fromEntries(candidates.map((_, index) => [`s${index}`, { type: 'yesNo',
    instructions: `Judge by its title and its latest user requests (newest first). Is earlier session earlierSessions.s${index} about the same specific work as newRequest (the same issue, feature, incident, customer, game, pull request or error), so that what it found or did would help with newRequest? Answer no if they only share a project, a folder or a general topic.` }]));
  const answers = await engine.decide({ state, questions });
  const picked = candidates.map((item, index) => ({ item, yes: (answers[`s${index}`] as { yes: number }).yes }))
    .filter(entry => entry.yes >= LIKELY).sort((a, b) => b.yes - a.yes).slice(0, PICKED);
  if (!picked.length) return undefined;
  return ['## Possibly related earlier sessions',
    'Tower picked these automatically from session titles and recent requests; they may not be related. If one is about this same work, read it with sessions_read (or look further with sessions_search) before you start, check that its findings still hold, and build on them instead of starting over. Otherwise ignore them.',
    ...picked.map(({ item }) => `- ${item.id} — "${clip(item.customTitle || item.title, 120)}" (${item.cwd}, last active ${item.updatedAt.slice(0, 10)})`)].join('\n');
}
