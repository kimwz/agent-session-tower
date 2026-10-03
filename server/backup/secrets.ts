/** Backup's own part of encrypted secret imports: the trigger part and old secrets, encrypted with the backup passphrase. */
import { encryptBackup, decryptBackup } from './crypto.js';
import type { TriggerBackup } from '../triggers/backup.js';
import { validStoredSecret } from '../triggers/secrets.js';
import type { SecretService } from '../secrets/service.js';
import { encryptedVaultOf, importPendingSecret as importPending, listPendingSecretImports, stagePendingImport, stageVaultImport } from '../secrets/imports.js';

export { listPendingSecretImports, stageVaultImport };
export const collectEncryptedVault = encryptedVaultOf;

export async function stageLegacyImport(stateDir: string, records: unknown, passphrase: string, restoreId?: string, triggers?: TriggerBackup): Promise<string> {
  if (!Array.isArray(records) || !records.every(validStoredSecret)) throw new Error('Invalid legacy import');
  const content = await encryptBackup({ version: 1, records, ...(triggers ? { triggers } : {}) }, passphrase, { towerVersion: 'secret-legacy-import', from: 'encrypted-backup' });
  return stagePendingImport(stateDir, { version: 1, kind: 'legacy', content, restoreId });
}

/** Opens a `legacy` pending import with the backup passphrase it was encrypted with. */
export async function openLegacyImport(content: string, password: string): Promise<unknown> { return (await decryptBackup(content, password)).payload; }

/** `importPendingSecret` of the secrets owner, opening `legacy` imports with the backup passphrase. */
export function importPendingSecret(stateDir: string, id: string, password: string, target: SecretService, options: { restoreTriggers?: (backup: TriggerBackup) => Promise<void> } = {}): Promise<void> {
  return importPending(stateDir, id, password, target, { ...options, openLegacy: openLegacyImport });
}
