import { mkdir, readdir, unlink, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { SecretVault } from '../secrets/vault.js';
import type { SecretService } from '../secrets/service.js';
import { decode } from '../secrets/crypto.js';
import { encryptBackup, decryptBackup } from './crypto.js';
import type { TriggerBackup } from '../triggers/backup.js';
import type { StoredSecret } from '../triggers/secrets.js';
const PREFIX = 'pending-import-';
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
const root = (stateDir: string) => join(stateDir, 'secrets');
interface PendingSecret { version: 1; kind: 'vault' | 'legacy'; content: string; restoreId?: string }
async function directory(stateDir: string, create = false) {
  if (create) await mkdir(root(stateDir), { recursive: true, mode: 0o700 });
  try { if (!(await lstat(root(stateDir))).isDirectory()) throw new Error('Invalid secret import directory'); return true; }
  catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function collectEncryptedVault(stateDir: string): Promise<string | undefined> {
  const vault = new SecretVault(stateDir); await vault.start();
  if (!vault.initialized) return undefined;
  return (await vault.read('vault.json'))!.toString('base64');
}
export async function stageVaultImport(stateDir: string, content: string, restoreId?: string): Promise<string> {
  const bytes = decode(content); if (bytes.length > 16 * 1024 * 1024) throw new Error('Vault import size limit');
  const envelope = JSON.parse(bytes.toString()); if (envelope?.format !== 1 || typeof envelope.vaultId !== 'string' || !envelope.wrappedKey || !envelope.payload) throw new Error('Invalid encrypted vault');
  return stage(stateDir, { version: 1, kind: 'vault', content, restoreId });
}
export async function stageLegacyImport(stateDir: string, records: unknown, passphrase: string, restoreId?: string, triggers?: TriggerBackup): Promise<string> {
  if (!Array.isArray(records) || !records.every(validLegacy)) throw new Error('Invalid legacy import');
  const content = await encryptBackup({ version: 1, records, ...(triggers ? { triggers } : {}) }, passphrase, { towerVersion: 'secret-legacy-import', from: 'encrypted-backup' });
  return stage(stateDir, { version: 1, kind: 'legacy', content, restoreId });
}
async function stage(stateDir: string, pending: PendingSecret): Promise<string> {
  await directory(stateDir, true);
  // A crash or retry of the same restore keeps one reviewable pending import.
  if (pending.restoreId) for (const id of await listPendingSecretImports(stateDir)) {
    const saved = await readPrivateJson(join(root(stateDir), `${PREFIX}${id}.json`), 45 * 1024 * 1024) as PendingSecret;
    if (saved.restoreId === pending.restoreId && saved.kind === pending.kind) return id;
  }
  const id = randomUUID(); await writePrivateJson(join(root(stateDir), `${PREFIX}${id}.json`), JSON.stringify(pending), { syncDirectory: true }); return id;
}
export async function listPendingSecretImports(stateDir: string): Promise<string[]> {
  if (!await directory(stateDir)) return [];
  return (await readdir(root(stateDir))).filter(name => /^pending-import-[a-f0-9-]{36}\.json$/.test(name)).map(name => name.slice(PREFIX.length, -5)).sort();
}
const validLegacy = (record: unknown): record is StoredSecret => !!record && typeof record === 'object'
  && ['id', 'name', 'origin', 'value', 'createdAt'].every(key => typeof (record as Record<string, unknown>)[key] === 'string');
/** Source password belongs only to this owner request; the pending file stays encrypted until commit succeeds. */
export async function importPendingSecret(stateDir: string, id: string, password: string, target: SecretService, options: { restoreTriggers?: (backup: TriggerBackup) => Promise<void> } = {}): Promise<void> {
  if (!validId(id)) throw new Error('Invalid secret import ID');
  if (!target.status().initialized || target.status().locked) throw new Error('Unlock the target Vault before importing secrets');
  await directory(stateDir);
  const path = join(root(stateDir), `${PREFIX}${id}.json`); const pending = await readPrivateJson(path, 45 * 1024 * 1024) as PendingSecret;
  if (pending.version !== 1 || typeof pending.content !== 'string') throw new Error('Invalid pending import');
  if (pending.kind === 'vault') await target.importEncryptedVault(decode(pending.content), password);
  else if (pending.kind === 'legacy') {
    const { payload } = await decryptBackup(pending.content, password); const value = payload as { version?: unknown; records?: unknown; triggers?: TriggerBackup };
    if (value?.version !== 1 || !Array.isArray(value.records) || !value.records.every(validLegacy)) throw new Error('Invalid pending legacy records');
    if (value.triggers && !options.restoreTriggers) throw new Error('The trigger engine must be ready before restoring its encrypted snapshot');
    await target.importLegacy(value.records);
    if (value.triggers) await options.restoreTriggers!(value.triggers);
  } else throw new Error('Unknown pending import format');
  await unlink(path); await syncDirectory(stateDir);
}
async function syncDirectory(stateDir: string) { const handle = await open(root(stateDir), 'r'); try { await handle.sync(); } finally { await handle.close(); } }
