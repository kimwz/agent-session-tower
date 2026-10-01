import type { SessionScope } from '../../../shared/session-scope';
import { nodeOf } from '../remote/scope';

/**
 * The sessions this computer's page needs: the list's time window (`period` in days, or 'all'), the archived list
 * when it is open, and the opened conversation's family. A joined computer's conversation is not this computer's to send.
 */
export function pageScope(period: string, showClosed: boolean, activeChatId: string | null | undefined): SessionScope {
  return { ...(period === 'all' ? {} : { days: Number(period) }), closed: showClosed, ...(activeChatId && !nodeOf(activeChatId) ? { focus: activeChatId } : {}) };
}

/** The archived list is open but the sessions it lists have not arrived yet. */
export function archivedPending(showClosed: boolean, held: SessionScope | undefined): boolean {
  return showClosed && held !== undefined && !held.closed;
}
