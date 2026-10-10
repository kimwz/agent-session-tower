import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { offlineCompletionCommand, offlineAuthorityReceiptCommand } from '../../../server/storage/offline-completion.js';
import type { DomainReadContext } from '../../../server/storage/domain.js';

// Actual SQLite tables: no product guards replaced and no external effects.
test('registered completion binds authority generation, exact import receipt and zero unresolved stages', () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE domain_imports(domain TEXT,authority TEXT,generation INTEGER,manifest_sha256 TEXT); CREATE TABLE operation_receipts(command_id TEXT,scope TEXT,command TEXT,payload_sha256 TEXT,result TEXT,committed_at TEXT); CREATE TABLE runs_stages(intent TEXT); CREATE TABLE runs_rows(kind TEXT,status TEXT,json TEXT);');
    const inputSha256='a'.repeat(64),typeHash='b'.repeat(64);
    db.prepare('INSERT INTO domain_imports VALUES(?,?,?,?)').run('runs','database',2,inputSha256);
    db.prepare('INSERT INTO operation_receipts VALUES(?,?,?,?,?,?)').run('fixed','runs','commit',typeHash,JSON.stringify({generation:2,mode:'import'}),'2026-10-10');
    const context:DomainReadContext={domain:'runs',prepare:sql=>db.prepare(sql)};
    const command=offlineCompletionCommand('runs_stages');
    const payload={commandId:'fixed',inputSha256};
    const expected={commandId:'fixed',command:'commit',typeHash,inputSha256,authorityGeneration:2,restore:'complete',unresolvedIntents:0};
    assert.deepEqual(command.run(context,payload),expected);
    assert.deepEqual(offlineAuthorityReceiptCommand.run(context,{}),{scope:'runs',commandId:'fixed',command:'commit',typeHash,inputSha256,completionCommand:'offlineCompletion'});
    db.exec("INSERT INTO runs_stages VALUES('unresolved')");
    assert.throws(()=>command.run(context,payload),/incomplete/);
    db.exec(`DELETE FROM runs_stages; INSERT INTO runs_rows VALUES('run','queued','{"steering":{"state":"uncertain"}}')`);
    assert.throws(()=>command.run(context,payload),/incomplete/);
    db.exec('DELETE FROM runs_rows; UPDATE domain_imports SET generation=3');
    assert.throws(()=>command.run(context,payload),/generation/);
    assert.throws(()=>offlineAuthorityReceiptCommand.run(context,{}),/missing/);
  } finally { db.close(); }
});
