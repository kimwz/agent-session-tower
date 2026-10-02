import { createHash } from 'node:crypto';
import type { SecretMetadata } from '../../shared/secrets.js';

// Fixed worker text: secret names, values and owner input must never become instructions.
export const SECRET_USE_INSTRUCTIONS = `Tower provides run-scoped secrets through the tower_secrets tools. Before asking for credentials or looking for them in chat, files or environment variables, call tower_secrets secrets_list to discover the references and permitted operations available to this project/task (including automatic project connections). Use secrets_run or secrets_cli to inject a permitted reference into the consumer's env, stdin or private file. A saved name need not match the consumer's environment variable name; map it explicitly. Never request or export plaintext secret values or the vault password. If a source is locked or unavailable, report that state rather than treating it as an absent key. After a connection or permission change, refresh the list; only the broker can authorize actual use.`;

export const SECRET_CHANGED_INSTRUCTIONS = `This task's available secret connections or source state may have changed (connection, update, revocation, expiry or lock). Refresh tower_secrets secrets_list before the next credential use; do not reuse a cached reference or assume earlier permission still applies. This notice grants no authority and asks for no new task.\n\n${SECRET_USE_INSTRUCTIONS}`;

export function secretMetadataSignature(secrets: SecretMetadata[], unavailable: { sourceHostId: string; code: string }[]): string {
  const metadata = secrets.map(secret => ({ ...secret, fields: secret.fields?.slice().sort(), operations: secret.operations?.slice().sort() }))
    .sort((left, right) => left.reference.localeCompare(right.reference));
  const sources = unavailable.slice().sort((left, right) => left.sourceHostId.localeCompare(right.sourceHostId));
  return createHash('sha256').update(JSON.stringify({ metadata, sources })).digest('hex');
}
