import type { DomainCommand } from './domain.js';

/**
 * The two commands every staged domain answers about its `<prefix>_stages` reservations. A staged write is `begin` (a
 * stage row stamped with the writer's owner epoch), `stage` chunks, then `commit`, which applies the rows and deletes the
 * stage row in one transaction; `stage` and `commit` refuse a row from another epoch, and every worker start claims a
 * higher epoch. So a stage row from an earlier epoch was never committed and never can be: it is a stranded reservation.
 */
export interface StrandedStage { intent: string; ownerEpoch: number; bytes: number; sha256: string; chunks: number; staged: number }

function fail(message: string): never { throw new Error(message); }

export function strandedStageCommands(prefix: 'runs' | 'triggers' | 'retention' | 'remote' | 'auto_prompt' | 'automation_workflows'): Record<'strandedStages' | 'discardStranded', DomainCommand> {
  const stages = `${prefix}_stages`, chunks = `${prefix}_stage_chunks`;
  return {
    /** Every stage row with its epoch and how many chunks arrived; the caller compares epochs with its own claim. */
    strandedStages: { kind: 'read', run: context => (context.prepare(
      `SELECT s.intent, s.owner_epoch, s.bytes, s.sha256, s.chunks, (SELECT count(*) FROM ${chunks} c WHERE c.intent = s.intent) AS staged FROM ${stages} s ORDER BY s.intent`,
    ).all() as { intent: string; owner_epoch: number; bytes: number; sha256: string; chunks: number; staged: number }[])
      .map((row): StrandedStage => ({ intent: row.intent, ownerEpoch: Number(row.owner_epoch), bytes: Number(row.bytes), sha256: row.sha256, chunks: Number(row.chunks), staged: Number(row.staged) })) },
    /**
     * Removes exactly the named stage rows (and their chunks). Each must still be there with the named epoch and hash,
     * from an epoch below the current claim; otherwise the whole command fails and nothing is removed.
     */
    discardStranded: { kind: 'write', run(context, payload) {
      const named = (payload as { stages?: unknown })?.stages;
      if (!Array.isArray(named) || !named.length || named.length > 64) return fail('Invalid stranded stage list.');
      for (const item of named as unknown[]) {
        const { intent, ownerEpoch, sha256 } = (item ?? {}) as Record<string, unknown>;
        if (typeof intent !== 'string' || typeof ownerEpoch !== 'number' || !Number.isSafeInteger(ownerEpoch) || typeof sha256 !== 'string') return fail('Invalid stranded stage.');
        const row = context.prepare(`SELECT owner_epoch, sha256 FROM ${stages} WHERE intent = ?`).get(intent) as { owner_epoch: number; sha256: string } | undefined;
        if (!row || Number(row.owner_epoch) !== ownerEpoch || row.sha256 !== sha256) fail(`Stage ${intent} is not the one named.`);
        if (ownerEpoch >= context.ownerEpoch) fail(`Stage ${intent} belongs to the current owner.`);
        context.prepare(`DELETE FROM ${chunks} WHERE intent = ?`).run(intent);
        context.prepare(`DELETE FROM ${stages} WHERE intent = ?`).run(intent);
      }
      return { discarded: named.length };
    } },
  };
}
