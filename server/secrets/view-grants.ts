/** How long value viewing stays unlocked without a value read or change. */
export const VIEW_IDLE_MS = 15 * 60_000;

/**
 * The signed-in browsers that unlocked value viewing with the Tower password, in the web's memory only (a restart
 * forgets them): by the sign-in's key (`sessionKey` of its cookie), with the worker's lock generation they were
 * unlocked in, which the worker checks on every read.
 */
export class ViewGrants {
  private readonly grants = new Map<string, { generation: string; lastUsed: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  /** A grant in the vault's current generation; any grant of an earlier one is over, since that generation ended. */
  set(session: string, generation: string): void {
    for (const [key, grant] of this.grants) if (grant.generation !== generation) this.grants.delete(key);
    this.grants.set(session, { generation, lastUsed: this.now() });
  }
  /** The generation of a grant still in use, which this use keeps alive; an idle one is dropped. */
  use(session: string): string | undefined {
    if (!this.has(session)) return undefined;
    const grant = this.grants.get(session)!; grant.lastUsed = this.now(); return grant.generation;
  }
  /** Whether the grant is still in use, without counting as a use (views read it). */
  has(session: string): boolean {
    const grant = this.grants.get(session);
    if (grant && this.now() - grant.lastUsed >= VIEW_IDLE_MS) this.grants.delete(session);
    return this.grants.has(session);
  }
  drop(session: string): void { this.grants.delete(session); }
  clear(): void { this.grants.clear(); }
}
