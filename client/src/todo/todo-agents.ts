import { createContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, SessionOutcome, SessionStatus } from '../../../shared/types';
import type { TodoAgent } from '../../../shared/todo/types';
import { api } from '../common/lib';

/**
 * Issue masters as the Todo page shows them. Their sessions are the canvas's (App holds the snapshot and draws a chat
 * the same way it draws the canvas's), so the page reads them through this context instead of taking new props on
 * every snapshot: only what shows an issue master draws again.
 */
export interface TodoAgentView {
  /** A session of this computer's snapshot, master sessions included. */
  session: (id: string) => Session | undefined;
  /** The conversation of an issue master's session, filling its container; `onClose` leaves it. */
  chat: (sessionId: string, onClose: () => void) => ReactNode;
}

export const TodoAgentContext = createContext<TodoAgentView>({ session: () => undefined, chat: () => null });

/**
 * The page's session choice as the master's screen commands use it. Closing (`null`) while the Todo page shows an
 * issue chat leaves that chat, as its own close would; anything else goes to the canvas as before.
 */
export function screenSelect(select: (id: string | null) => void, issueChatClose: () => (() => void) | null): (id: string | null) => void {
  return id => {
    const close = id === null ? issueChatClose() : null;
    if (close) close(); else select(id);
  };
}

/** What a todo's issue master is doing, as its card and the chat header show a session: working in colour, else grey. */
export interface AgentLook {
  provider: TodoAgent['provider'];
  status: SessionStatus;
  usage?: Session['contextUsage'];
  /** Something for the owner: the canvas's outcome, or a turn that ended in an error. */
  flag?: Extract<SessionOutcome, 'needsOwner' | 'blocked'> | 'error';
}

export function agentLook(agent: TodoAgent, session: Session | undefined): AgentLook {
  // Until its session is known it is being started: shown at work.
  const status: SessionStatus = agent.state === 'starting' ? 'working' : session?.status ?? 'idle';
  const flag = session?.status === 'error' ? 'error' as const
    : status !== 'working' && (session?.outcome === 'needsOwner' || session?.outcome === 'blocked') ? session.outcome : undefined;
  return { provider: session?.provider ?? agent.provider, status, ...(session?.contextUsage ? { usage: session.contextUsage } : {}), ...(flag ? { flag } : {}) };
}

/** A canvas card's todo: the open issue family its session belongs to. */
export interface TodoSessionBadge { taskId: string; title: string }

/**
 * The todo of every session in an open issue family (`GET /api/todos/agents/sessions`), read again only when the todo
 * revision moves. A Tower without issue masters answers nothing to show.
 */
export function useTodoSessionBadges(revision: number | undefined): Readonly<Record<string, TodoSessionBadge>> {
  const [badges, setBadges] = useState<Readonly<Record<string, TodoSessionBadge>>>(noBadges);
  useEffect(() => {
    if (revision === undefined) return;
    let current = true;
    api<{ sessions?: Record<string, TodoSessionBadge> }>('/api/todos/agents/sessions')
      .then(answer => { if (current) setBadges(answer.sessions ?? noBadges); })
      // The badges only add to the canvas; one that could not be read leaves the last ones until the next revision.
      .catch(error => { if (current) console.warn('Todo badges could not be read', error); });
    return () => { current = false; };
  }, [revision]);
  return badges;
}

const noBadges: Readonly<Record<string, TodoSessionBadge>> = Object.freeze({});
