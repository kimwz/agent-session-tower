/**
 * Encrypted secret imports waiting for the owner, in `<state>/secrets/pending-import-<id>.json`: a Vault from a backup
 * (kept encrypted by its own Vault password) or older trigger secrets and the trigger part (encrypted by the backup's
 * passphrase, opened through `openLegacy`). Each is imported by an explicit owner request and removed only after it
 * committed.
 */
import { mkdir, readdir, unlink, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { TriggerBackup } from '../triggers/backup.js';
import { validStoredSecret } from '../triggers/secrets.js';
import { decode } from './crypto.js';
import type { SecretService } from './service.js';
import { SecretVault } from './vault.js';

const PREFIX = 'pending-import-';
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
const root = (stateDir: string) => join(stateDir, 'secrets');
export interface PendingSecretImport { version: 1; kind: 'vault' | 'legacy'; content: string; restoreId?: string }
async function directory(stateDir: string, create = false) {
  if (create) await mkdir(root(stateDir), { recursive: true, mode: 0o700 });
  try { if (!(await lstat(root(stateDir))).isDirectory()) throw new Error('Invalid secret import directory'); return true; }
  catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** This computer's Vault file as it is on disk, base64 (still encrypted; never unlocked here), when it has one. */
export async function encryptedVaultOf(stateDir: string): Promise<string | undefined> {
  const vault = new SecretVault(stateDir); await vault.start();
  if (!vault.initialized) return undefined;
  return (await vault.read('vault.json'))!.toString('base64');
}
export async function stageVaultImport(stateDir: string, content: string, restoreId?: string): Promise<string> {
  const bytes = decode(content); if (bytes.length > 16 * 1024 * 1024) throw new Error('Vault import size limit');
  const envelope = JSON.parse(bytes.toString()); if (envelope?.format !== 1 || typeof envelope.vaultId !== 'string' || !envelope.wrappedKey || !envelope.payload) throw new Error('Invalid encrypted vault');
  return stagePendingImport(stateDir, { version: 1, kind: 'vault', content, restoreId });
}
export async function stagePendingImport(stateDir: string, pending: PendingSecretImport): Promise<string> {
  await directory(stateDir, true);
  // A crash or retry of the same restore keeps one reviewable pending import.
  if (pending.restoreId) for (const id of await listPendingSecretImports(stateDir)) {
    const saved = await readPrivateJson(join(root(stateDir), `${PREFIX}${id}.json`), 45 * 1024 * 1024) as PendingSecretImport;
    if (saved.restoreId === pending.restoreId && saved.kind === pending.kind) return id;
  }
  const id = randomUUID(); await writePrivateJson(join(root(stateDir), `${PREFIX}${id}.json`), JSON.stringify(pending), { syncDirectory: true }); return id;
}
export async function listPendingSecretImports(stateDir: string): Promise<string[]> {
  if (!await directory(stateDir)) return [];
  return (await readdir(root(stateDir))).filter(name => /^pending-import-[a-f0-9-]{36}\.json$/.test(name)).map(name => name.slice(PREFIX.length, -5)).sort();
}
/** Source password belongs only to this owner request; the pending file stays encrypted until commit succeeds. */
export async function importPendingSecret(stateDir: string, id: string, password: string, target: SecretService, options: { openLegacy: (content: string, password: string) => Promise<unknown>; restoreTriggers?: (backup: TriggerBackup) => Promise<void> }): Promise<void> {
  if (!validId(id)) throw new Error('Invalid secret import ID');
  if (!target.status().initialized || target.status().locked) throw new Error('Unlock the target Vault before importing secrets');
  await directory(stateDir);
  const path = join(root(stateDir), `${PREFIX}${id}.json`); const pending = await readPrivateJson(path, 45 * 1024 * 1024) as PendingSecretImport;
  if (pending.version !== 1 || typeof pending.content !== 'string') throw new Error('Invalid pending import');
  if (pending.kind === 'vault') await target.importEncryptedVault(decode(pending.content), password);
  else if (pending.kind === 'legacy') {
    const value = await options.openLegacy(pending.content, password) as { version?: unknown; records?: unknown; triggers?: TriggerBackup };
    if (value?.version !== 1 || !Array.isArray(value.records) || !value.records.every(validStoredSecret)) throw new Error('Invalid pending legacy records');
    if (value.triggers && !options.restoreTriggers) throw new Error('The trigger engine must be ready before restoring its encrypted snapshot');
    await target.importLegacy(value.records);
    if (value.triggers) await options.restoreTriggers!(value.triggers);
  } else throw new Error('Unknown pending import format');
  await unlink(path); await syncDirectory(stateDir);
}
async function syncDirectory(stateDir: string) { const handle = await open(root(stateDir), 'r'); try { await handle.sync(); } finally { await handle.close(); } }

/**
 * With a Vault on either side (this computer has one, or the backup's was staged), the backup's plaintext trigger
 * secrets and its trigger part wait for an encrypted import instead of going to the worker.
 */
export function deferredSecretParts(worker: { files: { 'trigger-secrets.json'?: unknown }; triggers?: TriggerBackup }, targetHasVault: boolean, staged: boolean): { legacy?: { records: unknown; triggers?: TriggerBackup } } {
  if (!(targetHasVault || staged) || (worker.files['trigger-secrets.json'] === undefined && !worker.triggers)) return {};
  return { legacy: { records: worker.files['trigger-secrets.json'] ?? [], ...(worker.triggers ? { triggers: worker.triggers } : {}) } };
}
