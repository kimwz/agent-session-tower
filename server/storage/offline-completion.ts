import type { DomainCommand } from './domain.js';

/** Each owning domain registers this fixed query against its own staging table; core uses prepare receipts separately. */
export function offlineCompletionCommand(stageTable?: 'retention_stages' | 'runs_stages' | 'triggers_stages'): Extract<DomainCommand, { kind: 'read' }> {
  return { kind: 'read', run(context, value) {
    const p = value as { commandId?: unknown; inputSha256?: unknown };
    if (!p || typeof p.commandId !== 'string' || typeof p.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.inputSha256)) throw new Error('Invalid offline completion identity.');
    const authority = context.prepare('SELECT authority,generation,manifest_sha256 FROM domain_imports WHERE domain=?').get(context.domain) as { authority: string; generation: number; manifest_sha256: string } | undefined;
    const receipt = context.prepare('SELECT scope,command,payload_sha256,result FROM operation_receipts WHERE command_id=?').get(p.commandId) as { scope: string; command: string; payload_sha256: string; result: string } | undefined;
    const stages = stageTable ? Number((context.prepare(`SELECT count(*) AS n FROM ${stageTable}`).get() as { n: number }).n) : 0;
    const uncertainSql=context.domain==='permissions' ? "SELECT count(*) AS n FROM permission_requests WHERE run_status='running'"
      : context.domain==='runs' ? "SELECT count(*) AS n FROM runs_rows WHERE kind='run' AND (status='running' OR json_extract(json,'$.steering.state') IN ('sending','uncertain'))"
      : context.domain==='triggers' ? "SELECT count(*) AS n FROM triggers_rows WHERE kind='events' AND json_extract(json,'$.status') IN ('claimed','uncertain')" : undefined;
    const unresolved=stages+(uncertainSql ? Number((context.prepare(uncertainSql).get() as {n:number}).n) : 0);
    if (!authority || authority.authority !== 'database' || authority.manifest_sha256 !== p.inputSha256 || !receipt || receipt.scope !== context.domain || receipt.command !== 'commit' || unresolved !== 0) throw new Error('Offline authority/receipt/staging incomplete.');
    const result = JSON.parse(receipt.result) as { generation?: number };
    if (result.generation !== authority.generation) throw new Error('Offline receipt generation changed.');
    return { commandId: p.commandId, command: receipt.command, typeHash: receipt.payload_sha256, inputSha256: p.inputSha256,
      authorityGeneration: authority.generation, restore: 'complete', unresolvedIntents: unresolved };
  } };
}

/** Finds the authority-establishing receipt, never an arbitrary current update or caller-supplied ID. */
export const offlineAuthorityReceiptCommand: Extract<DomainCommand, { kind: 'read' }> = { kind: 'read', run(context) {
  const authority = context.prepare('SELECT authority,generation,manifest_sha256 FROM domain_imports WHERE domain=?').get(context.domain) as { authority: string; generation: number; manifest_sha256: string } | undefined;
  if (!authority || authority.authority !== 'database') throw new Error('Offline SQL authority missing.');
  const receipt = context.prepare("SELECT command_id,payload_sha256,result FROM operation_receipts WHERE scope=? AND command='commit' AND json_extract(result,'$.generation')=? AND json_extract(result,'$.mode') IN ('import','restore') ORDER BY committed_at,command_id LIMIT 1").get(context.domain,authority.generation) as { command_id: string; payload_sha256: string; result: string } | undefined;
  if (!receipt) throw new Error('Offline authority-establishing receipt missing.');
  return { scope: context.domain, commandId: receipt.command_id, command: 'commit', typeHash: receipt.payload_sha256, inputSha256: authority.manifest_sha256, completionCommand: 'offlineCompletion' };
} };
