import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entryPoint, versionDirectory } from '../../../../server/link/service.js';
import { artifactStorageContract, type RunningBuild } from '../../../../server/link/storage-update.js';
import type { StorageBuildIdentity, StorageBuildManifest, StorageDomainSchema } from '../../../../server/storage/contract.js';
import type { StoragePreflight } from '../../../../server/storage/preflight.js';
import { manifestDigest, storageManifest } from '../../../../server/storage/schema.js';

/**
 * Three releases of a staged domain, as their manifests say: L keeps everything in JSON (no storage contract at all),
 * A prepares the `retention` domain (its schema, reader and writer, no cutover), B imports it. A later release C
 * imports it too; A0 has a storage contract without the domain (PR0's shape).
 */
export const L = '1.0.0';
export const A0 = '1.0.5';
export const A = '1.1.0';
export const B = '1.2.0';
export const C = '1.3.0';

export const retentionA: StorageDomainSchema = {
  domain: 'retention',
  migrations: [{ version: 1, sql: 'CREATE TABLE retention_items (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;' }],
  preparation: { requiredArtifactVersion: A, readerContract: 1, writerContract: 1 },
};
export const retentionB: StorageDomainSchema = { ...retentionA, cutover: { artifactVersion: B, importContract: 1 } };

export const manifests: Record<string, StorageBuildManifest> = {
  [A0]: storageManifest([], A0),
  [A]: storageManifest([retentionA], A),
  [B]: storageManifest([retentionB], B),
  [C]: storageManifest([retentionB], C),
};

/** Any other version is another preparation release of the domain. */
export const manifestOf = (version: string) => manifests[version] ?? storageManifest([retentionA], version);
export const identityOf = (version: string, salt = '', manifest = manifestOf(version)): StorageBuildIdentity => ({
  appVersion: version, protocol: manifest.protocol, sourceHash: createHash('sha256').update(`fixture-thread-${version}${salt}`).digest('hex'), manifestDigest: manifest.digest,
});
/** `version`'s manifest changed by `change` (its digest recomputed), for a build that declares another schema. */
export function changedManifest(version: string, change: (body: Omit<StorageBuildManifest, 'digest'>) => Omit<StorageBuildManifest, 'digest'>): StorageBuildManifest {
  const { digest: _, ...body } = structuredClone(manifestOf(version));
  const next = change(body);
  return { ...next, digest: manifestDigest(next) };
}
const runtime = { node: 'v24.15.0', sqlite: '3.51.3', platform: process.platform, arch: process.arch, execPath: process.execPath, apis: { DatabaseSync: true, StatementSync: true } };

/** What the running build's worker saw: its trusted manifest and a passing runtime preflight, with the state as given. */
export function runningBuild(version: string, options: { supported?: boolean; state?: StoragePreflight['state']; salt?: string; manifest?: StorageBuildManifest } = {}): RunningBuild {
  const manifest = options.manifest ?? manifestOf(version);
  const identity = identityOf(version, options.salt, manifest);
  const supported = options.supported ?? true;
  return {
    version, manifest,
    preflight: {
      supported, identity, runtime,
      ...(supported ? {} : { refusal: { phase: 'runtime' as const, code: 'unsupported-runtime' as const, message: 'Node.js v20.0.0 is not a verified storage runtime.' } }),
      state: options.state ?? { database: 'absent', sidecars: [], identity: 'absent', recovery: { state: 'clear' } },
    },
  };
}

/**
 * Installs `version` under the state directory's versions/ as an artifact whose entry point answers like a real
 * release: `--version`, and `--storage-contract` with the contract the real producer (artifactStorageContract) makes
 * from its build's identity and manifest; a JSON-only release refuses the option exactly as Tower's CLI does.
 */
export async function installArtifact(stateDir: string, version: string, options: { legacy?: boolean; supported?: boolean; salt?: string; broken?: boolean; manifest?: StorageBuildManifest } = {}): Promise<string> {
  const directory = versionDirectory(stateDir, version);
  const entry = entryPoint(directory);
  await mkdir(join(entry, '..'), { recursive: true });
  if (!options.legacy) {
    const build = runningBuild(version, { supported: options.supported, salt: options.salt, manifest: options.manifest });
    const contract = artifactStorageContract({ identity: build.preflight.identity!, manifest: build.manifest! }, build.preflight);
    await writeFile(join(entry, '..', 'contract.json'), options.broken ? '{"format":"tower-artifact-storage-contract"' : JSON.stringify(contract));
  }
  await writeFile(entry, `import { readFileSync } from 'node:fs';
const argument = process.argv[2];
if (argument === '--version') console.log(${JSON.stringify(version)});
else if (argument === '--storage-contract' && ${!options.legacy}) process.stdout.write(readFileSync(new URL('./contract.json', import.meta.url), 'utf8') + '\\n');
else { console.error('Agent Session Tower: Unknown option: ' + argument + '. Run with --help for usage.'); process.exitCode = 1; }
`);
  return directory;
}
