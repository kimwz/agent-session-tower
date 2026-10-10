import { build, type Plugin } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { storageManifest } from '../../../../server/storage/schema.js';
import { retentionSchema } from '../../../../server/sessions/retention/storage-schema.js';
import { triggersSchema } from '../../../../server/triggers/storage-schema.js';
import { permissionsSchema } from '../../../../server/permissions/storage-schema.js';
import { remoteSchema } from '../../../../server/remote/storage-schema.js';
import { autoPromptSchema } from '../../../../server/auto-prompt/storage-schema.js';
import { workflowsSchema } from '../../../../server/slack/storage-schema.js';
import { runsSchema } from '../../../../server/runs/storage-schema.js';
import { buildIdentityModule, buildIdentityPlugin, STORAGE_BUNDLE_FORMAT, type StorageThreadArtifact } from '../../../../server/storage/thread-bundle.mjs';
import type * as Parent from './parent.js';
import { fixtureSchema } from './fixture-domain.js';
export interface OfflineServiceFixture { installed:boolean; loadedAtCheck?:number; ownerAtCheck?:number; readFailure?:boolean; ownerReadFailure?:boolean; managerQueryFailure?:boolean }

/** Actual A/B domain handlers and captured SDK compiled as future artifact versions; no mocked import support. */
export async function retentionBuild(version: '1.120.0' | '1.120.1' | '1.120.2' | '1.121.0' | '1.122.0' | '1.123.0' | '1.124.0' | '1.125.0' | '1.125.1', output?: string, retentionCutover = version === '1.121.0' || version === '1.123.0' || (version === '1.125.0' || version === '1.125.1'), includePermissions = false, externalDomains = false, product?: {artifact:StorageThreadArtifact;manifest:import('../../../../server/storage/contract.js').StorageBuildManifest;serviceFixture?:OfflineServiceFixture}, threadFaultDomain = false, defaultFault = 'normal') {
  const directory = output ?? await mkdtemp(join(tmpdir(), 'tower-retention-artifact-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const old = version === '1.120.0';
  const triggersRelease = version === '1.124.0' || (version === '1.125.0' || version === '1.125.1');
  const runsRelease = version === '1.122.0' || version === '1.123.0' || triggersRelease;
  const preparation = !runsRelease && version !== '1.121.0';
  const captureRoot = fileURLToPath(new URL(old ? './retention-a120/' : './retention-a1201/', import.meta.url));
  const capture = preparation ? JSON.parse(await readFile(join(captureRoot, 'capture.json'), 'utf8')) : undefined;
  const actualARoot = fileURLToPath(new URL('./runs-a122/', import.meta.url));
  const actualACapture = version === '1.122.0' && !retentionCutover ? JSON.parse(await readFile(join(actualARoot, 'capture.json'), 'utf8')) : undefined;
  const actualABytes = actualACapture ? await readFile(join(actualARoot, 'thread-bundle.json')) : undefined;
  if (actualACapture) {
    if (actualACapture.publicCommit !== '1544951f5b6abfeb238e1e8f155085a6dd22c6b6' || actualACapture.officialAssetId !== 625897302 || actualACapture.officialPackageSHA256 !== '438767a17b42db5c021b8d9f91f650b9b6c24eeaf7272ea90e9992feaf85a2fd' || actualACapture.identity.sourceHash !== '7c5ffc9947cb27e8f21b158d3136f6ea22cc971552c51327f64d6c297673be58' || actualACapture.identity.manifestDigest !== 'abd94a8900c786e97d28ec9a9dee59f86f1c8dfb133906ecbea538e39560f038') throw new Error('Actual A122 release provenance mismatch.');
    if (actualACapture.threadArtifactSHA256 !== 'bc4e8dda2a0e1cd8abb2d889b810a47edc3548df2a06f7bf52a36c19d8efb660' || actualABytes!.length !== 72980 || createHash('sha256').update(actualABytes!).digest('hex') !== actualACapture.threadArtifactSHA256) throw new Error('Actual A122 artifact bytes/hash mismatch.');
    for (const fact of Object.values(actualACapture.files) as { captureFile: string; sha256: string }[]) {
      if (createHash('sha256').update(await readFile(join(actualARoot, fact.captureFile))).digest('hex') !== fact.sha256) throw new Error('Actual A122 schema capture mismatch.');
    }
  }
  const triggerARoot = fileURLToPath(new URL('./triggers-a124/', import.meta.url));
  const triggerACapture = version === '1.124.0' ? JSON.parse(await readFile(join(triggerARoot,'capture.json'),'utf8')) : undefined;
  const triggerABytes = triggerACapture ? await readFile(join(triggerARoot,'thread-bundle.json')) : undefined;
  if (triggerACapture) {
    if (triggerACapture.publicCommit !== '0ef1f1df85b2b7c546c6e691283bb0a26123bbad' || triggerACapture.officialAssetId !== 626540259 || triggerACapture.officialPackageSHA256 !== '5647224b149023ad8f5a429832c1fc6b3012e7b27c16808a1fc2af6b00ef371d') throw new Error('Actual A124 release provenance mismatch.');
    const expected = { 'thread-bundle.json': '80664388b126c95cf5355cdf7636900c0254a7dc3c72693d6ef6176e10c02432', 'storage-schema.js.txt': 'faf9155abfeca96948f76649267a2c28d3fbadac45ed22c44a7faa499b8a3b34', 'triggers-storage-schema.js.txt': '0df71f3dd6ab9fc20a90b6a87414d186bfd34339477927d7533bea79a39575d3' };
    for (const [name,sha256] of Object.entries(expected)) if (createHash('sha256').update(await readFile(join(triggerARoot,name))).digest('hex') !== sha256 || triggerACapture.files[name]?.sha256 !== sha256) throw new Error('Actual A124 capture bytes/hash mismatch.');
    if (triggerABytes!.length !== 827112) throw new Error('Actual A124 artifact length mismatch.');
  }
  const versionPlugin: Plugin = { name: 'retention-fixture-release', setup(builder) {
    const serviceFixture=product?.serviceFixture;
    if(serviceFixture) {
      // Only the OS manager boundary is replaced. Actual installation reuse, pointer/pin,
      // captured SDK, selected executable contract and SQL completion remain product code.
      builder.onResolve({filter:/^\.\/service\.js$/},args=>args.importer.endsWith('/server/link/cli.ts') ? {path:'offline-service-manager',namespace:'offline-fixture'} : undefined);
      builder.onLoad({filter:/^offline-service-manager$/,namespace:'offline-fixture'},()=>({loader:'ts',resolveDir:root,contents:`
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { currentVersion } from ${JSON.stringify(join(root,'server/link/service.ts'))};
export * from ${JSON.stringify(join(root,'server/link/service.ts'))};
let statusChecks=0;
export async function serviceStatus(stateDir:string) {
 if(${!!serviceFixture.readFailure}) throw new Error('fixture manager read unavailable');
 return {manager:'launchd',installed:${serviceFixture.installed},loaded:++statusChecks>=${serviceFixture.loadedAtCheck ?? 'Infinity'},version:await currentVersion(stateDir)};
}
export async function installService(stateDir:string,input:unknown) {
 await writeFile(join(stateDir,'offline-service-fixture-start.json'),JSON.stringify({version:await currentVersion(stateDir),input}),{flag:'wx',mode:0o600});
 return 'launchd';
}` }));
      builder.onResolve({filter:/^\.\.\/instance\/state-lock\.js$/},args=>args.importer.endsWith('/server/link/cli.ts') ? {path:'offline-owner-query',namespace:'offline-fixture'} : undefined);
      builder.onResolve({filter:/^node:child_process$/},args=>args.importer.endsWith('/server/link/cli.ts') ? {path:'offline-manager-query',namespace:'offline-fixture'} : undefined);
      builder.onLoad({filter:/^offline-manager-query$/,namespace:'offline-fixture'},()=>({loader:'ts',contents:`
import { execFile as actualExecFile } from 'node:child_process';
import { promisify } from 'node:util';
export * from 'node:child_process';
export const execFile=Object.assign((...args:any[])=>actualExecFile(...args),{
 [promisify.custom]:async(command:string,args:string[],options:unknown)=>{
   if(command==='launchctl') {
     if(${!!serviceFixture.managerQueryFailure}) throw new Error('fixture manager query unavailable');
     return {stdout:'services = {\\n}',stderr:''};
   }
   return promisify(actualExecFile)(command,args,options);
 }
});
`}));
      builder.onLoad({filter:/^offline-owner-query$/,namespace:'offline-fixture'},()=>({loader:'ts',resolveDir:root,contents:`
export * from ${JSON.stringify(join(root,'server/instance/state-lock.ts'))};
let ownerChecks=0;
export async function lockOwners() {
 if(${!!serviceFixture.ownerReadFailure}) throw new Error('fixture owner read unavailable');
 return ++ownerChecks>=${serviceFixture.ownerAtCheck ?? 'Infinity'} ? [{pid:2147483647,port:1}] : [];
}
`}));
    }

    if (preparation) builder.onLoad({ filter: /[\\/]server[\\/]sessions[\\/]retention[\\/]storage-(schema|commands)\.ts$/ }, async args => {
      const name = args.path.split(/[\\/]/).at(-1)!;
      const contents = await readFile(join(captureRoot, `${name}.txt`), 'utf8');
      if (createHash('sha256').update(contents).digest('hex') !== capture.files[`server/sessions/retention/${name}`]) throw new Error('Old A capture hash mismatch.');
      return { contents, loader: 'ts' };
    });
    if (version === '1.122.0') builder.onLoad({ filter: /[\\/]server[\\/](runs|sessions[\\/]retention)[\\/]storage-schema\.ts$/ }, async args => {
      const domain = args.path.includes('/runs/') ? 'runs' : 'retention';
      return { contents: await readFile(join(actualARoot, `${domain}-storage-schema.ts.txt`), 'utf8'), loader: 'ts' };
    });
    if (!runsRelease && !preparation) builder.onLoad({ filter: /[\\/]server[\\/]runs[\\/]storage-schema\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace(/cutover: \{ artifactVersion: '1.123.0', importContract: 1 \}, /, ''), loader: 'ts' }));
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
  const { cutover: _runsCutover, ...runsPreparation } = runsSchema;
  const runProfile = version === '1.123.0' || (version === '1.125.0' || version === '1.125.1') ? { ...runsSchema,cutover: { artifactVersion: '1.123.0',importContract: 1 } } : runsPreparation;
  const { cutover: _triggerCutover, ...triggerPreparation } = triggersSchema;
  const triggerProfile = (version === '1.125.0' || version === '1.125.1') ? triggersSchema : triggerPreparation;
  if (externalDomains && version !== '1.125.0' && version !== '1.125.1') throw new Error('External fixture requires final artifact.');
  const manifest = storageManifest(runsRelease ? [schema,runProfile,...(triggersRelease ? [triggerProfile] : []), ...(includePermissions ? [permissionsSchema] : []), ...(externalDomains ? [remoteSchema,autoPromptSchema,workflowsSchema] : []), ...(threadFaultDomain ? [fixtureSchema] : [])] : [schema],version);
  if (triggerACapture && manifest.digest !== triggerACapture.identity.manifestDigest) throw new Error('Actual A124 manifest mismatch.');
  if (actualACapture && manifest.digest !== actualACapture.identity.manifestDigest) throw new Error('Actual A122 manifest mismatch.');
  const artifacts: Record<string, StorageThreadArtifact> = {};
  for (const fault of preparation ? ['normal', 'after-native-hold'] : ['normal', ...(externalDomains ? ['remote-completed-refused', 'inspect-exit-once'] : []), 'before', 'after', 'after-native-hold', 'after-steer-hold', 'runs-refuse-compensation-loss', ...(runsRelease ? ['after-unsent-compensation'] : []), 'refuse-once', 'corrupt', 'io']) {
    const entry = `
import { parentPort } from 'node:worker_threads';
import { existsSync, writeFileSync } from 'node:fs';
import { runStorageThread } from './server/storage/thread/runtime.js';
import { retentionDomainFor } from './server/sessions/retention/storage-commands.js';
import { retentionSchema } from './server/sessions/retention/storage-schema.js';
${runsRelease ? `import { runsDomainFor } from './server/runs/storage-commands.js';
import { permissionsSchema } from './server/permissions/storage-schema.js';
import { remoteSchema } from './server/remote/storage-schema.js';
import { autoPromptSchema } from './server/auto-prompt/storage-schema.js';
import { workflowsSchema } from './server/slack/storage-schema.js';
import { runsSchema } from './server/runs/storage-schema.js';
const runsDomain = runsDomainFor(${version === '1.123.0' || (version === '1.125.0' || version === '1.125.1') ? `{ ...runsSchema,cutover: { artifactVersion: '1.123.0',importContract: 1 } }` : '{ ...runsSchema, cutover: undefined }'});` : ''}
${triggersRelease ? `import { triggersDomainFor } from './server/triggers/storage-commands.js';
import { triggersSchema } from './server/triggers/storage-schema.js';
const triggersDomain = triggersDomainFor(${(version === '1.125.0' || version === '1.125.1') ? `{ ...triggersSchema,cutover: { artifactVersion: '1.125.0',importContract: 1 } }` : '{ ...triggersSchema,cutover: undefined }'});` : ''}
${includePermissions ? `import { permissionsDomain } from './server/permissions/storage-commands.js';` : ''}
${externalDomains ? `import { remoteDomain } from './server/remote/storage-commands.js';
import { autoPromptDomain } from './server/auto-prompt/storage-commands.js';
import { workflowsDomain } from './server/slack/storage-commands.js';` : ''}
${threadFaultDomain ? `import { fixtureDomain, fault } from './tests/server/storage/fixtures/fixture-domain.js';
const postFault = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => { if (fault.dieBeforeAnswer) process.exit(9); postFault(message); };` : ''}
${fault === 'inspect-exit-once' ? `parentPort.on('message', message => {
  const armed = ${JSON.stringify(join(directory, 'inspect-exit-armed'))}, consumed = ${JSON.stringify(join(directory, 'inspect-exit-consumed'))};
  if (message.op === 'inspect' && existsSync(armed) && !existsSync(consumed)) { writeFileSync(consumed, 'consumed', {flag:'wx',mode:0o600}); process.exit(9); }
});` : ''}
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
${fault === 'remote-completed-refused' && externalDomains ? `const mutate = remoteDomain.commands.mutate;
remoteDomain.commands.mutate = { ...mutate, run(context, payload) {
  if (payload.changes.some(row => JSON.parse(row.json).result)) throw Object.assign(new Error('fixture completed receipt refusal'), { storageCode: 'domain-failed' });
  return mutate.run(context, payload);
} };` : ''}
runStorageThread([domain${runsRelease ? ', runsDomain' : ''}${triggersRelease ? ', triggersDomain' : ''}${includePermissions ? ', permissionsDomain' : ''}${externalDomains ? ', remoteDomain, autoPromptDomain, workflowsDomain' : ''}${threadFaultDomain ? ', fixtureDomain' : ''}]);`;
    const result = await build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'retention-fixture-thread.ts', loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', plugins: [versionPlugin], logLevel: 'silent' });
    const body = result.outputFiles[0].text, sourceHash = createHash('sha256').update(body).digest('hex');
    artifacts[fault] = { format: STORAGE_BUNDLE_FORMAT, sourceHash, source: `var __TOWER_STORAGE_SOURCE_HASH__ = "${sourceHash}";\n${body}` };
  }
  if (actualACapture) {
    const actual = JSON.parse(actualABytes!.toString('utf8')) as StorageThreadArtifact;
    if (actual.sourceHash !== actualACapture.identity.sourceHash) throw new Error('Actual A122 source identity mismatch.');
    artifacts.normal = actual;
  }
  if (triggerACapture) {
    const actual = JSON.parse(triggerABytes!.toString('utf8')) as StorageThreadArtifact;
    if (actual.sourceHash !== '5318990f15be1bbe73ba69c390c4b5ae32c7ee4ca61ba89f4d34241723936a0a' || actual.sourceHash !== triggerACapture.identity.sourceHash) throw new Error('Actual A124 source identity mismatch.');
    artifacts.normal = actual;
  }
  if(product) {
    if(version!=='1.125.0' || JSON.stringify(product.manifest)!==JSON.stringify(manifest)) throw new Error('Exact final product profile mismatch.');
    const artifact=product.artifact, first=`var __TOWER_STORAGE_SOURCE_HASH__ = "${artifact.sourceHash}";\n`;
    if(!artifact.source.startsWith(first) || createHash('sha256').update(artifact.source.slice(first.length)).digest('hex')!==artifact.sourceHash) throw new Error('Product source bytes mismatch.');
    artifacts.normal=artifact;
  }
  const parentPath = join(directory, 'parent.mjs');
  await build({ entryPoints: [join(root, 'tests/server/storage/fixtures/parent.ts')], outfile: parentPath, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', plugins: [versionPlugin, buildIdentityPlugin(buildIdentityModule({ artifact:JSON.stringify(artifacts[defaultFault]), contexts: Object.values(artifacts).map(artifact => ({ sourceHash: artifact.sourceHash, manifest })) }))] });
  const storage = await import(pathToFileURL(parentPath).href) as typeof Parent;
  const bundle = (fault = defaultFault) => {
    const captured = storage.storageBundleFromArtifact(JSON.stringify(artifacts[fault]), 'artifact');
    if (!captured.ok) throw new Error(captured.failure.message);
    return captured;
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ manifest, artifacts: Object.fromEntries(Object.entries(artifacts).map(([key, artifact]) => [key, artifact.sourceHash])) }));
  return { directory, version, manifest, storage, bundle };
}

export type LegacyRetentionStore = Pick<import('../../../../server/sessions/retention/store.js').RetentionStore,'start'|'get'|'put'|'putIfUnchanged'|'removeMetadata'|'setPolicy'|'list'|'policy'>;
export type LegacyRunHistory = Pick<import('../../../../server/runs/run-history.js').RunHistory,'readCreated'|'restore'|'flush'> & {
  save(runs:ReadonlyMap<string,import('../../../../shared/types.js').Run>,listed:readonly import('../../../../shared/types.js').Run[],created:string,retained:ReadonlySet<string>):void;
};

/** Same verified public bytes supply the full CLI, actual SDK and legacy benchmark classes. */
export async function protectedOld124() {
  const directory=process.env.TOWER_SQLITE_OLD124_ROOT;
  if(!directory || process.env.SQLITE_VALIDATION_CI!=='1') throw new Error('Full old124 fixture requires the hosted official capture, not a five-member substitute.');
  const receipt=JSON.parse(await readFile(join(directory,'receipt.json'),'utf8'));
  if(receipt.format!=='tower-full-old124-capture' || receipt.packageSHA256!=='5647224b149023ad8f5a429832c1fc6b3012e7b27c16808a1fc2af6b00ef371d'
    || receipt.archiveBytes!==5118858 || Object.keys(receipt.members).length!==714 || receipt.dependenciesEqual!==true) throw new Error('Full old artifact provenance mismatch.');
  const packageRoot=join(directory,'package');
  for(const [member,fact] of Object.entries(receipt.members) as [string,{bytes:number;sha256:string}][]) {
    if(!member || member.split('/').some(part=>!part || part==='.' || part==='..')) throw new Error('Old member boundary mismatch.');
    const bytes=await readFile(join(packageRoot,member));
    if(bytes.length!==fact.bytes || createHash('sha256').update(bytes).digest('hex')!==fact.sha256) throw new Error('Full old member readback mismatch.');
  }
  const stdout=await readFile(join(directory,'storage-contract.json'));
  if(createHash('sha256').update(stdout).digest('hex')!==receipt.contractSHA256) throw new Error('Full CLI stdout changed.');
  const contract=JSON.parse(stdout.toString('utf8'));
  const capture=JSON.parse(await readFile(fileURLToPath(new URL('./triggers-a124/capture.json',import.meta.url)),'utf8'));
  if(!contract.supported || JSON.stringify(contract.identity)!==JSON.stringify(capture.identity)) throw new Error('Full old CLI identity mismatch.');
  const storage=await import(pathToFileURL(join(packageRoot,'dist/server/storage/index.js')).href) as typeof Parent;
  const bundle=await storage.captureStorageBundle(), context=storage.storageBuildContext(bundle);
  if(!context.ok || JSON.stringify(context.identity)!==JSON.stringify(contract.identity)) throw new Error('Full old actual SDK mismatch.');
  const retention=await import(pathToFileURL(join(packageRoot,'dist/server/sessions/retention/store.js')).href) as {RetentionStore:new(root:string,options?:{storage:import('../../../../server/storage/client.js').StorageClient})=>LegacyRetentionStore};
  const runs=await import(pathToFileURL(join(packageRoot,'dist/server/runs/run-history.js')).href) as {RunHistory:new(stateDir:string)=>LegacyRunHistory};
  return {directory,packageRoot,contract,receipt,storage,bundle:()=>bundle,RetentionStore:retention.RetentionStore,RunHistory:runs.RunHistory};
}

/** Product-profile tests and benchmark share the exact built candidate SDK, including SEA source identity. */
export async function currentProductProfile() {
  const root=fileURLToPath(new URL('../../../../',import.meta.url));
  const storage=await import(pathToFileURL(join(root,'dist/server/storage/index.js')).href) as typeof Parent;
  const context=storage.storageBuildContext(await storage.captureStorageBundle());
  if(!context.ok) throw new Error('Built product SDK contract held.');
  const artifact=JSON.parse(await readFile(join(root,'dist/server/storage/generated/thread-bundle.json'),'utf8')) as StorageThreadArtifact;
  if(artifact.sourceHash!==context.identity.sourceHash) throw new Error('Built product source identity mismatch.');
  return {artifact,manifest:context.manifest};
}
