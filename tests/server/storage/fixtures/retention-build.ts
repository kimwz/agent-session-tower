import { build, type Plugin } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { storageManifest } from '../../../../server/storage/schema.js';
import { retentionSchema } from '../../../../server/sessions/retention/storage-schema.js';
import { buildIdentityModule, buildIdentityPlugin, STORAGE_BUNDLE_FORMAT, type StorageThreadArtifact } from '../../../../server/storage/thread-bundle.mjs';
import type * as Parent from './parent.js';

/** Actual A/B domain handlers and captured SDK compiled as future artifact versions; no mocked import support. */
export async function retentionBuild(version: '1.120.0' | '1.121.0', output?: string) {
  const directory = output ?? await mkdtemp(join(tmpdir(), 'tower-retention-artifact-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const versionPlugin: Plugin = { name: 'retention-fixture-release', setup(builder) {
    builder.onLoad({ filter: /[\\/]shared[\\/]app-identity\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${version}';`), loader: 'ts' }));
  } };
  const schema = version === '1.120.0' ? retentionSchema : { ...retentionSchema, cutover: { artifactVersion: version, importContract: 1 } };
  const manifest = storageManifest([schema], version);
  const artifacts: Record<string, StorageThreadArtifact> = {};
  for (const fault of version === '1.120.0' ? ['normal'] : ['normal', 'before', 'after']) {
    const entry = `
import { parentPort } from 'node:worker_threads';
import { runStorageThread } from './server/storage/thread/runtime.js';
import { retentionDomainFor } from './server/sessions/retention/storage-commands.js';
import { retentionSchema } from './server/sessions/retention/storage-schema.js';
const schema = ${version === '1.120.0' ? 'retentionSchema' : `{ ...retentionSchema, cutover: { artifactVersion: '${version}', importContract: 1 } }`};
${fault === 'normal' ? '' : `let commitId = -1;
parentPort.on('message', message => { if (message.op === 'write' && message.command === 'commit') { commitId = message.id; ${fault === 'before' ? 'process.exit(9);' : ''} } });
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => { if (message.id === commitId) process.exit(9); post(message); };`}
runStorageThread([retentionDomainFor(schema)]);`;
    const result = await build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'retention-fixture-thread.ts', loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', plugins: [versionPlugin], logLevel: 'silent' });
    const body = result.outputFiles[0].text, sourceHash = createHash('sha256').update(body).digest('hex');
    artifacts[fault] = { format: STORAGE_BUNDLE_FORMAT, sourceHash, source: `var __TOWER_STORAGE_SOURCE_HASH__ = "${sourceHash}";\n${body}` };
  }
  const parentPath = join(directory, 'parent.mjs');
  await build({ entryPoints: [join(root, 'tests/server/storage/fixtures/parent.ts')], outfile: parentPath, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [versionPlugin, buildIdentityPlugin(buildIdentityModule({ contexts: Object.values(artifacts).map(artifact => ({ sourceHash: artifact.sourceHash, manifest })) }))] });
  const storage = await import(pathToFileURL(parentPath).href) as typeof Parent;
  const bundle = (fault = 'normal') => {
    const captured = storage.storageBundleFromArtifact(JSON.stringify(artifacts[fault]), 'artifact');
    if (!captured.ok) throw new Error(captured.failure.message);
    return captured;
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ manifest, artifacts: Object.fromEntries(Object.entries(artifacts).map(([key, artifact]) => [key, artifact.sourceHash])) }));
  return { directory, version, manifest, storage, bundle };
}
