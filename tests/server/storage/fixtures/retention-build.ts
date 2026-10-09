import { build, type Plugin } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { storageManifest } from '../../../../server/storage/schema.js';
import { retentionSchema } from '../../../../server/sessions/retention/storage-schema.js';
import { runsSchema } from '../../../../server/runs/storage-schema.js';
import { buildIdentityModule, buildIdentityPlugin, STORAGE_BUNDLE_FORMAT, type StorageThreadArtifact } from '../../../../server/storage/thread-bundle.mjs';
import type * as Parent from './parent.js';

/** Actual A/B domain handlers and captured SDK compiled as future artifact versions; no mocked import support. */
export async function retentionBuild(version: '1.120.0' | '1.120.1' | '1.120.2' | '1.121.0' | '1.122.0' | '1.123.0', output?: string, retentionCutover = version === '1.121.0' || version === '1.123.0') {
  const directory = output ?? await mkdtemp(join(tmpdir(), 'tower-retention-artifact-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const old = version === '1.120.0';
  const runsRelease = version === '1.122.0' || version === '1.123.0';
  const preparation = !runsRelease && version !== '1.121.0';
  const captureRoot = fileURLToPath(new URL(old ? './retention-a120/' : './retention-a1201/', import.meta.url));
  const capture = preparation ? JSON.parse(await readFile(join(captureRoot, 'capture.json'), 'utf8')) : undefined;
  const versionPlugin: Plugin = { name: 'retention-fixture-release', setup(builder) {
    if (preparation) builder.onLoad({ filter: /[\\/]server[\\/]sessions[\\/]retention[\\/]storage-(schema|commands)\.ts$/ }, async args => {
      const name = args.path.split(/[\\/]/).at(-1)!;
      const contents = await readFile(join(captureRoot, `${name}.txt`), 'utf8');
      if (createHash('sha256').update(contents).digest('hex') !== capture.files[`server/sessions/retention/${name}`]) throw new Error('Old A capture hash mismatch.');
      return { contents, loader: 'ts' };
    });
    if (version === '1.123.0') builder.onLoad({ filter: /[\\/]server[\\/]runs[\\/]storage-schema\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace("domain: 'runs', preparation:", "domain: 'runs', cutover: { artifactVersion: '1.123.0', importContract: 1 }, preparation:"), loader: 'ts' }));
    builder.onLoad({ filter: /[\\/]shared[\\/]app-identity\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${version}';`), loader: 'ts' }));
  } };
  const { cutover: _cutover, ...preparedSchema } = retentionSchema;
  const schema = old ? { ...preparedSchema, preparation: { ...preparedSchema.preparation!, requiredArtifactVersion: '1.120.0' }, migrations: preparedSchema.migrations.slice(0, 1) } : preparation ? { ...preparedSchema, preparation: { ...preparedSchema.preparation!, requiredArtifactVersion: capture.preparationMinimum } } : !retentionCutover ? preparedSchema : { ...retentionSchema, cutover: { artifactVersion: '1.121.0', importContract: 1 } };
  if (old) {
    const capturedSchema = await readFile(join(captureRoot, 'storage-schema.ts.txt'), 'utf8');
    const currentSchema = await readFile(join(root, 'server/sessions/retention/storage-schema.ts'), 'utf8');
    const firstSql = (source: string) => source.split('version: 1, sql: `')[1]?.split('`.trim() }')[0];
    if (!firstSql(capturedSchema) || firstSql(capturedSchema) !== firstSql(currentSchema)) throw new Error('Old A migration1 changed.');
  }
  const manifest = storageManifest(runsRelease ? [schema, version === '1.123.0' ? { ...runsSchema, cutover: { artifactVersion: '1.123.0', importContract: 1 } } : runsSchema] : [schema], version);
  const artifacts: Record<string, StorageThreadArtifact> = {};
  for (const fault of preparation ? ['normal', 'after-native-hold'] : ['normal', 'before', 'after', 'after-native-hold', 'after-steer-hold', 'runs-refuse-compensation-loss', 'after-unsent-compensation', 'refuse-once', 'corrupt', 'io']) {
    const entry = `
import { parentPort } from 'node:worker_threads';
import { existsSync, writeFileSync } from 'node:fs';
import { runStorageThread } from './server/storage/thread/runtime.js';
import { retentionDomainFor } from './server/sessions/retention/storage-commands.js';
import { retentionSchema } from './server/sessions/retention/storage-schema.js';
${runsRelease ? `import { runsDomain } from './server/runs/storage-commands.js';` : ''}
const schema = ${retentionCutover ? `{ ...retentionSchema, cutover: { artifactVersion: '1.121.0', importContract: 1 } }` : 'retentionSchema'};
${!['before', 'after'].includes(fault) ? '' : `let commitId = -1;
parentPort.on('message', message => { if (message.op === 'write' && message.command === 'commit') { commitId = message.id; ${fault === 'before' ? 'process.exit(9);' : ''} } });
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => { if (message.id === commitId) process.exit(9); post(message); };`}
const domain = retentionDomainFor(schema);
${['after-native-hold', 'after-steer-hold', 'runs-refuse-compensation-loss'].includes(fault) ? `let lostIntent, lostCommitId = -1;
const lossMarker = ${JSON.stringify(join(directory, `${fault}-consumed`))};
parentPort.on('message', message => {
  if (!existsSync(lossMarker) && message.op === 'write' && message.command === 'stage' && Buffer.from(JSON.parse(message.payload).data, 'base64').toString('utf8').includes(${JSON.stringify(fault === 'after-steer-hold' ? 'sending' : 'native-hold-response-lost')})) lostIntent = JSON.parse(message.payload).intent;
  if (message.op === 'write' && message.command === 'commit' && lostIntent && JSON.parse(message.payload).intent === lostIntent) lostCommitId = message.id;
});
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => { if (message.id === lostCommitId && message.ok) { writeFileSync(lossMarker, 'consumed', { flag: 'wx', mode: 0o600 }); process.exit(9); } post(message); };` : ''}
${fault === 'after-unsent-compensation' && runsRelease ? `let armed = false, compensationIntent, compensationCommit = -1;
const compensationMarker = ${JSON.stringify(join(directory, 'after-unsent-compensation-consumed'))};
parentPort.on('message', message => {
  if (existsSync(compensationMarker) || message.domain !== 'runs' || message.op !== 'write') return;
  const payload = JSON.parse(message.payload);
  if (message.command === 'stage') {
    const text = Buffer.from(payload.data, 'base64').toString('utf8');
    if (text.includes('sending')) armed = true;
    else if (armed && text.includes('queued')) compensationIntent = payload.intent;
  }
  if (message.command === 'commit' && payload.intent === compensationIntent) compensationCommit = message.id;
});
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => { if (message.id === compensationCommit && message.ok) { writeFileSync(compensationMarker, 'consumed', { flag: 'wx', mode: 0o600 }); process.exit(9); } post(message); };` : ''}
${fault === 'runs-refuse-compensation-loss' && runsRelease ? `const commit = runsDomain.commands.commit;
let refused = false;
runsDomain.commands.commit = { ...commit, run(context, payload) {
  if (!refused && lostIntent === payload.intent && !existsSync(lossMarker)) { refused = true; throw Object.assign(new Error('fixture known runs write refusal'), { storageCode: 'domain-failed' }); }
  return commit.run(context, payload);
} };` : ''}
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
runStorageThread([domain${runsRelease ? ', runsDomain' : ''}]);`;
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
