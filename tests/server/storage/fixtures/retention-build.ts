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
export async function retentionBuild(version: '1.120.0' | '1.120.1' | '1.120.2' | '1.121.0', output?: string) {
  const directory = output ?? await mkdtemp(join(tmpdir(), 'tower-retention-artifact-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const old = version === '1.120.0';
  const preparation = version !== '1.121.0';
  const captureRoot = fileURLToPath(new URL(old ? './retention-a120/' : './retention-a1201/', import.meta.url));
  const capture = preparation ? JSON.parse(await readFile(join(captureRoot, 'capture.json'), 'utf8')) : undefined;
  const versionPlugin: Plugin = { name: 'retention-fixture-release', setup(builder) {
    if (preparation) builder.onLoad({ filter: /[\\/]server[\\/]sessions[\\/]retention[\\/]storage-(schema|commands)\.ts$/ }, async args => {
      const name = args.path.split(/[\\/]/).at(-1)!;
      const contents = await readFile(join(captureRoot, `${name}.txt`), 'utf8');
      if (createHash('sha256').update(contents).digest('hex') !== capture.files[`server/sessions/retention/${name}`]) throw new Error('Old A capture hash mismatch.');
      return { contents, loader: 'ts' };
    });
    builder.onLoad({ filter: /[\\/]shared[\\/]app-identity\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${version}';`), loader: 'ts' }));
  } };
  const { cutover: _cutover, ...preparedSchema } = retentionSchema;
  const schema = old ? { ...preparedSchema, preparation: { ...preparedSchema.preparation!, requiredArtifactVersion: '1.120.0' }, migrations: preparedSchema.migrations.slice(0, 1) } : preparation ? preparedSchema : retentionSchema;
  if (old) {
    const capturedSchema = await readFile(join(captureRoot, 'storage-schema.ts.txt'), 'utf8');
    const currentSchema = await readFile(join(root, 'server/sessions/retention/storage-schema.ts'), 'utf8');
    const firstSql = (source: string) => source.split('version: 1, sql: `')[1]?.split('`.trim() }')[0];
    if (!firstSql(capturedSchema) || firstSql(capturedSchema) !== firstSql(currentSchema)) throw new Error('Old A migration1 changed.');
  }
  const manifest = storageManifest([schema], version);
  const artifacts: Record<string, StorageThreadArtifact> = {};
  for (const fault of version !== '1.121.0' ? ['normal', 'after-native-hold'] : ['normal', 'before', 'after', 'after-native-hold', 'refuse-once', 'corrupt', 'io']) {
    const entry = `
import { parentPort } from 'node:worker_threads';
import { runStorageThread } from './server/storage/thread/runtime.js';
import { retentionDomainFor } from './server/sessions/retention/storage-commands.js';
import { retentionSchema } from './server/sessions/retention/storage-schema.js';
const schema = ${version !== '1.121.0' ? 'retentionSchema' : `{ ...retentionSchema, cutover: { artifactVersion: '${version}', importContract: 1 } }`};
${!['before', 'after'].includes(fault) ? '' : `let commitId = -1;
parentPort.on('message', message => { if (message.op === 'write' && message.command === 'commit') { commitId = message.id; ${fault === 'before' ? 'process.exit(9);' : ''} } });
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => { if (message.id === commitId) process.exit(9); post(message); };`}
const domain = retentionDomainFor(schema);
${fault === 'after-native-hold' ? `let loseNextCommit = false, lostCommitId = -1;
parentPort.on('message', message => {
  if (message.op === 'write' && message.command === 'stage' && Buffer.from(JSON.parse(message.payload).data, 'base64').toString('utf8').includes('native-hold-response-lost')) loseNextCommit = true;
  if (message.op === 'write' && message.command === 'commit' && loseNextCommit) lostCommitId = message.id;
});
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => { if (message.id === lostCommitId && message.ok) process.exit(9); post(message); };` : ''}
${fault === 'refuse-once' ? `const commit = domain.commands.commit;
let refused = false;
domain.commands.commit = { ...commit, run(context, payload) {
  if (!refused) { refused = true; throw Object.assign(new Error('fixture known write refusal'), { storageCode: 'domain-failed' }); }
  return commit.run(context, payload);
} };` : ''}
${['corrupt', 'io'].includes(fault) ? `const head = domain.commands.head;
domain.commands.head = { ...head, run(context, payload) {
  const sqlite = process.getBuiltinModule('node:sqlite');
  // Genuine SQLite errors on disposable fixture paths, classified by the
  // production thread; no fabricated errcode or replacement SDK response.
  const db = new sqlite.DatabaseSync(${JSON.stringify(join(directory, fault === 'corrupt' ? 'corrupt.sqlite' : 'missing-parent/io.sqlite'))});
  try { db.prepare('SELECT * FROM damage').all(); } finally { db.close(); }
  return head.run(context, payload);
} };` : ''}
runStorageThread([domain]);`;
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
