import type { MasterSay } from '../master.js';

/**
 * The order of what is said for one spoken request, in one place.
 *
 * 1. The first response (`FIRST_RESPONSE_KINDS`, today a recorded short reply the host picks in
 *    `MasterVoice.firstResponse`) is said first, as soon as the request went to the master.
 * 2. The answer (the master's own words, read while it writes them) follows it. The first response playing is never
 *    cut; the answer waits for it (and the page's short pause between things said).
 * 3. Once any of the answer has come, a first response or a "still working" line of that request not yet playing is
 *    dropped, and one arriving later is not said: the answer has begun, so they would come too late.
 * The host keeps its part of the same rule: it does not say "still working" once the answer's words were read.
 */
export const FIRST_RESPONSE_KINDS: ReadonlySet<MasterSay['kind']> = new Set(['ack', 'working']);
const ANSWER_KINDS: ReadonlySet<MasterSay['kind']> = new Set(['answer', 'report']);
/** Requests whose answer has begun, remembered for this many. */
const REMEMBERED = 100;

export class SayOrder {
  private readonly answered = new Set<string>();

  /**
   * Whether `say` is to be queued, and which queued (not playing) things to drop because of it. `queued` is what waits,
   * in order; what plays now is not in it.
   */
  admit(say: MasterSay, queued: readonly MasterSay[]): { admit: boolean; drop: MasterSay[] } {
    const request = say.request;
    if (!request) return { admit: true, drop: [] };
    if (FIRST_RESPONSE_KINDS.has(say.kind)) return { admit: !this.answered.has(request), drop: [] };
    if (!ANSWER_KINDS.has(say.kind)) return { admit: true, drop: [] };
    this.answered.add(request);
    if (this.answered.size > REMEMBERED) this.answered.delete(this.answered.values().next().value!);
    return { admit: true, drop: queued.filter(item => item.request === request && FIRST_RESPONSE_KINDS.has(item.kind)) };
  }
}
