import type { Session, Snapshot } from '../../shared/types.js';

const RECENT_MS = 30 * 60_000;
const TITLE = 80;
const MAX_LENGTH = 4000;

/**
 * A short picture of Tower right now, put at the top of every turn so simple questions ("what is running?") are
 * answered from it in one step. It names its time; anything more is looked up with tower_query.
 */
export function statusDigest(local: Snapshot | undefined, nodes: ReadonlyMap<string, Snapshot>, now = Date.now(), missing: readonly string[] = [], hide: (text: string) => string = text => text): string {
  if (!local) return 'Tower status: not available right now (look it up with tower_query or tower_api).';
  const names = new Map((local.nodes ?? []).map(node => [node.id, node.label || node.name]));
  const computers: Array<[string, Snapshot]> = [['', local], ...nodes];
  const lines: string[] = [];
  const shown = (session: Session) => !session.isSubagent && !session.launchedByAgent && !session.closed;
  // Hidden whole, then shortened: a key at the cut is never left half-recognised.
  const short = (value: string) => { const text = hide(value); return text.length > TITLE ? `${text.slice(0, TITLE)}…` : text; };
  const label = (node: string, session: Session) => `${short(session.customTitle || session.title || '(untitled)')} — ${short(session.project)}${node ? ` @${names.get(node) ?? node}` : ''} [${session.id}${node ? `, node ${node}` : ''}]`;
  const minutes = (at: string | undefined) => at ? `${Math.max(0, Math.round((now - Date.parse(at)) / 60_000))} min` : '?';

  const working = computers.flatMap(([node, snapshot]) => snapshot.sessions.filter(session => shown(session) && session.status === 'working').map(session => `${label(node, session)}, for ${minutes(session.lastRequestAt ?? session.updatedAt)}`));
  lines.push(`Working now (${working.length}):${working.length ? `\n  - ${working.slice(0, 12).join('\n  - ')}` : ' none'}`);

  const attention = computers.flatMap(([node, snapshot]) => snapshot.sessions.filter(session => shown(session) && session.status !== 'working' && (session.outcome === 'needsOwner' || session.outcome === 'blocked' || session.status === 'error'))
    .map(session => `${label(node, session)}: ${session.outcome ?? session.status}`));
  if (attention.length) lines.push(`Waiting for the owner or stopped (${attention.length}):\n  - ${attention.slice(0, 8).join('\n  - ')}`);

  // Requests Tower ran, and conversations that finished on their own (typed in a terminal): one line per conversation.
  const finished = computers.flatMap(([node, snapshot]) => {
    const runs = snapshot.runs.filter(run => run.finishedAt && now - Date.parse(run.finishedAt) < RECENT_MS)
      .map(run => ({ at: run.finishedAt!, status: run.status as string, key: `${node}:${run.sessionId}`, text: (() => { const session = snapshot.sessions.find(item => item.id === run.sessionId); return session ? label(node, session) : run.sessionId; })() }));
    const sessions = snapshot.sessions.filter(session => shown(session) && session.status !== 'working' && session.lastCompletedAt && now - Date.parse(session.lastCompletedAt) < RECENT_MS)
      .map(session => ({ at: session.lastCompletedAt!, status: session.status === 'error' ? 'error' : 'completed', key: `${node}:${session.id}`, text: label(node, session) }));
    return [...runs, ...sessions];
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .filter((item, index, list) => list.findIndex(other => other.key === item.key) === index)
    .map(item => `${item.status} ${minutes(item.at)} ago — ${item.text}`);
  if (finished.length) lines.push(`Finished in the last 30 min (${finished.length}):\n  - ${finished.slice(0, 8).join('\n  - ')}`);

  const queued = computers.reduce((count, [, snapshot]) => count + snapshot.runs.filter(run => run.status === 'queued').length, 0);
  if (queued) lines.push(`Queued requests: ${queued}`);
  const routing = computers.reduce((count, [, snapshot]) => count + (snapshot.autoPrompts ?? []).filter(job => job.status === 'queued' || job.status === 'routing' || job.status === 'dispatching').length, 0);
  if (routing) lines.push(`Auto Prompts being routed: ${routing}`);

  if (local.nodes?.length) lines.push(`Joined computers: ${local.nodes.map(node => `${node.label || node.name} (${node.status}${node.version ? `, v${node.version}` : ''})`).join(', ')}`);
  lines.push(`This Tower: v${local.version}${local.runnerVersion && local.runnerVersion !== local.version ? ` (worker v${local.runnerVersion})` : ''}, ${local.sessions.filter(shown).length} open sessions`);
  // What the numbers leave out comes first, so no cut can drop it.
  const warning = missing.length ? `No current data yet from: ${missing.map(id => short(names.get(id) ?? id)).join(', ')} — their work is not included below.\n` : '';
  // Everything is hidden as a whole before the final cut, names of joined computers included.
  const head = hide(`Tower status at ${new Date(now).toISOString()} (live):\n${warning}`);
  const body = hide(lines.join('\n'));
  return head.length + body.length > MAX_LENGTH ? `${head}${body.slice(0, Math.max(0, MAX_LENGTH - head.length))}\n… (cut; use tower_query for the rest)` : `${head}${body}`;
}
